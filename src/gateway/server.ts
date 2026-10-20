import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { LoadedConfig } from "../config/config.ts";
import type { HttpTransport } from "../transport/http.ts";
import {
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
 */
export const GATEWAY_MIN_API_KEY_LENGTH = 12;
export const GATEWAY_MAX_BODY_BYTES = 64 * 1024;
export const GATEWAY_BODY_TIMEOUT_MS = 10_000;
export const GATEWAY_MAX_IN_FLIGHT = 4;

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
	/** Test-only override of the inbound body limit and read timeout. */
	maxBodyBytes?: number;
	bodyTimeoutMs?: number;
	/** Structured logger; never receives request bodies or credentials. */
	log?: (event: GatewayLogEvent) => void;
}

export interface GatewayServer {
	server: Server;
	service: GatewayService;
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

const requestTooLarge = (): GatewayHttpError =>
	new GatewayHttpError({
		status: 413,
		type: "invalid_request_error",
		code: "request_too_large",
		message: "请求体超过网关大小限制。",
	});

const requestTimeout = (): GatewayHttpError =>
	new GatewayHttpError({
		status: 408,
		type: "timeout_error",
		code: "request_timeout",
		message: "读取请求体超时。",
	});

class BodyTooLarge extends Error {}
class BodyReadTimeout extends Error {}
class BodyAborted extends Error {}

function readJsonObject(
	request: IncomingMessage,
	maxBytes: number,
	timeoutMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: unknown, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onAborted);
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > maxBytes) {
				finish(new BodyTooLarge());
				return;
			}
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
		const timer = setTimeout(
			() => finish(new BodyReadTimeout()),
			Math.max(1, timeoutMs),
		);
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
	const maxBodyBytes = options.maxBodyBytes ?? GATEWAY_MAX_BODY_BYTES;
	const bodyTimeoutMs = options.bodyTimeoutMs ?? GATEWAY_BODY_TIMEOUT_MS;
	const log =
		options.log ??
		((event: GatewayLogEvent) =>
			process.stderr.write(`${JSON.stringify(event)}\n`));
	let inFlight = 0;
	let shuttingDown = false;
	const active = new Set<ServerResponse>();

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
			const providedKey = authorizationKey(request);
			const authenticated =
				providedKey.length > 0 &&
				timingSafeEqual(digest(providedKey), expected);
			if (!authenticated) throw unauthorized();
			if (!contentTypeIsJson(request.headers["content-type"]))
				throw invalidRequest("Content-Type 必须是 application/json。");
			if (request.headers["content-encoding"] !== undefined)
				throw invalidRequest("不支持压缩请求体。");
			if (inFlight >= GATEWAY_MAX_IN_FLIGHT)
				throw new GatewayHttpError({
					status: 429,
					type: "rate_limit_error",
					code: "rate_limit_exceeded",
					message: "网关并发已满，请稍后重试。",
					retryAfterSeconds: 1,
				});
			inFlight += 1;
			try {
				const raw = await readJsonObject(request, maxBodyBytes, bodyTimeoutMs);
				const parsed =
					route === "search"
						? parseGatewaySearchRequest(raw)
						: parseGatewayFetchRequest(raw);
				const body: unknown =
					route === "search"
						? await service.search(parsed as never, clientAbort.signal)
						: await service.fetch(parsed as never, clientAbort.signal);
				if (clientAbort.signal.aborted || response.writableEnded) return;
				status = 200;
				sendJson(response, 200, body);
			} finally {
				inFlight -= 1;
			}
		} catch (error) {
			if (error instanceof GatewayClientAbort || clientAbort.signal.aborted)
				return;
			const mapped: GatewayHttpError =
				error instanceof GatewayValidationError
					? invalidRequest(error.message)
					: error instanceof BodyTooLarge
						? requestTooLarge()
						: error instanceof BodyReadTimeout
							? requestTimeout()
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
			// Body limits and timeouts close the connection after the error envelope.
			const closeConnection =
				error instanceof BodyTooLarge ||
				error instanceof BodyReadTimeout ||
				error instanceof BodyAborted;
			sendError(
				response,
				mapped,
				closeConnection ? { Connection: "close" } : {},
			);
			if (closeConnection) request.destroy();
		} finally {
			log({
				method: request.method ?? "",
				route,
				status,
				durationMs: Math.max(0, Math.round(performance.now() - started)),
				requestId,
				...(code ? { code } : {}),
			});
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
		async shutdown(timeoutMs) {
			shuttingDown = true;
			const drained = new Promise<void>((resolveDrained) => {
				const poll = () => {
					if (inFlight === 0) resolveDrained();
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
