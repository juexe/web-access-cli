import { redactText, WebAccessError } from "../core/errors.ts";
import type {
	ProviderAdapter,
	ProviderExecution,
	SearchAdapterRequest,
	SearchData,
} from "../core/types.ts";
import { buildEndpoint, type HttpResponse } from "../transport/http.ts";
import {
	normalizeHits,
	parseJsonResponse,
	ref,
	requireBaseUrl,
	requireCredential,
} from "./common.ts";

/** Site 参数最多过滤五个域名；超过时仅依赖本地过滤。 */
const MAX_EXCLUDE_DOMAINS = 5;

/** 元宝只接受 10/20/30/40/50；极速版不支持 Cnt，因此缺省时不发送。 */
const MAX_COUNT = 50;
const DEFAULT_PAGE_SIZE = 10;

const FRESHNESS_PARAMS = { day: "d1", month: "m1", year: "y1" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeRaw(value: unknown, secret: string): unknown {
	if (!secret) return value;
	if (typeof value === "string") return redactText(value, [secret]);
	if (Array.isArray(value))
		return value.map((item) => sanitizeRaw(item, secret));
	if (isRecord(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				sanitizeRaw(item, secret),
			]),
		);
	return value;
}

/** 元宝搜索的 Site 参数：单一指定域名，或最多五个排除域名。 */
function siteFilter(request: SearchAdapterRequest): string | undefined {
	if (
		request.includeDomains.length === 1 &&
		request.excludeDomains.length === 0
	)
		return request.includeDomains[0];
	if (
		request.includeDomains.length === 0 &&
		request.excludeDomains.length > 0 &&
		request.excludeDomains.length <= MAX_EXCLUDE_DOMAINS
	)
		return `exclude:${request.excludeDomains.join("|")}`;
	return undefined;
}

/** 只有需要超过默认 10 条时才发送 Cnt，让极速版继续可用。 */
function pageSize(limit: number): number | undefined {
	if (limit <= DEFAULT_PAGE_SIZE) return undefined;
	return Math.min(
		Math.ceil(limit / DEFAULT_PAGE_SIZE) * DEFAULT_PAGE_SIZE,
		MAX_COUNT,
	);
}

function requestBody(request: SearchAdapterRequest): string {
	const site = siteFilter(request);
	const count = pageSize(request.limit);
	return JSON.stringify({
		Query: request.query,
		...(count ? { Cnt: count } : {}),
		...(site ? { Site: site } : {}),
		...(request.freshness
			? { Freshness: FRESHNESS_PARAMS[request.freshness] }
			: {}),
	});
}

function failureCode(
	code: string,
): "auth_error" | "quota_exceeded" | "rate_limited" | "provider_error" {
	if (code === "UnauthorizedOperation" || code === "AuthFailure")
		return "auth_error";
	if (code === "ResourceNotFound" || code === "ResourceUnavailable")
		return "quota_exceeded";
	if (code === "RequestLimitExceeded") return "rate_limited";
	return "provider_error";
}

function errorMessage(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 500);
	if (isRecord(value)) {
		const message =
			stringField(value.Message) ??
			stringField(value.message) ??
			stringField(value.Error);
		if (message) return message.slice(0, 500);
	}
	return "上游返回错误";
}

/** 错误码从 Response.Error 读取；HTTP 层不改变业务错误分类。 */
function errorCode(error: Record<string, unknown>): string | undefined {
	return stringField(error.Code) ?? stringField(error.code);
}

function errorPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const error = payload.Error ?? payload.error;
	return isRecord(error) ? error : undefined;
}

/**
 * 业务错误常以 HTTP 200 携带 Error 返回。标记为可回退，否则 auto 会因为
 * 单个 Provider 未开通、欠费或限流而放弃整条 Route。
 */
function businessFailure(
	code: string,
	payload: Record<string, unknown>,
	request: SearchAdapterRequest,
): never {
	throw new WebAccessError(
		failureCode(code),
		`${request.instance.id} 返回错误 ${code}: ${redactText(errorMessage(payload), [request.instance.apiKey ?? ""])}`,
		{
			provider: ref(request.instance),
			retryable: true,
			raw: sanitizeRaw(payload, request.instance.apiKey ?? ""),
		},
	);
}

