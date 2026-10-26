import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { LoadedConfig } from "../config/config.ts";
import type { HttpTransport } from "../transport/http.ts";
import { VERSION } from "../version.ts";
import {
	createGatewayAdminController,
	type GatewayAdminController,
	parseGatewayConfigUpdateRequest,
} from "./admin.ts";
import {
	CONFIG_PATH,
	CONFIG_RELOAD_PATH,
	OVERVIEW_PATH,
	PANEL_PATH,
	RECORDS_PATH,
	renderPanelHtml,
	STATS_RESET_PATH,
} from "./panel.ts";
import {
	createGatewayRecordStore,
	createGatewayStatsTracker,
	GATEWAY_RECORD_FETCH_PREVIEW_CHARS,
	GATEWAY_RECORD_MAX_RESULTS,
	GATEWAY_RECORD_SEARCH_PREVIEW_CHARS,
	type GatewayAttemptRecord,
	type GatewayContentBackfillSummary,
	type GatewayRecordResult,
	type GatewayRequestRecord,
	truncatePreview,
} from "./records.ts";
import {
	type GatewayFetchRequest,
	type GatewayFetchResponse,
	type GatewaySearchRequest,
	type GatewaySearchResponse,
	GatewayValidationError,
	parseGatewayFetchRequest,
	parseGatewaySearchRequest,
} from "./schema.ts";
import {
	createGatewayService,
	GatewayClientAbort,
	GatewayHttpError,
	type GatewayLimits,
	type GatewayService,
} from "./service.ts";

/**
 * Minimum gateway key length. Deployments should still generate a 32-byte random
 * value (64 hex characters); this floor only rejects obviously weak keys.
 *
 * The gateway deliberately imposes no local admission or body limits: it is a
 * private single-user deployment, so concurrency, body size and body read time
 * are bounded only by the upstream providers and the process itself.
 */
export const GATEWAY_MIN_API_KEY_LENGTH = 12;

export interface GatewayLogEvent {
	method: string;
	route: string;
	status: number;
	durationMs: number;
	requestId: string;
	code?: string;
}

export interface GatewayServerOptions {
	loaded: LoadedConfig;
	apiKey: string;
	transport?: HttpTransport;
	/** Test-only overrides for the backfill/size limits and clock. */
	limits?: Partial<GatewayLimits>;
	now?: () => number;
	/** Test-only override of the in-memory request record retention. */
	recordLimit?: number;
	/** Structured logger; never receives request bodies or credentials. */
	log?: (event: GatewayLogEvent) => void;
}

export interface GatewayServer {
	server: Server;
	service: GatewayService;
	admin: GatewayAdminController;
	/** Stop accepting new work, drain in-flight requests, then close. */
	shutdown(timeoutMs: number): Promise<void>;
}

export function normalizeGatewayApiKey(raw: string): string {
	const value = raw.replace(/\r?\n$/, "");
	if (!value.trim()) throw new Error("网关 API key 为空");
	if (/\s/.test(value) || hasControlCharacters(value))
		throw new Error("网关 API key 不能包含空白或控制字符");
	if (value.length < GATEWAY_MIN_API_KEY_LENGTH)
		throw new Error(
			`网关 API key 至少需要 ${GATEWAY_MIN_API_KEY_LENGTH} 个字符`,
		);
	return value;
}

/** Read the gateway bearer key from a file; never from argv or the environment. */
export function readGatewayApiKeyFile(path: string): string {
	return normalizeGatewayApiKey(readFileSync(path, "utf8"));
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	if (response.writableEnded || response.destroyed) return;
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload, "utf8").toString(),
		...headers,
	});
	response.end(payload);
}

function sendError(
	response: ServerResponse,
	error: GatewayHttpError,
	headers: Record<string, string> = {},
): void {
	sendJson(
		response,
		error.status,
		{
			error: {
				message: error.message,
				type: error.type,
				param: null,
				code: error.code,
			},
		},
		{
			...(error.retryAfterSeconds !== undefined
				? { "Retry-After": String(error.retryAfterSeconds) }
				: {}),
			...headers,
		},
	);
}

function sendPanel(
	response: ServerResponse,
	nonce: string,
	retention: number,
): void {
	if (response.writableEnded || response.destroyed) return;
	const body = renderPanelHtml({
		nonce,
		retention,
		minKeyLength: GATEWAY_MIN_API_KEY_LENGTH,
		version: VERSION,
	});
	response.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body, "utf8").toString(),
		"Content-Security-Policy": [
			"default-src 'none'",
			`script-src 'nonce-${nonce}'`,
			`style-src 'nonce-${nonce}'`,
			"connect-src 'self'",
			"img-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		].join("; "),
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(body);
}

