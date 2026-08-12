import { redactText, WebAccessError } from "../core/errors.ts";
import type {
	ExtractAdapterRequest,
	ExtractData,
	ProviderAdapter,
	ProviderExecution,
	SearchAdapterRequest,
	SearchData,
} from "../core/types.ts";
import { buildEndpoint } from "../transport/http.ts";
import { VERSION } from "../version.ts";
import {
	freshnessStartDate,
	normalizeHits,
	parseJsonResponse,
	providerHeaders,
	ref,
	requireBaseUrl,
	searchQueryWithDomains,
} from "./common.ts";

function requestBody(data: unknown): string {
	return JSON.stringify(data);
}

function queryWithFilters(request: SearchAdapterRequest): string {
	const parts = [
		searchQueryWithDomains(
			request.query,
			request.includeDomains,
			request.excludeDomains,
		),
	];
	if (request.instance.searchFilterMode === "best_effort" && request.freshness)
		parts.push(`after:${freshnessStartDate(request.freshness)}`);
	return parts.join(" ");
}

function upstreamMessage(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 500);
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		for (const key of ["message", "error", "msg"]) {
			if (typeof record[key] === "string") return record[key].slice(0, 500);
		}
	}
	return "上游返回错误";
}

function sensitiveValues(value: unknown): string[] {
	const values: string[] = [];
	const sensitive =
		/^(?:auto[_-]?registered|api[_-]?key|apikey|password|username|user|email|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|authorization|cookie|client[_-]?secret|clientsecret)$/i;
	const visit = (current: unknown, key = ""): void => {
		if (
			typeof current === "string" &&
			sensitive.test(key) &&
			current.length >= 4
		)
			values.push(current);
		else if (Array.isArray(current)) {
			for (const item of current) visit(item, key);
		} else if (current && typeof current === "object") {
			for (const [name, item] of Object.entries(current)) visit(item, name);
		}
	};
	visit(value);
	return values;
}

function statusFailure(
	status: number,
	body: unknown,
	request: SearchAdapterRequest | ExtractAdapterRequest,
): WebAccessError {
	let parsedBody: unknown = body;
	try {
		parsedBody = JSON.parse(body as string);
	} catch {
		// 保留非 JSON 错误文本。
	}
	const message = redactText(upstreamMessage(parsedBody), [
		...sensitiveValues(parsedBody),
		request.instance.apiKey,
	]);
	let code:
		| "auth_error"
		| "quota_exceeded"
		| "rate_limited"
		| "timeout"
		| "unsupported_content"
		| "provider_error";
	let retryable = false;
	if (status === 401 || status === 403) code = "auth_error";
	else if (status === 402) {
		code = "quota_exceeded";
		retryable = true;
	} else if (status === 429) {
		code = "rate_limited";
		retryable = true;
	} else if (status === 504) {
		code = "timeout";
		retryable = true;
	} else if (status === 415) code = "unsupported_content";
	else {
		code = "provider_error";
		retryable = status >= 500;
	}
	return new WebAccessError(
		code,
		`${request.instance.id} 返回 HTTP ${status}${message ? `: ${message}` : ""}`,
		{
			provider: ref(request.instance),
			httpStatus: status,
			retryable,
			raw: parsedBody,
		},
	);
}

function assertHttp(
	response: { status: number; body: string },
	request: SearchAdapterRequest | ExtractAdapterRequest,
): void {
	if (response.status < 200 || response.status >= 300)
		throw statusFailure(response.status, response.body, request);
}

function resultData(
	parsed: Record<string, unknown>,
	request: SearchAdapterRequest,
): Record<string, unknown> {
	const data = parsed.data;
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new WebAccessError("invalid_response", "AnySearch 返回缺少 data", {
			provider: ref(request.instance),
			retryable: true,
			raw: parsed,
		});
	return data as Record<string, unknown>;
}

