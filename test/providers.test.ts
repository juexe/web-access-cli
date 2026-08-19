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

test("DeepSeek 使用固定 Messages 协议并只映射结构化搜索结果", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://deepseek.test/messages");
		assert.equal(options.method, "POST");
		assert.equal(options.signal, signal);
		assert.equal(options.maxResponseBytes, 1024 * 1024);
		assert.equal(options.maxRedirects, 0);
		assert.equal(options.headers?.["x-api-key"], "test-key");
		assert.equal(options.headers?.Authorization, "Bearer test-key");
		assert.equal(options.headers?.["anthropic-version"], "2023-06-01");
		assert.equal(options.headers?.["Content-Type"], "application/json");
		assert.equal(options.headers?.Accept, "application/json");
		assert.match(options.headers?.["User-Agent"] ?? "", /^web-access-cli\//);
		assert.equal(options.headers?.["X-Team"], "search");
		assert.equal(options.headers?.authorization, undefined);
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			model: "deepseek-v4-flash",
			max_tokens: 4096,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Perform a web search for the query: agent neutral web cli site:example.com -site:blocked.example.com",
						},
					],
				},
			],
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 5,
				},
			],
		});
		return response({
			content: [
				{ type: "thinking", thinking: "ignore" },
				{ type: "server_tool_use", name: "web_search" },
				{
					type: "text",
					text: "Prose URL https://prose.example.com must be ignored",
					citations: [
						{
							url: "https://example.com/a#fragment",
							cited_text: "first citation",
						},
						{
							url: "https://example.com/a#fragment",
							cited_text: "later citation",
						},
					],
				},
				{
					type: "web_search_tool_result",
					content: [
						{
							type: "web_search_result",
							title: "A",
							url: "https://example.com/a#fragment",
							page_age: "2026-08-01",
						},
						{
							type: "web_search_result",
							title: "duplicate",
							url: "https://example.com/a",
						},
						{
							type: "web_search_result_error",
							url: "https://example.com/error",
						},
						{
							type: "web_search_result",
							title: "blocked",
							url: "https://blocked.example.com/b",
						},
						{
							type: "web_search_result",
							title: "invalid",
							url: "ftp://example.com/file",
						},
						{
							type: "web_search_result",
							title: "B",
							url: "https://example.com/b",
						},
					],
				},
			],
		});
	});
	const adapter = getAdapter("deepseek", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("deepseek", transport);
	request.freshness = undefined;
	request.instance.headers = {
		"X-Team": "search",
		authorization: "Bearer untrusted",
		"X-API-Key": "untrusted",
		"user-agent": "untrusted",
	};
	const result = await adapter.search(request);
	assert.deepEqual(result.data.results, [
		{
			rank: 1,
			title: "A",
			url: "https://example.com/a",
			snippet: "first citation",
		},
		{
			rank: 2,
			title: "B",
			url: "https://example.com/b",
			snippet: "",
		},
	]);
});

test("DeepSeek 区分空结果块与缺少结果块", async () => {
	const adapter = getAdapter("deepseek", "search");
	assert.ok(adapter?.search);
	const emptyTransport = new MockTransport(() =>
		response({ content: [{ type: "web_search_tool_result", content: [] }] }),
	);
	const emptyRequest = searchRequest("deepseek", emptyTransport);
	emptyRequest.freshness = undefined;
	assert.deepEqual((await adapter.search(emptyRequest)).data.results, []);

	const missingTransport = new MockTransport(() =>
		response({ content: [{ type: "text", text: "only prose" }] }),
	);
	const missingRequest = searchRequest("deepseek", missingTransport);
	missingRequest.freshness = undefined;
	await assert.rejects(
		adapter.search(missingRequest),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "provider_error" &&
			"retryable" in error &&
			error.retryable === true,
	);
});

test("DeepSeek freshness 预检查不发请求", async () => {
	const transport = new MockTransport(() => response({ content: [] }));
	const adapter = getAdapter("deepseek", "search");
	assert.ok(adapter?.search);
	await assert.rejects(
		adapter.search(searchRequest("deepseek", transport)),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "provider_unavailable" &&
			"retryable" in error &&
			error.retryable === true,
	);
	assert.equal(transport.calls.length, 0);
});

