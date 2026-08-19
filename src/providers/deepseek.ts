import { WebAccessError } from "../core/errors.ts";
import type {
	ProviderAdapter,
	ProviderExecution,
	SearchAdapterRequest,
	SearchData,
} from "../core/types.ts";
import { buildEndpoint } from "../transport/http.ts";
import { VERSION } from "../version.ts";
import {
	assertOk,
	normalizeHits,
	parseJsonResponse,
	ref,
	requireBaseUrl,
	requireCredential,
	searchQueryWithDomains,
} from "./common.ts";

const MODEL = "deepseek-v4-flash";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;
const MAX_USES = 5;

interface WebSearchResult {
	type?: unknown;
	url?: unknown;
	title?: unknown;
}

interface Citation {
	url?: unknown;
	cited_text?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function contentBlocks(
	response: Record<string, unknown>,
): Record<string, unknown>[] {
	return Array.isArray(response.content)
		? response.content.filter(isRecord)
		: [];
}

function citationSnippets(
	blocks: Record<string, unknown>[],
): Map<string, string> {
	const snippets = new Map<string, string>();
	for (const block of blocks) {
		if (block.type !== "text" || !Array.isArray(block.citations)) continue;
		for (const value of block.citations) {
			if (!isRecord(value)) continue;
			const citation = value as Citation;
			if (
				typeof citation.url === "string" &&
				citation.url.length > 0 &&
				typeof citation.cited_text === "string" &&
				citation.cited_text.length > 0 &&
				!snippets.has(citation.url)
			)
				snippets.set(citation.url, citation.cited_text);
		}
	}
	return snippets;
}

function mapResponse(
	response: Record<string, unknown>,
	request: SearchAdapterRequest,
): SearchData {
	const blocks = contentBlocks(response);
	const resultBlocks = blocks.filter(
		(block) => block.type === "web_search_tool_result",
	);
	if (resultBlocks.length === 0)
		throw new WebAccessError(
			"provider_error",
			"DeepSeek 未返回 web_search_tool_result，原生搜索可能未触发",
			{
				provider: ref(request.instance),
				retryable: true,
				raw: response,
			},
		);

	const snippets = citationSnippets(blocks);
	const items: Array<{ title?: string; url: string; snippet: string }> = [];
	for (const block of resultBlocks) {
		if (!Array.isArray(block.content)) continue;
		for (const value of block.content) {
			if (!isRecord(value)) continue;
			const item = value as WebSearchResult;
			if (item.type !== "web_search_result" || typeof item.url !== "string")
				continue;
			items.push({
				...(typeof item.title === "string" ? { title: item.title } : {}),
				url: item.url,
				snippet: snippets.get(item.url) ?? "",
			});
		}
	}
	return {
		results: normalizeHits(
			items,
			request.limit,
			request.includeDomains,
			request.excludeDomains,
		),
	};
}

function requestHeaders(
	request: SearchAdapterRequest,
	key: string,
): Record<string, string> {
	const protectedHeaders = new Set([
		"x-api-key",
		"authorization",
		"anthropic-version",
		"content-type",
		"accept",
		"user-agent",
	]);
	const headers = Object.fromEntries(
		Object.entries(request.instance.headers).filter(
			([name]) => !protectedHeaders.has(name.toLowerCase()),
		),
	);
	return {
		...headers,
		"x-api-key": key,
		Authorization: `Bearer ${key}`,
		"anthropic-version": API_VERSION,
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": `web-access-cli/${VERSION}`,
	};
}

const deepseek: ProviderAdapter = {
	type: "deepseek",
	capabilities: ["search"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		if (request.freshness)
			throw new WebAccessError(
				"provider_unavailable",
				"DeepSeek 不支持 freshness",
				{ provider: ref(request.instance), retryable: true },
			);
		const key = requireCredential(request.instance);
		const query = searchQueryWithDomains(
			request.query,
			request.includeDomains,
			request.excludeDomains,
		);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "messages"),
			{
				method: "POST",
				headers: requestHeaders(request, key),
				body: JSON.stringify({
					model: MODEL,
					max_tokens: MAX_TOKENS,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `Perform a web search for the query: ${query}`,
								},
							],
						},
					],
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							max_uses: MAX_USES,
						},
					],
				}),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
				maxRedirects: 0,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: mapResponse(parsed, request), raw: parsed };
	},
};

export const DEEPSEEK_ADAPTER = deepseek;