function businessFailure(
	parsed: Record<string, unknown>,
	request: SearchAdapterRequest | ExtractAdapterRequest,
): never {
	const codeValue = parsed.code;
	const status = typeof codeValue === "number" ? codeValue : undefined;
	let code:
		| "auth_error"
		| "quota_exceeded"
		| "rate_limited"
		| "timeout"
		| "provider_error" = "provider_error";
	let retryable = true;
	if (status === 401 || status === 403) {
		code = "auth_error";
		retryable = false;
	} else if (status === 402) code = "quota_exceeded";
	else if (status === 429) code = "rate_limited";
	else if (status === 504) code = "timeout";
	const message = redactText(upstreamMessage(parsed.message ?? parsed.error), [
		...sensitiveValues(parsed),
		request.instance.apiKey,
	]);
	throw new WebAccessError(
		code,
		`${request.instance.id} 返回业务错误${status !== undefined ? ` ${status}` : ""}: ${message}`,
		{ provider: ref(request.instance), retryable, raw: parsed },
	);
}

const anysearch: ProviderAdapter = {
	type: "anysearch",
	capabilities: ["search", "extract"],
	isConfigured: (instance) => !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		if (
			request.freshness &&
			(request.instance.searchFilterMode ?? "strict") === "strict"
		)
			throw new WebAccessError(
				"provider_unavailable",
				"AnySearch 严格模式不支持 freshness",
				{ provider: ref(request.instance), retryable: true },
			);
		const maxResults =
			request.includeDomains.length || request.excludeDomains.length
				? 20
				: request.limit;
		const headers = providerHeaders(request.instance, {
			"Content-Type": "application/json",
			Accept: "application/json",
			"X-Anysearch-Client": `web-access-cli/${VERSION}`,
		});
		headers["X-Anysearch-Client"] = `web-access-cli/${VERSION}`;
		if (request.instance.apiKey)
			headers.Authorization = `Bearer ${request.instance.apiKey}`;
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v1/search"),
			{
				method: "POST",
				headers,
				body: requestBody({
					query: queryWithFilters(request),
					max_results: maxResults,
					format: "json",
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertHttp(response, request);
		const parsed = parseJsonResponse(response, request.instance);
		if (parsed.code !== 0) businessFailure(parsed, request);
		const data = resultData(parsed, request);
		if (!Array.isArray(data.results))
			throw new WebAccessError(
				"invalid_response",
				"AnySearch 返回缺少 data.results",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		return {
			data: {
				results: normalizeHits(
					data.results,
					request.limit,
					request.includeDomains,
					request.excludeDomains,
				),
			},
			raw: parsed,
		};
	},
	async extract(request): Promise<ProviderExecution<ExtractData>> {
		const headers = providerHeaders(request.instance, {
			"Content-Type": "application/json",
			Accept: "application/json",
			"X-Anysearch-Client": `web-access-cli/${VERSION}`,
		});
		headers["X-Anysearch-Client"] = `web-access-cli/${VERSION}`;
		if (request.instance.apiKey)
			headers.Authorization = `Bearer ${request.instance.apiKey}`;
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "mcp"),
			{
				method: "POST",
				headers,
				body: requestBody({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "extract", arguments: { url: request.url } },
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertHttp(response, request);
		const parsed = parseJsonResponse(response, request.instance);
		if (parsed.jsonrpc !== "2.0" || parsed.id !== 1)
			throw new WebAccessError(
				"invalid_response",
				"AnySearch JSON-RPC 响应格式无效",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		if (parsed.error !== undefined) businessFailure(parsed, request);
		const result = parsed.result;
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new WebAccessError(
				"invalid_response",
				"AnySearch JSON-RPC 缺少 result",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		const resultRecord = result as Record<string, unknown>;
		if (resultRecord.isError === true)
			throw new WebAccessError(
				"provider_error",
				`AnySearch extract 工具错误: ${upstreamMessage(resultRecord)}`,
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		if (!Array.isArray(resultRecord.content))
			throw new WebAccessError(
				"invalid_response",
				"AnySearch JSON-RPC 缺少 content",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		const content = resultRecord.content
			.filter(
				(block): block is Record<string, unknown> =>
					!!block && typeof block === "object" && !Array.isArray(block),
			)
			.map((block) => (typeof block.text === "string" ? block.text.trim() : ""))
			.filter(Boolean)
			.join("\n\n");
		if (!content)
			throw new WebAccessError(
				"no_usable_content",
				"AnySearch extract 没有返回正文",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? "";
		return {
			data: {
				document: {
					sourceUrl: request.url,
					title,
					content,
					contentType: "text/markdown",
				},
			},
			raw: parsed,
		};
	},
};

export const ANYSEARCH_ADAPTER = anysearch;
