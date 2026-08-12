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
import {
	assertOk,
	freshnessStartDate,
	normalizeHits,
	parseJsonResponse,
	providerHeaders,
	ref,
	requireBaseUrl,
	requireCredential,
	searchQueryWithDomains,
} from "./common.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function responseMessage(value: Record<string, unknown>): string {
	for (const candidate of [
		value.message,
		value.error,
		isRecord(value.data) ? value.data.message : undefined,
		isRecord(value.data) ? value.data.error : undefined,
	]) {
		if (typeof candidate === "string" && candidate.trim())
			return candidate.trim().slice(0, 500);
		if (isRecord(candidate)) {
			const nested =
				stringField(candidate.message) ?? stringField(candidate.error);
			if (nested) return nested.slice(0, 500);
		}
	}
	return "上游任务失败";
}

function assertCompleted(
	parsed: Record<string, unknown>,
	request: SearchAdapterRequest | ExtractAdapterRequest,
): void {
	if (parsed.status === "completed") return;
	if (parsed.status === "failed") {
		const message = redactText(responseMessage(parsed), [
			request.instance.apiKey,
		]);
		throw new WebAccessError("provider_error", `XCrawl 任务失败: ${message}`, {
			provider: ref(request.instance),
			retryable: true,
			raw: parsed,
		});
	}
	throw new WebAccessError("invalid_response", "XCrawl 返回未知任务状态", {
		provider: ref(request.instance),
		retryable: true,
		raw: parsed,
	});
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

function requestHeaders(
	request: SearchAdapterRequest | ExtractAdapterRequest,
): Record<string, string> {
	const key = requireCredential(request.instance);
	const headers = providerHeaders(request.instance, {
		"Content-Type": "application/json",
		Accept: "application/json",
	});
	for (const name of Object.keys(headers))
		if (name.toLowerCase() === "authorization") delete headers[name];
	headers.Authorization = `Bearer ${key}`;
	return headers;
}

function normalizedMarkdown(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

const xcrawl: ProviderAdapter = {
	type: "xcrawl",
	capabilities: ["search", "extract"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		if (
			request.freshness &&
			(request.instance.searchFilterMode ?? "strict") === "strict"
		)
			throw new WebAccessError(
				"provider_unavailable",
				"XCrawl 严格模式不支持 freshness",
				{ provider: ref(request.instance), retryable: true },
			);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v1/search"),
			{
				method: "POST",
				headers: requestHeaders(request),
				body: JSON.stringify({
					query: queryWithFilters(request),
					limit:
						request.includeDomains.length || request.excludeDomains.length
							? 20
							: request.limit,
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		assertCompleted(parsed, request);
		if (!isRecord(parsed.data) || !Array.isArray(parsed.data.data))
			throw new WebAccessError(
				"invalid_response",
				"XCrawl Search 返回缺少 data.data",
				{
					provider: ref(request.instance),
					retryable: true,
					raw: parsed,
				},
			);
		return {
			data: {
				results: normalizeHits(
					parsed.data.data,
					request.limit,
					request.includeDomains,
					request.excludeDomains,
				),
			},
			raw: parsed,
		};
	},
	async extract(request): Promise<ProviderExecution<ExtractData>> {
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v1/scrape"),
			{
				method: "POST",
				headers: requestHeaders(request),
				body: JSON.stringify({
					url: request.url,
					mode: "sync",
					output: { formats: ["markdown"] },
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		assertCompleted(parsed, request);
		if (!isRecord(parsed.data))
			throw new WebAccessError(
				"invalid_response",
				"XCrawl Scrape 返回缺少 data",
				{
					provider: ref(request.instance),
					retryable: true,
					raw: parsed,
				},
			);
		const content = stringField(parsed.data.markdown);
		if (!content)
			throw new WebAccessError(
				"no_usable_content",
				"XCrawl Scrape 没有返回 Markdown 正文",
				{
					provider: ref(request.instance),
					retryable: true,
					raw: parsed,
				},
			);
		const markdown = normalizedMarkdown(content);
		const metadata = isRecord(parsed.data.metadata)
			? parsed.data.metadata
			: undefined;
		const title =
			stringField(metadata?.title) ??
			/^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ??
			"";
		return {
			data: {
				document: {
					sourceUrl:
						httpUrl(metadata?.final_url) ?? httpUrl(parsed.url) ?? request.url,
					title,
					content: markdown,
					contentType: "text/markdown",
				},
			},
			raw: parsed,
		};
	},
};

export const XCRAWL_ADAPTER = xcrawl;
