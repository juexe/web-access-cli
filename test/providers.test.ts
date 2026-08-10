import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtractAdapterRequest,
	ProviderType,
	SearchAdapterRequest,
} from "../src/core/types.ts";
import { getAdapter } from "../src/providers/registry.ts";
import { extractRscMarkdown } from "../src/providers/rsc.ts";
import { instance, MockTransport, response } from "./helpers.ts";

const signal = new AbortController().signal;

function searchRequest(
	type: ProviderType,
	transport: MockTransport,
): SearchAdapterRequest {
	return {
		query: "agent neutral web cli",
		limit: 2,
		freshness: "month",
		includeDomains: ["example.com"],
		excludeDomains: ["blocked.example.com"],
		signal,
		maxResponseBytes: 1024 * 1024,
		instance: instance(type),
		transport,
	};
}

test("四个 search adapter 映射为统一 Search Hit", async (t) => {
	const cases: Array<{
		type: "tavily" | "exa" | "brave" | "searxng";
		payload: unknown;
	}> = [
		{
			type: "tavily",
			payload: {
				results: [
					{
						title: "Tavily",
						url: "https://example.com/tavily",
						content: "tavily snippet",
					},
				],
			},
		},
		{
			type: "exa",
			payload: {
				results: [
					{
						title: "Exa",
						url: "https://example.com/exa",
						highlights: ["exa snippet"],
					},
				],
			},
		},
		{
			type: "brave",
			payload: {
				web: {
					results: [
						{
							title: "Brave",
							url: "https://example.com/brave",
							description: "brave snippet",
						},
					],
				},
			},
		},
		{
			type: "searxng",
			payload: {
				results: [
					{
						title: "SearXNG",
						url: "https://example.com/searxng",
						content: "searxng snippet",
					},
				],
			},
		},
	];

	for (const item of cases) {
		await t.test(item.type, async () => {
			const transport = new MockTransport(() => response(item.payload));
			const adapter = getAdapter(item.type, "search");
			assert.ok(adapter?.search);
			const result = await adapter.search(searchRequest(item.type, transport));
			assert.equal(result.data.results.length, 1);
			assert.equal(result.data.results[0]?.rank, 1);
			assert.match(result.data.results[0]?.url ?? "", /example\.com/);
			assert.equal(transport.calls.length, 1);
		});
	}
});

function extractRequest(
	type: ProviderType,
	transport: MockTransport,
): ExtractAdapterRequest {
	return {
		url: "https://example.com/article",
		signal,
		maxResponseBytes: 1024 * 1024,
		minContentCharacters: 20,
		instance: instance(
			type,
			type === "http" ? { apiKey: null, baseUrl: null } : {},
		),
		transport,
	};
}

test("四个 extract adapter 统一输出 Markdown Document", async (t) => {
	const markdown = "# 标题\n\n这是一段足够长的正文，用于验证统一文档输出。";
	const cases: Array<{
		type: "firecrawl" | "jina" | "exa" | "http";
		response: ReturnType<typeof response>;
	}> = [
		{
			type: "firecrawl",
			response: response({
				success: true,
				data: { markdown, metadata: { title: "Firecrawl 标题" } },
			}),
		},
		{
			type: "jina",
			response: response(
				`Title: Jina 标题\nURL Source: https://example.com/article\n\nMarkdown Content:\n${markdown}`,
				{ contentType: "text/markdown" },
			),
		},
		{
			type: "exa",
			response: response({
				results: [
					{
						url: "https://example.com/article",
						title: "Exa 标题",
						text: markdown,
					},
				],
			}),
		},
		{
			type: "http",
			response: response(
				`<!doctype html><html><head><title>HTTP 标题</title></head><body><main><article><h1>标题</h1><p>${"正文内容".repeat(30)}</p></article></main></body></html>`,
				{ contentType: "text/html" },
			),
		},
	];

	for (const item of cases) {
		await t.test(item.type, async () => {
			const transport = new MockTransport(() => item.response);
			const request = extractRequest(item.type, transport);
			if (item.type === "firecrawl") {
				request.instance.baseUrl = "https://firecrawl.internal";
				request.instance.apiKey = null;
			}
			const adapter = getAdapter(item.type, "extract");
			assert.ok(adapter?.extract);
			assert.equal(adapter.isConfigured(request.instance), true);
			const result = await adapter.extract(request);
			assert.equal(result.data.document.contentType, "text/markdown");
			assert.equal(result.data.document.sourceUrl, request.url);
			assert.ok(result.data.document.content.length > 20);
		});
	}
});

test("HTTP extract 拒绝非文本内容", async () => {
	const transport = new MockTransport(() =>
		response("binary", { contentType: "application/pdf" }),
	);
	const adapter = getAdapter("http", "extract");
	assert.ok(adapter?.extract);
	await assert.rejects(
		adapter.extract(extractRequest("http", transport)),
		(error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "unsupported_content",
	);
});

test("RSC 后备解析器提取 Next.js flight payload", () => {
	const paragraph = "这是来自 React Server Components 的正文内容。".repeat(10);
	const payload = `23:${JSON.stringify([
		"$",
		"article",
		null,
		{
			children: [
				["$", "h1", null, { children: "RSC 标题" }],
				["$", "p", null, { children: paragraph }],
			],
		},
	])}\n`;
	const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
	const markdown = extractRscMarkdown(html);
	assert.match(markdown, /^# RSC 标题/);
	assert.match(markdown, /React Server Components/);
});
