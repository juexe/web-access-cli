import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { WebAccessError } from "../core/errors.ts";
import type {
	ExtractAdapterRequest,
	ExtractData,
	ProviderAdapter,
	ProviderExecution,
} from "../core/types.ts";
import { buildEndpoint } from "../transport/http.ts";
import {
	assertOk,
	parseJsonResponse,
	providerHeadersWithCredential,
	ref,
	requireBaseUrl,
	requireCredential,
} from "./common.ts";
import { extractRscMarkdown } from "./rsc.ts";

function documentFromContent(
	content: string,
	request: ExtractAdapterRequest,
	title = "",
): ExtractData {
	const normalized = content
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	return {
		document: {
			sourceUrl: request.url,
			title: title.trim(),
			content: normalized,
			contentType: "text/markdown",
		},
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJinaDocument(body: string): { content: string; title: string } {
	const declaredTitle = /^Title:\s*(.+)$/im.exec(body)?.[1]?.trim() ?? "";
	const marker = "Markdown Content:";
	const markerIndex = body.indexOf(marker);
	const content = (
		markerIndex >= 0 ? body.slice(markerIndex + marker.length) : body
	).trim();
	const headingTitle = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? "";
	return { content, title: declaredTitle || headingTitle };
}

const firecrawl: ProviderAdapter = {
	type: "firecrawl",
	capabilities: ["extract"],
	isConfigured: (instance) =>
		!!instance.baseUrl &&
		(!!instance.apiKey || instance.baseUrl !== "https://api.firecrawl.dev"),
	async extract(request): Promise<ProviderExecution<ExtractData>> {
		if (requireBaseUrl(request.instance) === "https://api.firecrawl.dev")
			requireCredential(request.instance);
		const response = await request.transport.request(
			buildEndpoint(requireBaseUrl(request.instance), "v2/scrape"),
			{
				method: "POST",
				headers: providerHeadersWithCredential(request.instance, {
					"Content-Type": "application/json",
					Accept: "application/json",
				}),
				body: JSON.stringify({ url: request.url, formats: ["markdown"] }),
				signal: request.signal,
				maxResponseBytes: request.maxResponseBytes,
			},
		);
		assertOk(response, request.instance);
		const parsed = parseJsonResponse(response, request.instance);
		const root =
			parsed.data &&
			typeof parsed.data === "object" &&
			!Array.isArray(parsed.data)
				? (parsed.data as Record<string, unknown>)
				: parsed;
		const content = stringField(root.markdown) ?? stringField(root.content);
		if (!content)
			throw new WebAccessError(
				"no_usable_content",
				"Firecrawl 没有返回 Markdown 正文",
				{ provider: ref(request.instance), retryable: true, raw: parsed },
			);
		const metadata =
			root.metadata &&
			typeof root.metadata === "object" &&
			!Array.isArray(root.metadata)
				? (root.metadata as Record<string, unknown>)
				: undefined;
		return {
			data: documentFromContent(
				content,
				request,
				stringField(metadata?.title) ?? stringField(root.title),
			),
			raw: parsed,
		};
	},
};

const jina: ProviderAdapter = {
	type: "jina",
	capabilities: ["extract"],
	isConfigured: (instance) => !!instance.baseUrl,
	async extract(request): Promise<ProviderExecution<ExtractData>> {
		const base = requireBaseUrl(request.instance).replace(/\/+$/, "");
		const target = `${base}/${request.url}`;
		const response = await request.transport.request(target, {
			headers: providerHeadersWithCredential(request.instance, {
				Accept: "text/markdown",
			}),
			signal: request.signal,
			maxResponseBytes: request.maxResponseBytes,
		});
		assertOk(response, request.instance);
		const parsed = parseJinaDocument(response.body);
		return {
			data: documentFromContent(parsed.content, request, parsed.title),
			raw: response.body,
		};
	},
};

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
});

function extractHttpDocument(
	body: string,
	contentType: string,
): { markdown: string; title: string } {
	const isHtml =
		/html|xhtml/i.test(contentType) ||
		/^\s*(?:<!doctype html|<html|<head|<body)/i.test(body);
	if (!isHtml) return { markdown: body, title: "" };
	const { document } = parseHTML(body);
	let title = document.querySelector("title")?.textContent?.trim() ?? "";
	let html = body;
	try {
		const article = new Readability(document as unknown as Document).parse();
		if (article?.content) {
			html = article.content;
			title = article.title?.trim() || title;
		}
	} catch {
		html = body;
	}
	const readability = turndown.turndown(html);
	const rsc = extractRscMarkdown(body);
	return {
		markdown: rsc.length > readability.length ? rsc : readability,
		title,
	};
}

const http: ProviderAdapter = {
	type: "http",
	capabilities: ["extract"],
	isConfigured: () => true,
	async extract(request): Promise<ProviderExecution<ExtractData>> {
		const response = await request.transport.request(request.url, {
			headers: {
				Accept:
					"text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1",
				...request.instance.headers,
			},
			signal: request.signal,
			maxResponseBytes: request.maxResponseBytes,
		});
		assertOk(response, request.instance);
		const contentType =
			response.headers.get("content-type")?.toLowerCase() ?? "";
		if (
			/^(?:image|audio|video)\//.test(contentType) ||
			/application\/(?:zip|octet-stream|pdf)/.test(contentType)
		) {
			throw new WebAccessError(
				"unsupported_content",
				`不支持的内容类型: ${contentType.split(";")[0]}`,
				{
					provider: ref(request.instance),
					retryable: false,
					raw: response.body,
				},
			);
		}
		const parsed = extractHttpDocument(response.body, contentType);
		return {
			data: documentFromContent(parsed.markdown, request, parsed.title),
			raw: response.body,
		};
	},
};

export const EXTRACT_ADAPTERS: ProviderAdapter[] = [firecrawl, jina, http];
