import type { LoadedConfig } from "../config/config.ts";
import {
	type ExtractPreflightOverride,
	executeExtract,
	executeSearch,
} from "../core/router.ts";
import type {
	CapabilityAttemptSummary,
	ErrorCode,
	OutputEnvelope,
	SearchHit,
} from "../core/types.ts";
import { getAdapter } from "../providers/registry.ts";
import type { HttpTransport } from "../transport/http.ts";
import type {
	GatewayFetchRequest,
	GatewayFetchResponse,
	GatewaySearchRequest,
	GatewaySearchResponse,
	GatewaySearchResult,
} from "./schema.ts";

export const GATEWAY_DEFAULT_LIMITS: GatewayLimits = {
	/** Total wall-clock budget for filling `content` on a search response. */
	contentBudgetMs: 30_000,
	/** Per-result extraction deadline. */
	contentItemTimeoutMs: 10_000,
	/** Per-provider attempt cap during backfill, so fallback still gets a turn. */
	contentAttemptTimeoutMs: 3_000,
	/** Source Markdown probe cap during backfill and Fetch. */
	contentPreflightTimeoutMs: 1_000,
	/** Minimum probe body size; short soft-404 pages must not win. */
	contentPreflightMinCharacters: 500,
	/** JSON-encoded UTF-8 size cap for one backfilled `content` value. */
	contentMaxBytes: 256 * 1024,
	/** JSON-encoded UTF-8 size cap for a complete success response. */
	responseMaxBytes: 8 * 1024 * 1024,
};

export interface GatewayLimits {
	contentBudgetMs: number;
	contentItemTimeoutMs: number;
	contentAttemptTimeoutMs: number;
	contentPreflightTimeoutMs: number;
	contentPreflightMinCharacters: number;
	contentMaxBytes: number;
	responseMaxBytes: number;
}

export interface GatewayServiceOptions {
	loaded: LoadedConfig;
	transport?: HttpTransport;
	now?: () => number;
	/** Test-only overrides; not exposed through HTTP or configuration. */
	limits?: Partial<GatewayLimits>;
}

export interface GatewayReadiness {
	ready: boolean;
	reason?: string;
}

export interface GatewayService {
	search(
		request: GatewaySearchRequest,
		signal: AbortSignal,
	): Promise<GatewaySearchResponse>;
	fetch(
		request: GatewayFetchRequest,
		signal: AbortSignal,
	): Promise<GatewayFetchResponse>;
	readiness(): GatewayReadiness;
}

/** An error that maps onto the official `{error:{message,type,param,code}}`. */
export class GatewayHttpError extends Error {
	readonly status: number;
	readonly type: string;
	readonly code: string;
	readonly retryAfterSeconds?: number;