const invalidRequest = (message: string): GatewayHttpError =>
	new GatewayHttpError({
		status: 400,
		type: "invalid_request_error",
		code: "invalid_request_error",
		message,
	});

const unauthorized = (): GatewayHttpError =>
	new GatewayHttpError({
		status: 401,
		type: "authentication_error",
		code: "invalid_api_key",
		message: "网关 API key 缺失或无效。",
	});

const methodNotAllowed = (allowed: string): GatewayHttpError =>
	new GatewayHttpError({
		status: 405,
		type: "invalid_request_error",
		code: "method_not_allowed",
		message: `该路径只接受 ${allowed} 请求。`,
	});

const routeNotFound = (): GatewayHttpError =>
	new GatewayHttpError({
		status: 404,
		type: "invalid_request_error",
		code: "not_found",
		message: "接口不存在。",
	});

class BodyAborted extends Error {}

/**
 * Read the JSON object request body. There is intentionally no byte cap and no
 * read deadline: the body is bounded only by the client and by process memory.
 */
function readJsonObject(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (error?: unknown, value?: unknown) => {
			if (settled) return;
			settled = true;
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onAborted);
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
		};
		const onEnd = () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) {
				finish(invalidRequest("请求体不能为空。"));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				finish(invalidRequest("请求体不是合法的 JSON。"));
				return;
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				finish(invalidRequest("请求体必须是 JSON 对象。"));
				return;
			}
			finish(undefined, parsed);
		};
		const onError = () => finish(new BodyAborted());
		const onAborted = () => finish(new BodyAborted());
		request.on("data", onData);
		request.on("end", onEnd);
		request.on("error", onError);
		request.on("aborted", onAborted);
	});
}

function contentTypeIsJson(header: string | undefined): boolean {
	if (!header) return false;
	const [mediaType, ...parameters] = header.split(";");
	if (mediaType?.trim().toLowerCase() !== "application/json") return false;
	for (const parameter of parameters) {
		const name = parameter.split("=", 1)[0]?.trim().toLowerCase();
		if (name !== "charset") continue;
		const value = parameter
			.slice(parameter.indexOf("=") + 1)
			.trim()
			.replace(/^"|"$/g, "")
			.toLowerCase();
		if (value !== "utf-8" && value !== "utf8") return false;
	}
	return true;
}

/**
 * Exactly one `Authorization: Bearer <key>` value is required. Duplicate header
 * lines are visible through `headersDistinct` and are rejected without touching
 * providers; `request.headers.authorization` silently keeps the first value.
 */
function authorizationKey(request: IncomingMessage): string {
	const distinct = request.headersDistinct.authorization;
	if (distinct?.length !== 1) return "";
	const header = distinct[0];
	if (typeof header !== "string") return "";
	if (!header.startsWith("Bearer ")) return "";
	const value = header.slice("Bearer ".length);
	if (!value || value !== value.trim()) return "";
	if (hasControlCharacters(value)) return "";
	return value;
}