function parseErrorBody(response: HttpResponse): unknown {
	try {
		const value: unknown = JSON.parse(response.body);
		if (!isRecord(value)) return value;
		return isRecord(value.Response) ? value.Response : value;
	} catch {
		return response.body;
	}
}

function assertHttp(
	response: HttpResponse,
	request: SearchAdapterRequest,
): void {
	if (response.status >= 200 && response.status < 300) return;
	const raw = parseErrorBody(response);
	const parsed = isRecord(raw) ? raw : {};
	const error = errorPayload(parsed);
	const code = (error && errorCode(error)) ?? `HTTP ${response.status}`;
	const message = redactText(errorMessage(error ?? raw), [
		request.instance.apiKey ?? "",
	]);
	throw new WebAccessError(
		failureCode(code),
		`${request.instance.id} 返回 ${code}${message ? `: ${message}` : ""}`,
		{
			provider: ref(request.instance),
			httpStatus: response.status,
			retryable:
				failureCode(code) !== "auth_error" &&
				(response.status === 429 || response.status >= 500),
			raw: sanitizeRaw(raw, request.instance.apiKey ?? ""),
		},
	);
}

/** 标准摘要 passage 优先于动态摘要 content，与元宝的字段语义一致。 */
function pageRecord(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const summary =
		stringField(value.passage) ??
		stringField(value.content) ??
		stringField(value.snippet);
	return {
		title: value.title,
		url: value.url,
		snippet: summary ?? "",
	};
}

/** Pages 是 JSON 字符串数组；单条损坏时保留其余结果。 */
function pageItems(
	payload: Record<string, unknown>,
	request: SearchAdapterRequest,
): unknown[] {
	const pages = payload.Pages ?? payload.pages;
	if (pages === undefined || pages === null) return [];
	if (!Array.isArray(pages))
		throw new WebAccessError("invalid_response", "元宝搜索返回无效 Pages", {
			provider: ref(request.instance),
			retryable: true,
			raw: sanitizeRaw(payload, request.instance.apiKey ?? ""),
		});
	const items: unknown[] = [];
	let malformed = 0;
	for (const page of pages) {
		if (typeof page !== "string") {
			items.push(page);
			continue;
		}
		try {
			items.push(pageRecord(JSON.parse(page)));
		} catch {
			// 单条坏数据不应丢弃其余结果，但全部不可用必须暴露为无效响应。
			malformed += 1;
		}
	}
	if (malformed > 0 && items.length === 0)
		throw new WebAccessError(
			"invalid_response",
			"元宝搜索返回的 Pages 条目均不是合法 JSON 字符串",
			{
				provider: ref(request.instance),
				retryable: true,
				raw: sanitizeRaw(payload, request.instance.apiKey ?? ""),
			},
		);
	return items;
}

const PROTECTED_HEADERS = new Set(["authorization", "content-type", "accept"]);

/** 鉴权 header 由 adapter 固定，避免配置中的大小写变体覆盖真实凭据。 */
function requestHeaders(
	request: SearchAdapterRequest,
	key: string,
): Record<string, string> {
	const configured = Object.fromEntries(
		Object.entries(request.instance.headers).filter(
			([name]) => !PROTECTED_HEADERS.has(name.toLowerCase()),
		),
	);
	return {
		...configured,
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		Accept: "application/json",
	};
}

const yuanbao: ProviderAdapter = {
	type: "yuanbao",
	capabilities: ["search"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		const key = requireCredential(request.instance);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "SearchPro"),
			{
				method: "POST",
				headers: requestHeaders(request, key),
				body: requestBody(request),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertHttp(response, request);
		const parsed = parseJsonResponse(response, request.instance);
		const payload = isRecord(parsed.Response) ? parsed.Response : parsed;
		const error = errorPayload(payload);
		if (error)
			businessFailure(errorCode(error) ?? "UnknownError", payload, request);
		return {
			data: {
				results: normalizeHits(
					pageItems(payload, request),
					request.limit,
					request.includeDomains,
					request.excludeDomains,
				),
			},
			raw: sanitizeRaw(parsed, key),
		};
	},
};

export const YUANBAO_ADAPTER = yuanbao;