	constructor(options: {
		status: number;
		type: string;
		code: string;
		message: string;
		retryAfterSeconds?: number;
	}) {
		super(options.message);
		this.name = "GatewayHttpError";
		this.status = options.status;
		this.type = options.type;
		this.code = options.code;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}

/** The client went away; no response should be written. */
export class GatewayClientAbort extends Error {
	constructor() {
		super("客户端已断开");
		this.name = "GatewayClientAbort";
	}
}

const ERROR_MESSAGES: Record<string, string> = {
	insufficient_quota: "上游 provider 额度不足。",
	rate_limit_exceeded: "请求过于频繁，请稍后重试。",
	upstream_timeout: "下游请求超时。",
	no_usable_content: "未能获取可用的网页正文。",
	provider_auth_error: "上游 provider 凭据无效。",
	provider_config_error: "上游 provider 配置无效。",
	no_provider_available: "没有可用的 provider。",
	response_too_large: "响应超过网关大小限制。",
	provider_error: "上游 provider 请求失败。",
};

function serverError(code: string, message?: string): GatewayHttpError {
	return new GatewayHttpError({
		status: 500,
		type: "server_error",
		code,
		message: message ?? ERROR_MESSAGES[code] ?? "网关内部错误。",
	});
}

function quotaError(): GatewayHttpError {
	return new GatewayHttpError({
		status: 402,
		type: "insufficient_quota",
		code: "insufficient_quota",
		message: ERROR_MESSAGES.insufficient_quota as string,
	});
}

function rateLimitError(): GatewayHttpError {
	return new GatewayHttpError({
		status: 429,
		type: "rate_limit_error",
		code: "rate_limit_exceeded",
		message: ERROR_MESSAGES.rate_limit_exceeded as string,
		retryAfterSeconds: 1,
	});
}

function timeoutError(): GatewayHttpError {
	return new GatewayHttpError({
		status: 504,
		type: "timeout_error",
		code: "upstream_timeout",
		message: ERROR_MESSAGES.upstream_timeout as string,
	});
}

function notFoundError(): GatewayHttpError {
	return new GatewayHttpError({
		status: 404,
		type: "not_found_error",
		code: "no_usable_content",
		message: ERROR_MESSAGES.no_usable_content as string,
	});
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function deriveExtractConfig(
	loaded: LoadedConfig,
	limits: GatewayLimits,
): LoadedConfig {
	const original = loaded.app.extract;
	return {
		...loaded,
		app: {
			...loaded.app,
			extract: {
				...original,
				minContentCharacters: 1,
				attemptTimeoutMs: Math.min(
					original.attemptTimeoutMs,
					limits.contentAttemptTimeoutMs,
				),
			},
		},
	};
}

function preflightOverride(
	loaded: LoadedConfig,
	limits: GatewayLimits,
): ExtractPreflightOverride {
	return {
		timeoutMs: limits.contentPreflightTimeoutMs,
		minContentCharacters: Math.max(
			limits.contentPreflightMinCharacters,
			loaded.app.extract.minContentCharacters,
		),
	};
}

function checkReadiness(loaded: LoadedConfig): GatewayReadiness {
	const byId = new Map(
		loaded.instances.map((instance) => [instance.id, instance]),
	);
	for (const capability of ["search", "extract"] as const) {
		const route =
			capability === "search"
				? [
						...loaded.app.search.providers,
						...loaded.app.search.providers_fallback,
					]
				: [
						...loaded.app.extract.providers,
						...loaded.app.extract.providers_fallback,
					];
		const configured = route.some((id) => {
			const instance = byId.get(id);
			if (!instance) return false;
			const adapter = getAdapter(instance.type, capability);
			return !!adapter?.isConfigured(instance);
		});
		if (!configured)
			return { ready: false, reason: `${capability}_route_unconfigured` };
	}
	return { ready: true };
}

interface ClassifiedFailure {
	code: ErrorCode;
	httpStatus?: number;
}

function classifyFailure(
	loaded: LoadedConfig,
	failure: { code: ErrorCode; attempts?: CapabilityAttemptSummary[] },
	capability: "search" | "extract",
): GatewayHttpError {
	const attempts = failure.attempts ?? [];
	let chosen: CapabilityAttemptSummary | undefined;
	for (let index = attempts.length - 1; index >= 0; index--) {
		const attempt = attempts[index];
		if (!attempt || attempt.code === "provider_unavailable") continue;
		chosen = attempt;
		break;
	}
	const instance = chosen
		? loaded.instances.find((candidate) => candidate.id === chosen.provider)
		: undefined;
	const directHttp = instance?.type === "http";
	const classified: ClassifiedFailure = chosen
		? { code: chosen.code, httpStatus: chosen.httpStatus }
		: { code: failure.code };
	const { code, httpStatus } = classified;

	if (code === "quota_exceeded" || httpStatus === 402) return quotaError();
	if (code === "rate_limited" || httpStatus === 429 || httpStatus === 425)
		return rateLimitError();
	if (
		code === "timeout" ||
		code === "aborted" ||
		httpStatus === 408 ||
		httpStatus === 504
	)
		return timeoutError();
	if (directHttp) {
		// Direct target failures are page-level unavailability, never gateway auth.
		return notFoundError();
	}
	if (
		code === "no_usable_content" ||
		code === "unsupported_content" ||
		code === "response_too_large"
	)
		return notFoundError();
	if (code === "auth_error") return serverError("provider_auth_error");
	if (code === "config_error" || code === "invalid_input")
		return serverError("provider_config_error");
	// A cloud extract provider reporting a page-level 4xx means there is no
	// usable document for the target, not a gateway or credential failure.
	if (
		capability === "extract" &&
		httpStatus !== undefined &&
		httpStatus >= 400 &&
		httpStatus < 500
	)
		return notFoundError();
	if (
		code === "provider_unavailable" ||
		code === "provider_exhausted" ||
		code === "provider_unknown" ||
		code === "provider_disabled"
	)
		return serverError("no_provider_available");
	if (code === "network_error" || code === "provider_error")
		return serverError("provider_error");
	return serverError("provider_error");
}

function successData<T extends object>(
	envelope: OutputEnvelope,
): T | undefined {
	if (!envelope.ok || !("data" in envelope)) return undefined;
	return envelope.data as T;
}

function failureOf(envelope: OutputEnvelope): {
	code: ErrorCode;
	attempts?: CapabilityAttemptSummary[];
} {
	if (envelope.ok) return { code: "provider_error" };
	return {
		code: envelope.error.code as ErrorCode,
		attempts:
			"attempts" in envelope
				? (envelope.attempts as CapabilityAttemptSummary[] | undefined)
				: undefined,
	};
}

function mapHit(hit: SearchHit): GatewaySearchResult {
	return {
		rerank_score: 0,
		title: hit.title,
		url: hit.url,
		snippet: hit.snippet,
		summary: hit.snippet,
		content: "",
		site_name: null,
		site_icon: null,
		date: null,
		authority: -1,
	};
}

export function createGatewayService(
	options: GatewayServiceOptions,
): GatewayService {
	const loaded = options.loaded;
	const transport = options.transport;
	const now = options.now ?? (() => performance.now());
	const limits: GatewayLimits = {
		...GATEWAY_DEFAULT_LIMITS,
		...(options.limits ?? {}),
	};
	const extractLoaded = deriveExtractConfig(loaded, limits);
	const preflight = preflightOverride(loaded, limits);
	const readiness = checkReadiness(loaded);

	function fail(
		envelope: OutputEnvelope,
		capability: "search" | "extract",
	): never {
		throw classifyFailure(loaded, failureOf(envelope), capability);
	}

	async function readContent(
		hits: SearchHit[],
		clientSignal: AbortSignal,
		deadline: number,
		signal: AbortSignal,
	): Promise<string[]> {
		const contents = new Array<string>(hits.length).fill("");
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (!signal.aborted) {
				const index = nextIndex++;
				const hit = hits[index];
				if (!hit) return;
				const remaining = deadline - now();
				if (remaining <= 0) return;
				const itemTimeoutMs = Math.min(limits.contentItemTimeoutMs, remaining);
				const itemTimeout = new AbortController();
				const timer = setTimeout(
					() => itemTimeout.abort(),
					Math.max(1, itemTimeoutMs),
				);
				try {
					const envelope = await executeExtract(
						{ url: hit.url, provider: "auto", timeoutMs: itemTimeoutMs },
						{
							loaded: extractLoaded,
							transport,
							now,
							signal: AbortSignal.any([signal, itemTimeout.signal]),
							extractPreflight: preflight,
						},
					);
					// A late success that races the item deadline, the backfill budget
					// or cancellation must not be written back; the core success path
					// does not re-check cancellation after an await.
					const document = successData<{
						document: { content: string };
					}>(envelope)?.document;
					if (
						signal.aborted ||
						itemTimeout.signal.aborted ||
						clientSignal.aborted ||
						now() >= deadline ||
						!document
					)
						continue;
					const content = document.content;
					if (jsonBytes(content) <= limits.contentMaxBytes)
						contents[index] = content;
				} catch {
					// Best-effort backfill: failures leave the content empty.
				} finally {
					clearTimeout(timer);
				}
			}
		};
		await Promise.all([worker(), worker()]);
		return contents;
	}

	function enforceSearchSize(results: GatewaySearchResult[]): void {
		if (jsonBytes({ results }) <= limits.responseMaxBytes) return;
		for (let index = results.length - 1; index >= 0; index--) {
			const result = results[index];
			if (!result || result.content === "") continue;
			result.content = "";
			if (jsonBytes({ results }) <= limits.responseMaxBytes) return;
		}
		throw serverError(
			"response_too_large",
			"响应在清空补抓正文后仍超过网关大小限制。",
		);
	}

	return {
		readiness: () => readiness,

		async search(request, clientSignal) {
			if (clientSignal.aborted) throw new GatewayClientAbort();
			const stageTimeoutMs = loaded.app.search.timeoutMs;
			const deadline = now() + stageTimeoutMs;
			const stageTimeout = new AbortController();
			const stageTimer = setTimeout(
				() => stageTimeout.abort(),
				Math.max(1, stageTimeoutMs),
			);
			let envelope: OutputEnvelope;
			try {
				envelope = await executeSearch(
					{
						query: request.query,
						provider: "auto",
						limit: request.count,
						includeDomains: [],
						excludeDomains: [],
					},
					{
						loaded,
						transport,
						now,
						signal: AbortSignal.any([clientSignal, stageTimeout.signal]),
					},
				);
			} finally {
				clearTimeout(stageTimer);
			}
			if (clientSignal.aborted) throw new GatewayClientAbort();
			if (stageTimeout.signal.aborted || now() >= deadline)
				throw timeoutError();
			const data = successData<{ results: SearchHit[] }>(envelope);
			if (!data) fail(envelope, "search");
			const hits = data.results;
			const results = hits.map(mapHit);
			if (!request.need_content || results.length === 0) {
				// Size limits apply to every response, including content-free ones.
				enforceSearchSize(results);
				return { results };
			}
			if (clientSignal.aborted) throw new GatewayClientAbort();
			const backfillDeadline = now() + limits.contentBudgetMs;
			const backfillTimeout = new AbortController();
			const backfillTimer = setTimeout(
				() => backfillTimeout.abort(),
				Math.max(1, limits.contentBudgetMs),
			);
			let contents: string[];
			try {
				contents = await readContent(
					hits,
					clientSignal,
					backfillDeadline,
					AbortSignal.any([clientSignal, backfillTimeout.signal]),
				);
			} finally {
				clearTimeout(backfillTimer);
			}
			if (clientSignal.aborted) throw new GatewayClientAbort();
			// The search deadline is intentionally not a parent of the backfill
			// budget; it must not expire the independent backfill window.
			for (const [index, result] of results.entries())
				result.content = contents[index] ?? "";
			enforceSearchSize(results);
			return { results };
		},

		async fetch(request, clientSignal) {
			if (clientSignal.aborted) throw new GatewayClientAbort();
			const stageTimeoutMs = loaded.app.extract.timeoutMs;
			const deadline = now() + stageTimeoutMs;
			const stageTimeout = new AbortController();
			const stageTimer = setTimeout(
				() => stageTimeout.abort(),
				Math.max(1, stageTimeoutMs),
			);
			let envelope: OutputEnvelope;
			try {
				envelope = await executeExtract(
					{ url: request.url, provider: "auto" },
					{
						loaded: extractLoaded,
						transport,
						now,
						signal: AbortSignal.any([clientSignal, stageTimeout.signal]),
						extractPreflight: preflight,
					},
				);
			} finally {
				clearTimeout(stageTimer);
			}
			if (clientSignal.aborted) throw new GatewayClientAbort();
			if (stageTimeout.signal.aborted || now() >= deadline)
				throw timeoutError();
			const document = successData<{
				document: { title: string; content: string };
			}>(envelope)?.document;
			if (!document) fail(envelope, "extract");
			const response: GatewayFetchResponse = {
				title: document.title ?? "",
				content: document.content,
			};
			if (jsonBytes(response) > limits.responseMaxBytes)
				throw serverError("response_too_large", "Fetch 响应超过网关大小限制。");
			return response;
		},
	};
}
