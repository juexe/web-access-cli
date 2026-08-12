import { WebAccessError } from "../core/errors.ts";
import type {
	ExtractAdapterRequest,
	ExtractData,
	ProviderAdapter,
	ProviderExecution,
	SearchAdapterRequest,
	SearchData,
} from "../core/types.ts";
import { buildEndpoint, mergeHeaders } from "../transport/http.ts";
import {
	assertOk,
	freshnessStartDate,
	normalizeHits,
	parseJsonResponse,
	providerHeaders,
	providerHeadersWithCredential,
	ref,
	requireBaseUrl,
	requireCredential,
	searchQueryWithDomains,
} from "./common.ts";

function requestBody(data: Record<string, unknown>): string {
	return JSON.stringify(data);
}

function mapSearchResult(
	response: Record<string, unknown>,
	request: SearchAdapterRequest,
): SearchData {
	const results = Array.isArray(response.results) ? response.results : [];
	return {
		results: normalizeHits(
			results,
			request.limit,
			request.includeDomains,
			request.excludeDomains,
		),
	};
}

function mapBraveResult(
	response: Record<string, unknown>,
	request: SearchAdapterRequest,
): SearchData {
	const web = response.web;
	const results =
		web && typeof web === "object" && !Array.isArray(web)
			? (web as Record<string, unknown>).results
			: [];
	return {
		results: normalizeHits(
			results,
			request.limit,
			request.includeDomains,
			request.excludeDomains,
		),
	};
}

const tavily: ProviderAdapter = {
	type: "tavily",
	capabilities: ["search"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		requireCredential(request.instance);
		const body: Record<string, unknown> = {
			query: request.query,
			search_depth: "basic",
			max_results: request.limit,
			include_answer: false,
			include_raw_content: false,
			...(request.freshness ? { time_range: request.freshness } : {}),
			...(request.includeDomains.length
				? { include_domains: request.includeDomains }
				: {}),
			...(request.excludeDomains.length
				? { exclude_domains: request.excludeDomains }
				: {}),
		};
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "search"),
			{
				method: "POST",
				headers: providerHeadersWithCredential(
					request.instance,
					mergeHeaders({
						"Content-Type": "application/json",
						Accept: "application/json",
					}),
				),
				body: requestBody(body),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: mapSearchResult(parsed, request), raw: parsed };
	},
};

const exa: ProviderAdapter = {
	type: "exa",
	capabilities: ["search", "extract"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		const key = requireCredential(request.instance);
		const body: Record<string, unknown> = {
			query: request.query,
			type: "auto",
			numResults: request.limit,
			contents: { highlights: { maxCharacters: 500 } },
			...(request.includeDomains.length
				? { includeDomains: request.includeDomains }
				: {}),
			...(request.excludeDomains.length
				? { excludeDomains: request.excludeDomains }
				: {}),
			...(request.freshness
				? { startPublishedDate: freshnessStartDate(request.freshness) }
				: {}),
		};
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "search"),
			{
				method: "POST",
				headers: providerHeaders(request.instance, {
					"Content-Type": "application/json",
					Accept: "application/json",
					"x-api-key": key,
				}),
				body: requestBody(body),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: mapSearchResult(parsed, request), raw: parsed };
	},
	async extract(
		request: ExtractAdapterRequest,
	): Promise<ProviderExecution<ExtractData>> {
		const key = requireCredential(request.instance);
		const body = { urls: [request.url], text: true };
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "contents"),
			{
				method: "POST",
				headers: providerHeaders(request.instance, {
					"Content-Type": "application/json",
					Accept: "application/json",
					"x-api-key": key,
				}),
				body: requestBody(body),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		const items = Array.isArray(parsed.results) ? parsed.results : [];
		const item = items.find(
			(candidate) =>
				candidate &&
				typeof candidate === "object" &&
				typeof (candidate as Record<string, unknown>).text === "string",
		) as Record<string, unknown> | undefined;
		if (!item || typeof item.text !== "string" || !item.text.trim())
			throw new WebAccessError(
				"no_usable_content",
				"Exa Contents 没有返回正文",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		return {
			data: {
				document: {
					sourceUrl: typeof item.url === "string" ? item.url : request.url,
					title: typeof item.title === "string" ? item.title : "",
					content: item.text.trim(),
					contentType: "text/markdown",
				},
			},
			raw: parsed,
		};
	},
};

const brave: ProviderAdapter = {
	type: "brave",
	capabilities: ["search"],
	isConfigured: (instance) => !!instance.apiKey && !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		const key = requireCredential(request.instance);
		const url = new URL(
			buildEndpoint(requireBaseUrl(request.instance), "res/v1/web/search"),
		);
		url.searchParams.set(
			"q",
			searchQueryWithDomains(
				request.query,
				request.includeDomains,
				request.excludeDomains,
			),
		);
		url.searchParams.set(
			"count",
			String(
				request.includeDomains.length || request.excludeDomains.length
					? 20
					: request.limit,
			),
		);
		if (request.freshness)
			url.searchParams.set(
				"freshness",
				{ day: "pd", month: "pm", year: "py" }[request.freshness],
			);
		const response = await request.transport.request(url, {
			headers: providerHeaders(request.instance, {
				Accept: "application/json",
				"X-Subscription-Token": key,
			}),
			signal: request.signal,
			maxResponseBytes: request.maxResponseBytes,
		});
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: mapBraveResult(parsed, request), raw: parsed };
	},
};

const searxng: ProviderAdapter = {
	type: "searxng",
	capabilities: ["search"],
	isConfigured: (instance) => !!instance.baseUrl,
	async search(request): Promise<ProviderExecution<SearchData>> {
		const url = new URL(
			buildEndpoint(requireBaseUrl(request.instance), "search"),
		);
		url.searchParams.set(
			"q",
			searchQueryWithDomains(
				request.query,
				request.includeDomains,
				request.excludeDomains,
			),
		);
		url.searchParams.set("format", "json");
		if (request.freshness)
			url.searchParams.set("time_range", request.freshness);
		const response = await request.transport.request(url, {
			headers: providerHeadersWithCredential(request.instance, {
				Accept: "application/json",
			}),
			signal: request.signal,
			maxResponseBytes: request.maxResponseBytes,
		});
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		return { data: mapSearchResult(parsed, request), raw: parsed };
	},
};

export const SEARCH_ADAPTERS: ProviderAdapter[] = [tavily, exa, brave, searxng];
export const EXA_ADAPTER = exa;