export function createGatewayServer(
	options: GatewayServerOptions,
): GatewayServer {
	const service = createGatewayService({
		loaded: options.loaded,
		transport: options.transport,
		now: options.now,
		limits: options.limits,
	});
	const expected = digest(options.apiKey);
	const records = createGatewayRecordStore(options.recordLimit);
	const stats = createGatewayStatsTracker();
	const admin = createGatewayAdminController({
		service,
		stats,
		retention: records.retention,
	});
	const log =
		options.log ??
		((event: GatewayLogEvent) =>
			process.stderr.write(`${JSON.stringify(event)}\n`));
	let shuttingDown = false;
	const active = new Set<ServerResponse>();

	const authenticate = (request: IncomingMessage): boolean => {
		const providedKey = authorizationKey(request);
		return (
			providedKey.length > 0 && timingSafeEqual(digest(providedKey), expected)
		);
	};

	const handle = async (
		request: IncomingMessage,
		response: ServerResponse,
		route: "search" | "fetch",
	): Promise<void> => {
		const started = performance.now();
		const rawRequestId = request.headers["x-request-id"];
		const requestId =
			typeof rawRequestId === "string" &&
			/^[A-Za-z0-9._-]{1,64}$/.test(rawRequestId)
				? rawRequestId
				: randomUUID();
		let status = 500;
		let code: string | undefined;
		let authenticated = false;
		let clientAborted = false;
		const summary: {
			query?: string;
			url?: string;
			count?: number;
			needContent?: boolean;
			provider?: string;
			title?: string;
			resultCount?: number;
			results?: GatewayRecordResult[];
			contentPreview?: string;
			contentChars?: number;
			contentTruncated?: boolean;
			attempts?: GatewayAttemptRecord[];
			contentBackfill?: GatewayContentBackfillSummary;
		} = {};
		const clientAbort = new AbortController();
		response.once("close", () => {
			if (!response.writableEnded) clientAbort.abort();
		});
		try {
			if (shuttingDown)
				throw new GatewayHttpError({
					status: 503,
					type: "server_error",
					code: "shutting_down",
					message: "网关正在停止。",
				});
			if (!authenticate(request)) throw unauthorized();
			authenticated = true;
			if (!contentTypeIsJson(request.headers["content-type"]))
				throw invalidRequest("Content-Type 必须是 application/json。");
			if (request.headers["content-encoding"] !== undefined)
				throw invalidRequest("不支持压缩请求体。");
			const raw = await readJsonObject(request);
			const parsed =
				route === "search"
					? parseGatewaySearchRequest(raw)
					: parseGatewayFetchRequest(raw);
			if (route === "search") {
				const search = parsed as GatewaySearchRequest;
				summary.query = search.query;
				summary.count = search.count;
				summary.needContent = search.need_content ?? false;
			} else {
				summary.url = (parsed as GatewayFetchRequest).url;
			}
			const observer = {
				onSuccess: (info: {
					provider: string;
					trace: {
						attempts: GatewayAttemptRecord[];
						contentBackfill?: GatewayContentBackfillSummary;
					};
				}) => {
					summary.provider = info.provider;
					if (info.trace.attempts.length > 0) {
						summary.attempts = info.trace.attempts;
					}
					if (info.trace.contentBackfill) {
						summary.contentBackfill = info.trace.contentBackfill;
					}
				},
			};
			const body: unknown =
				route === "search"
					? await service.search(parsed as never, clientAbort.signal, observer)
					: await service.fetch(parsed as never, clientAbort.signal, observer);
			if (clientAbort.signal.aborted || response.writableEnded) {
				clientAborted = true;
				return;
			}
			if (route === "search") {
				const searchBody = body as GatewaySearchResponse;
				summary.resultCount = searchBody.results.length;
				summary.results = searchBody.results
					.slice(0, GATEWAY_RECORD_MAX_RESULTS)
					.map((result, idx) => {
						const preview = truncatePreview(
							result.content,
							GATEWAY_RECORD_SEARCH_PREVIEW_CHARS,
						);
						return {
							rank: idx + 1,
							title: result.title,
							url: result.url,
							...(result.snippet ? { snippet: result.snippet } : {}),
							...(preview
								? {
										contentPreview: preview.preview,
										contentChars: preview.chars,
										contentTruncated: preview.truncated,
									}
								: {}),
						};
					});
			} else {
				const fetchBody = body as GatewayFetchResponse;
				summary.title = fetchBody.title;
				const preview = truncatePreview(
					fetchBody.content,
					GATEWAY_RECORD_FETCH_PREVIEW_CHARS,
				);
				if (preview !== undefined) {
					summary.contentPreview = preview.preview;
					summary.contentChars = preview.chars;
					summary.contentTruncated = preview.truncated;
				}
			}
			status = 200;
			sendJson(response, 200, body);
		} catch (error) {
			if (error instanceof GatewayClientAbort || clientAbort.signal.aborted) {
				clientAborted = true;
				return;
			}
			const mapped: GatewayHttpError =
				error instanceof GatewayValidationError
					? invalidRequest(error.message)
					: error instanceof BodyAborted
						? invalidRequest("请求读取中断。")
						: error instanceof GatewayHttpError
							? error
							: new GatewayHttpError({
									status: 500,
									type: "server_error",
									code: "internal_error",
									message: "网关内部错误。",
								});
			status = mapped.status;
			code = mapped.code;
			summary.provider = summary.provider ?? mapped.provider;
			if (mapped.trace) {
				if (!summary.attempts && mapped.trace.attempts.length > 0) {
					summary.attempts = mapped.trace.attempts;
				}
				if (!summary.contentBackfill && mapped.trace.contentBackfill) {
					summary.contentBackfill = mapped.trace.contentBackfill;
				}
			}
			// A body read failure leaves the socket unusable for a follow-up request.
			const closeConnection = error instanceof BodyAborted;
			sendError(
				response,
				mapped,
				closeConnection ? { Connection: "close" } : {},
			);
			if (closeConnection) request.destroy();
		} finally {
			const durationMs = Math.max(0, Math.round(performance.now() - started));
			log({
				method: request.method ?? "",
				route,
				status,
				durationMs,
				requestId,
				...(code ? { code } : {}),
			});
			// The panel is an observability surface, not another log sink: only
			// authenticated tool requests are retained, so unauthenticated probes
			// cannot flush the ring buffer and failed keys stay in stderr logs.
			if (authenticated && !clientAborted) {
				const now = Date.now();
				const record: GatewayRequestRecord = {
					id: requestId,
					at: now,
					route,
					status,
					durationMs,
					...(code ? { code } : {}),
					...summary,
				};
				records.add(record);
				stats.recordRequest({
					at: now,
					route,
					ok: status >= 200 && status < 300,
					attempts: record.attempts,
					contentBackfill: record.contentBackfill,
				});
			}
		}
	};

	const handleAdminConfigUpdate = async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		try {
			if (shuttingDown) {
				throw new GatewayHttpError({
					status: 503,
					type: "server_error",
					code: "shutting_down",
					message: "网关正在停止。",
				});
			}
			if (!authenticate(request)) throw unauthorized();
			if (!contentTypeIsJson(request.headers["content-type"])) {
				throw invalidRequest("Content-Type 必须是 application/json。");
			}
			if (request.headers["content-encoding"] !== undefined) {
				throw invalidRequest("不支持压缩请求体。");
			}
			const raw = await readJsonObject(request);
			const patch = parseGatewayConfigUpdateRequest(raw);
			const result = await admin.updateConfig(patch);
			sendJson(response, 200, result);
		} catch (error) {
			const mapped: GatewayHttpError =
				error instanceof GatewayValidationError
					? invalidRequest(error.message)
					: error instanceof BodyAborted
						? invalidRequest("请求读取中断。")
						: error instanceof GatewayHttpError
							? error
							: new GatewayHttpError({
									status: 500,
									type: "server_error",
									code: "internal_error",
									message: "网关内部错误。",
								});
			const closeConnection = error instanceof BodyAborted;
			sendError(
				response,
				mapped,
				closeConnection ? { Connection: "close" } : {},
			);
			if (closeConnection) request.destroy();
		}
	};

	const handleAdminConfigReload = async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		try {
			if (shuttingDown) {
				throw new GatewayHttpError({
					status: 503,
					type: "server_error",
					code: "shutting_down",
					message: "网关正在停止。",
				});
			}
			if (!authenticate(request)) throw unauthorized();
			const result = await admin.reloadConfig();
			sendJson(response, 200, result);
		} catch (error) {
			const mapped: GatewayHttpError =
				error instanceof GatewayValidationError
					? invalidRequest(error.message)
					: error instanceof GatewayHttpError
						? error
						: new GatewayHttpError({
								status: 500,
								type: "server_error",
								code: "internal_error",
								message: "网关内部错误。",
							});
			sendError(response, mapped);
		}
	};

	const server = createServer((request, response) => {
		active.add(response);
		response.once("close", () => active.delete(response));
		const url = request.url ?? "/";
		const path = url.split("?", 1)[0] ?? "/";
		if (path === "/healthz" || path === "/readyz") {
			if (request.method !== "GET") {
				sendError(response, methodNotAllowed("GET"), { Allow: "GET" });
				return;
			}
			if (path === "/healthz") {
				sendJson(response, 200, { status: "ok" });
				return;
			}
			if (shuttingDown) {
				sendJson(response, 503, { status: "shutting_down" });
				return;
			}
			const readiness = service.readiness();
			sendJson(
				response,
				readiness.ready ? 200 : 503,
				readiness.ready
					? { status: "ready" }
					: { status: "not_ready", reason: readiness.reason },
			);
			return;
		}
		if (path === "/" || path === PANEL_PATH) {
			if (request.method !== "GET") {
				sendError(response, methodNotAllowed("GET"), { Allow: "GET" });
				return;
			}
			sendPanel(
				response,
				randomBytes(16).toString("base64url"),
				records.retention,
			);
			return;
		}
		if (path === OVERVIEW_PATH) {
			if (request.method !== "GET") {
				sendError(response, methodNotAllowed("GET"), { Allow: "GET" });
				return;
			}
			if (!authenticate(request)) {
				sendError(response, unauthorized());
				return;
			}
			sendJson(response, 200, admin.getOverview());
			return;
		}
		if (path === RECORDS_PATH) {
			if (request.method !== "GET" && request.method !== "DELETE") {
				sendError(response, methodNotAllowed("GET, DELETE"), {
					Allow: "GET, DELETE",
				});
				return;
			}
			if (!authenticate(request)) {
				sendError(response, unauthorized());
				return;
			}
			if (request.method === "DELETE") {
				const cleared = records.clear();
				sendJson(response, 200, {
					cleared,
					retention: records.retention,
					generatedAt: Date.now(),
				});
				return;
			}
			const queryIndex = url.indexOf("?");
			const params = new URLSearchParams(
				queryIndex === -1 ? "" : url.slice(queryIndex + 1),
			);
			const rawLimit = params.get("limit");
			let limit = records.retention;
			if (rawLimit !== null) {
				if (
					!/^[1-9]\d{0,3}$/.test(rawLimit) ||
					Number(rawLimit) > records.retention
				) {
					sendError(
						response,
						invalidRequest(`limit 必须是 1–${records.retention} 的整数。`),
					);
					return;
				}
				limit = Number(rawLimit);
			}
			const rawRoute = params.get("route");
			if (
				rawRoute !== null &&
				rawRoute !== "" &&
				rawRoute !== "search" &&
				rawRoute !== "fetch"
			) {
				sendError(response, invalidRequest("route 必须是 search 或 fetch。"));
				return;
			}
			const rawStatus = params.get("status");
			if (
				rawStatus !== null &&
				rawStatus !== "" &&
				rawStatus !== "ok" &&
				rawStatus !== "error"
			) {
				sendError(response, invalidRequest("status 必须是 ok 或 error。"));
				return;
			}
			const rawProvider = params.get("provider") ?? undefined;
			const rawQuery = params.get("q") ?? undefined;
			const list = records.list({
				limit,
				...(rawRoute === "search" || rawRoute === "fetch"
					? { route: rawRoute }
					: {}),
				...(rawStatus === "ok" || rawStatus === "error"
					? { status: rawStatus }
					: {}),
				...(rawProvider ? { provider: rawProvider } : {}),
				...(rawQuery ? { q: rawQuery } : {}),
			});
			sendJson(response, 200, {
				records: list,
				count: list.length,
				retention: records.retention,
				generatedAt: Date.now(),
			});
			return;
		}
		if (path === STATS_RESET_PATH) {
			if (request.method !== "POST") {
				sendError(response, methodNotAllowed("POST"), { Allow: "POST" });
				return;
			}
			if (!authenticate(request)) {
				sendError(response, unauthorized());
				return;
			}
			stats.reset();
			sendJson(response, 200, {
				reset: true,
				stats: stats.snapshot(),
				generatedAt: Date.now(),
			});
			return;
		}
		if (path === CONFIG_PATH) {
			if (request.method !== "PUT") {
				sendError(response, methodNotAllowed("PUT"), { Allow: "PUT" });
				return;
			}
			void handleAdminConfigUpdate(request, response);
			return;
		}
		if (path === CONFIG_RELOAD_PATH) {
			if (request.method !== "POST") {
				sendError(response, methodNotAllowed("POST"), { Allow: "POST" });
				return;
			}
			void handleAdminConfigReload(request, response);
			return;
		}
		if (path === "/v1/tools/search" || path === "/v1/tools/fetch") {
			if (request.method !== "POST") {
				sendError(response, methodNotAllowed("POST"), { Allow: "POST" });
				return;
			}
			void handle(
				request,
				response,
				path === "/v1/tools/search" ? "search" : "fetch",
			);
			return;
		}
		sendError(response, routeNotFound());
	});

	return {
		server,
		service,
		admin,
		async shutdown(timeoutMs) {
			shuttingDown = true;
			const drained = new Promise<void>((resolveDrained) => {
				const poll = () => {
					if (active.size === 0) resolveDrained();
					else setTimeout(poll, 20).unref();
				};
				poll();
			});
			let timer: NodeJS.Timeout | undefined;
			const expired = new Promise<void>((resolveExpired) => {
				timer = setTimeout(resolveExpired, Math.max(0, timeoutMs));
			});
			await Promise.race([drained, expired]);
			if (timer) clearTimeout(timer);
			for (const response of active) response.destroy();
			await new Promise<void>((resolveClosed) =>
				server.close(() => resolveClosed()),
			);
		},
	};
}
