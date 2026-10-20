import { redactText, WebAccessError } from "../core/errors.ts";
import type {
	ExtractAdapterRequest,
	ExtractData,
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
	searchQueryWithDomains,
} from "./common.ts";

/** Search 的 `count` 上限；CLI limit 上限更低，这里只做协议保护。 */
const MAX_COUNT = 50;
/** Search 官方限制：query 为 1～128 个 Unicode 字符。 */
const MAX_QUERY_CHARACTERS = 128;

const PROTECTED_HEADERS = new Set(["authorization", "content-type", "accept"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterCount(value: string): number {
	return [...value].length;
}

function freshnessStartDate(
	value: NonNullable<SearchAdapterRequest["freshness"]>,
): string {
	const date = new Date();
	if (value === "day") date.setUTCDate(date.getUTCDate() - 1);
	if (value === "month") date.setUTCMonth(date.getUTCMonth() - 1);
	if (value === "year") date.setUTCFullYear(date.getUTCFullYear() - 1);
	return date.toISOString().slice(0, 10);
}

/**
 * 官方 Search 没有 freshness 字段，只能改写成 `after:` 搜索语法；域名条件同样
 * 通过 `site:` / `-site:` 表达。两者都只是远端提示，结果仍由 `normalizeHits`
 * 在本地严格复核，因此超出 query 长度预算时优先保留用户原始查询。
 */
function searchQuery(request: SearchAdapterRequest): string {
	const parts: string[] = [];
	if (request.freshness)
		parts.push(`after:${freshnessStartDate(request.freshness)}`);
	const filters = searchQueryWithDomains(
		"",
		request.includeDomains,
		request.excludeDomains,
	).trim();
	const query = request.query.trim();
	if (!filters) return [query, ...parts].join(" ");
	if (
		characterCount([query, filters, ...parts].join(" ")) > MAX_QUERY_CHARACTERS
	)
		return [query, ...parts].join(" ");
	return [query, filters, ...parts].join(" ");
}

function errorMessage(parsed: Record<string, unknown>, secret: string): string {
	const error = isRecord(parsed.error) ? parsed.error : undefined;
	const message =
		stringField(error?.message) ?? stringField(parsed.message) ?? "";
	return redactText(message.slice(0, 500), [secret]);
}

function errorCode(parsed: Record<string, unknown>): string | undefined {
	const error = isRecord(parsed.error) ? parsed.error : undefined;
	return stringField(error?.code) ?? stringField(error?.type);
}

function classifyStatus(
	status: number,
	fetch: boolean,
):
	| "auth_error"
	| "quota_exceeded"
	| "rate_limited"
	| "no_usable_content"
	| "provider_error" {
	if (status === 401) return "auth_error";
	if (status === 402) return "quota_exceeded";
	if (status === 429) return "rate_limited";
	// Fetch 的 404 表示没有可提取正文，属于可回退的内容问题而非协议错误。
	if (fetch && status === 404) return "no_usable_content";
	return "provider_error";
}

function statusHint(status: number): string {
	if (status === 403) return "（Fetch 被安全策略拒绝）";
	if (status === 408) return "（读取请求体超时）";
	if (status === 413) return "（请求体超过大小限制）";
	if (status === 504) return "（下游请求超时）";
	return "";
}

/** 400/401/402/403 重试同一 Provider 不会有不同结果；其余状态可重试。 */
function statusRetryable(status: number): boolean {
	return status !== 400 && status !== 401 && status !== 402 && status !== 403;
}

function assertHttp(
	response: HttpResponse,
	request: SearchAdapterRequest | ExtractAdapterRequest,
	options: { fetch?: boolean } = {},
): void {
	if (response.status >= 200 && response.status < 300) return;
	let parsed: unknown = response.body;
	try {
		const value: unknown = JSON.parse(response.body);
		if (isRecord(value)) parsed = value;
	} catch {
		// 非 JSON 错误文本原样保留为 raw。
	}
	const record = isRecord(parsed) ? parsed : {};
	const secret = request.instance.apiKey ?? "";
	const message = errorMessage(record, secret);
	const code = errorCode(record);
	throw new WebAccessError(
		classifyStatus(response.status, options.fetch ?? false),
		`${request.instance.id} 返回 HTTP ${response.status}${statusHint(response.status)}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
		{
			provider: ref(request.instance),
			httpStatus: response.status,
			retryable: statusRetryable(response.status),
			raw: sanitizeRaw(parsed, secret),
		},
	);
}

function requestHeaders(
	request: SearchAdapterRequest | ExtractAdapterRequest,
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

/**
 * `snippet` 是面向展示的短摘要，`summary` 是面向模型的长摘要。公共契约只有一个
 * snippet，因此优先短摘要，缺失时才回退到长摘要。
 */
function searchResult(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const snippet =
		stringField(value.snippet) ?? stringField(value.summary) ?? "";
	return { title: value.title, url: value.url, snippet };
}

function searchData(
	parsed: Record<string, unknown>,
	request: SearchAdapterRequest,
): SearchData {
	const results = parsed.results;
	if (results === undefined || results === null) return { results: [] };
	if (!Array.isArray(results))
		throw new WebAccessError(
			"invalid_response",
			`${request.instance.id} 返回无效 results`,
			{
				provider: ref(request.instance),
				retryable: true,
				raw: sanitizeRaw(parsed, request.instance.apiKey ?? ""),
			},
		);
	return {
		results: normalizeHits(
			results.map(searchResult),
			Math.min(request.limit, MAX_COUNT),
			request.includeDomains,
			request.excludeDomains,
		),
	};
}

function documentFromFetch(
	parsed: Record<string, unknown>,
	request: ExtractAdapterRequest,
): ExtractData {
	const content = stringField(parsed.content);
	if (!content)
		throw new WebAccessError(
			"no_usable_content",
			"DeepSeek Fetch 没有返回 Markdown 正文",
			{
				provider: ref(request.instance),
				retryable: true,
				raw: sanitizeRaw(parsed, request.instance.apiKey ?? ""),
			},
		);
	return {
		document: {
			sourceUrl: request.url,
			title: stringField(parsed.title) ?? "",
			content,
			contentType: "text/markdown",
		},
	};
}

const deepseek: ProviderAdapter = {
	type: "deepseek",
	capabilities: ["search", "extract"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		const key = requireCredential(request.instance);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v1/tools/search"),
			{
				method: "POST",
				headers: requestHeaders(request, key),
				body: JSON.stringify({
					query: searchQuery(request),
					count: Math.min(request.limit, MAX_COUNT),
					need_content: false,
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertHttp(response, request);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: searchData(parsed, request), raw: sanitizeRaw(parsed, key) };
	},
	async extract(
		request: ExtractAdapterRequest,
	): Promise<ProviderExecution<ExtractData>> {
		const key = requireCredential(request.instance);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v1/tools/fetch"),
			{
				method: "POST",
				headers: requestHeaders(request, key),
				body: JSON.stringify({ url: request.url }),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertHttp(response, request, { fetch: true });
		const parsed = parseJsonResponse(response, request.instance);
		return {
			data: documentFromFetch(parsed, request),
			raw: sanitizeRaw(parsed, key),
		};
	},
};

export const DEEPSEEK_ADAPTER = deepseek;