test("DeepSeek HTTP 与 JSON 错误沿用统一分类", async (t) => {
	const cases = [
		{ status: 401, code: "auth_error", retryable: false },
		{ status: 429, code: "rate_limited", retryable: true },
		{ status: 500, code: "provider_error", retryable: true },
	] as const;
	for (const item of cases) {
		await t.test(String(item.status), async () => {
			const transport = new MockTransport(() =>
				response({ error: "test-key rejected" }, { status: item.status }),
			);
			const adapter = getAdapter("deepseek", "search");
			assert.ok(adapter?.search);
			const request = searchRequest("deepseek", transport);
			request.freshness = undefined;
			await assert.rejects(
				adapter.search(request),
				(error: unknown) =>
					error instanceof Error &&
					"code" in error &&
					error.code === item.code &&
					"retryable" in error &&
					error.retryable === item.retryable &&
					!error.message.includes("test-key"),
			);
		});
	}
	await t.test("invalid JSON", async () => {
		const transport = new MockTransport(() => response("not JSON"));
		const adapter = getAdapter("deepseek", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("deepseek", transport);
		request.freshness = undefined;
		await assert.rejects(
			adapter.search(request),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "invalid_response",
		);
	});
});

test("AnySearch Search 使用固定 REST 协议并执行本地域名过滤", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://anysearch.test/v1/search");
		assert.equal(options.method, "POST");
		assert.equal(options.headers?.Authorization, "Bearer test-key");
		assert.match(
			options.headers?.["X-Anysearch-Client"] ?? "",
			/^web-access-cli\//,
		);
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			query: "agent neutral web cli site:example.com -site:blocked.example.com",
			max_results: 20,
			format: "json",
		});
		return response({
			code: 0,
			data: {
				results: [
					{
						title: "ok",
						url: "https://example.com/a#fragment",
						snippet: "one",
					},
					{
						title: "blocked",
						url: "https://blocked.example.com/b",
						snippet: "two",
					},
				],
			},
		});
	});
	const adapter = getAdapter("anysearch", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("anysearch", transport);
	request.freshness = undefined;
	request.instance.searchFilterMode = "strict";
	const result = await adapter.search(request);
	assert.deepEqual(result.data.results, [
		{ rank: 1, title: "ok", url: "https://example.com/a", snippet: "one" },
	]);
});

test("AnySearch strict freshness 不发请求，best_effort 改写日期查询", async () => {
	const transport = new MockTransport(() =>
		response({ code: 0, data: { results: [] } }),
	);
	const adapter = getAdapter("anysearch", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("anysearch", transport);
	request.instance.searchFilterMode = "strict";
	await assert.rejects(
		adapter.search(request),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "provider_unavailable",
	);
	assert.equal(transport.calls.length, 0);
	request.instance.searchFilterMode = "best_effort";
	await adapter.search(request);
	assert.match(
		JSON.parse(transport.calls[0]?.options.body ?? "").query,
		/after:\d{4}-\d{2}-\d{2}/,
	);
});

test("AnySearch Extract 使用固定 JSON-RPC tools/call 并合并 text blocks", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://anysearch.test/mcp");
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "extract",
				arguments: { url: "https://example.com/article" },
			},
		});
		return response({
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [
					{ type: "text", text: "# 标题" },
					{ type: "text", text: "正文内容" },
				],
			},
		});
	});
	const adapter = getAdapter("anysearch", "extract");
	assert.ok(adapter?.extract);
	const result = await adapter.extract(extractRequest("anysearch", transport));
	assert.equal(result.data.document.title, "标题");
	assert.equal(result.data.document.content, "# 标题\n\n正文内容");
});

test("XCrawl Search 使用固定 REST 协议并规范化嵌套结果", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://xcrawl.test/v1/search");
		assert.equal(options.method, "POST");
		assert.equal(options.headers?.Authorization, "Bearer test-key");
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			query: "agent neutral web cli site:example.com -site:blocked.example.com",
			limit: 20,
		});
		return response({
			search_id: "search-1",
			endpoint: "search",
			status: "completed",
			data: {
				data: [
					{
						description: "first snippet",
						position: 8,
						title: null,
						url: "https://example.com/a#fragment",
					},
					{
						description: "duplicate",
						position: 9,
						title: "duplicate",
						url: "https://example.com/a",
					},
					{
						description: "blocked",
						position: 10,
						title: "blocked",
						url: "https://blocked.example.com/b",
					},
				],
			},
		});
	});
	const adapter = getAdapter("xcrawl", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("xcrawl", transport);
	request.freshness = undefined;
	request.instance.headers.authorization = "Bearer untrusted-override";
	const result = await adapter.search(request);
	assert.deepEqual(result.data.results, [
		{
			rank: 1,
			title: "https://example.com/a",
			url: "https://example.com/a",
			snippet: "first snippet",
		},
	]);
});

test("XCrawl strict freshness 不发请求，best_effort 改写日期查询", async () => {
	const transport = new MockTransport(() =>
		response({ status: "completed", data: { data: [] } }),
	);
	const adapter = getAdapter("xcrawl", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("xcrawl", transport);
	request.instance.searchFilterMode = "strict";
	await assert.rejects(
		adapter.search(request),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "provider_unavailable",
	);
	assert.equal(transport.calls.length, 0);
	request.instance.searchFilterMode = "best_effort";
	await adapter.search(request);
	assert.match(
		JSON.parse(transport.calls[0]?.options.body ?? "").query,
		/after:\d{4}-\d{2}-\d{2}/,
	);
});

test("XCrawl Extract 使用同步 Markdown Scrape 并映射文档", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://xcrawl.test/v1/scrape");
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			url: "https://example.com/article",
			mode: "sync",
			output: { formats: ["markdown"] },
		});
		return response({
			scrape_id: "scrape-1",
			endpoint: "scrape",
			status: "completed",
			url: "https://example.com/article",
			data: {
				markdown: "# 正文标题  \r\n\r\n这是 XCrawl 返回的正文。  \r\n",
				metadata: {
					title: "元数据标题",
					final_url: "https://example.com/final",
				},
			},
		});
	});
	const adapter = getAdapter("xcrawl", "extract");
	assert.ok(adapter?.extract);
	const result = await adapter.extract(extractRequest("xcrawl", transport));
	assert.deepEqual(result.data.document, {
		sourceUrl: "https://example.com/final",
		title: "元数据标题",
		content: "# 正文标题\n\n这是 XCrawl 返回的正文。",
		contentType: "text/markdown",
	});
});

test("XCrawl 失败状态与无效响应映射为稳定错误", async (t) => {
	await t.test("failed", async () => {
		const transport = new MockTransport(() =>
			response({ status: "failed", message: "key=test-key" }),
		);
		const adapter = getAdapter("xcrawl", "extract");
		assert.ok(adapter?.extract);
		await assert.rejects(
			adapter.extract(extractRequest("xcrawl", transport)),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "provider_error" &&
				!error.message.includes("test-key"),
		);
	});
	await t.test("missing data", async () => {
		const transport = new MockTransport(() =>
			response({ status: "completed" }),
		);
		const adapter = getAdapter("xcrawl", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("xcrawl", transport);
		request.freshness = undefined;
		await assert.rejects(
			adapter.search(request),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "invalid_response",
		);
	});
	await t.test("unknown status", async () => {
		const transport = new MockTransport(() =>
			response({ status: "pending-test-key" }),
		);
		const adapter = getAdapter("xcrawl", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("xcrawl", transport);
		request.freshness = undefined;
		await assert.rejects(
			adapter.search(request),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "invalid_response" &&
				!error.message.includes("test-key"),
		);
	});
	await t.test("missing markdown", async () => {
		const transport = new MockTransport(() =>
			response({ status: "completed", data: { metadata: {} } }),
		);
		const adapter = getAdapter("xcrawl", "extract");
		assert.ok(adapter?.extract);
		await assert.rejects(
			adapter.extract(extractRequest("xcrawl", transport)),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "no_usable_content",
		);
	});
	await t.test("invalid JSON", async () => {
		const transport = new MockTransport(() => response("not JSON"));
		const adapter = getAdapter("xcrawl", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("xcrawl", transport);
		request.freshness = undefined;
		await assert.rejects(
			adapter.search(request),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "invalid_response",
		);
	});
});

test("XCrawl HTTP 失败沿用统一错误分类", async (t) => {
	const cases = [
		{ status: 401, code: "auth_error", retryable: false },
		{ status: 403, code: "auth_error", retryable: false },
		{ status: 402, code: "quota_exceeded", retryable: true },
		{ status: 429, code: "rate_limited", retryable: true },
		{ status: 500, code: "provider_error", retryable: true },
	] as const;
	for (const item of cases) {
		await t.test(String(item.status), async () => {
			const transport = new MockTransport(() =>
				response({ error: "test-key rejected" }, { status: item.status }),
			);
			const adapter = getAdapter("xcrawl", "search");
			assert.ok(adapter?.search);
			const request = searchRequest("xcrawl", transport);
			request.freshness = undefined;
			await assert.rejects(
				adapter.search(request),
				(error: unknown) =>
					error instanceof Error &&
					"code" in error &&
					error.code === item.code &&
					"retryable" in error &&
					error.retryable === item.retryable &&
					!error.message.includes("test-key"),
			);
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
