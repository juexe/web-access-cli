import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebAccessError } from "../src/core/errors.ts";
import type {
	ExtractAdapterRequest,
	ProviderType,
	SearchAdapterRequest,
} from "../src/core/types.ts";
import { assertOk, parseJsonResponse } from "../src/providers/common.ts";
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

test("共享 HTTP helper 统一分类非 2xx 响应", () => {
	const provider = instance("xcrawl", {
		id: "shared",
		apiKey: "known-secret",
	});
	const cases = [
		{ status: 401, code: "auth_error", retryable: false },
		{ status: 403, code: "auth_error", retryable: false },
		{ status: 402, code: "quota_exceeded", retryable: true },
		{ status: 429, code: "rate_limited", retryable: true },
		{ status: 404, code: "provider_error", retryable: false },
		{ status: 302, code: "provider_error", retryable: false },
		{ status: 500, code: "provider_error", retryable: true },
	] as const;

	for (const item of cases) {
		assert.throws(
			() =>
				assertOk(
					response({ error: "known-secret rejected" }, { status: item.status }),
					provider,
				),
			(error: unknown) => {
				assert.ok(
					error instanceof WebAccessError,
					`HTTP ${item.status} 应抛出 WebAccessError`,
				);
				assert.equal(error.code, item.code, `HTTP ${item.status} code`);
				assert.equal(
					error.httpStatus,
					item.status,
					`HTTP ${item.status} httpStatus`,
				);
				assert.equal(
					error.retryable,
					item.retryable,
					`HTTP ${item.status} retryable`,
				);
				assert.doesNotMatch(
					error.message,
					/known-secret/,
					`HTTP ${item.status} 应脱敏已知 key`,
				);
				return true;
			},
		);
	}
});

test("共享 JSON helper 拒绝空响应、非法 JSON 和非对象 JSON", () => {
	const provider = instance("xcrawl", { id: "shared" });
	const cases = [
		{ label: "空响应", body: "", retryable: false },
		{ label: "非法 JSON", body: "not JSON", retryable: true },
		{ label: "非对象 JSON", body: "[]", retryable: true },
	] as const;

	for (const item of cases) {
		assert.throws(
			() => parseJsonResponse(response(item.body), provider),
			(error: unknown) => {
				assert.ok(
					error instanceof WebAccessError,
					`${item.label} 应抛出 WebAccessError`,
				);
				assert.equal(error.code, "invalid_response", `${item.label} code`);
				assert.equal(error.httpStatus, 200, `${item.label} httpStatus`);
				assert.equal(
					error.retryable,
					item.retryable,
					`${item.label} retryable`,
				);
				return true;
			},
		);
	}
});

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

test("Bocha Web Search 使用固定协议、过滤域名并优先 summary", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://bocha.test/v1/web-search");
		assert.equal(options.method, "POST");
		assert.equal(options.headers?.Authorization, "Bearer test-key");
		assert.equal(options.headers?.["Content-Type"], "application/json");
		assert.equal(options.headers?.Accept, "application/json");
		assert.equal(options.headers?.authorization, undefined);
		assert.equal(options.headers?.["X-Team"], "search");
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			query: "agent neutral web cli site:example.com -site:blocked.example.com",
			count: 2,
			summary: true,
			freshness: "oneMonth",
		});
		return response({
			code: 200,
			data: {
				webPages: {
					value: [
						{
							name: "A",
							url: "https://example.com/a#fragment",
							summary: "summary text",
							snippet: "snippet text",
						},
						{
							name: "blocked",
							url: "https://blocked.example.com/b",
							snippet: "blocked",
						},
						{
							name: "B",
							url: "https://example.com/b",
							summary: "   ",
							snippet: "fallback snippet",
						},
					],
				},
			},
			log_id: "log-1",
		});
	});
	const adapter = getAdapter("bocha", "search");
	assert.ok(adapter?.search);
	const request = searchRequest("bocha", transport);
	request.instance.headers = {
		"X-Team": "search",
		authorization: "Bearer untrusted",
		"Content-Type": "text/plain",
		Accept: "text/plain",
	};
	const result = await adapter.search(request);
	assert.deepEqual(result.data.results, [
		{
			rank: 1,
			title: "A",
			url: "https://example.com/a",
			snippet: "summary text",
		},
		{
			rank: 2,
			title: "B",
			url: "https://example.com/b",
			snippet: "fallback snippet",
		},
	]);
});

test("Bocha 缺省 freshness、空结果、业务码和 HTTP 403 映射稳定", async (t) => {
	await t.test("noLimit and empty", async () => {
		const transport = new MockTransport((_url, options) => {
			assert.equal(JSON.parse(options.body ?? "").freshness, "noLimit");
			return response({ data: {} });
		});
		const adapter = getAdapter("bocha", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("bocha", transport);
		request.freshness = undefined;
		assert.deepEqual((await adapter.search(request)).data.results, []);
	});
	await t.test("business error redacts key", async () => {
		const transport = new MockTransport(() =>
			response({ code: 429, msg: "bad test-key", log_id: "log-2" }),
		);
		const adapter = getAdapter("bocha", "search");
		assert.ok(adapter?.search);
		await assert.rejects(
			adapter.search(searchRequest("bocha", transport)),
			(error: unknown) =>
				error instanceof WebAccessError &&
				error.code === "rate_limited" &&
				error.retryable &&
				!error.message.includes("test-key") &&
				!JSON.stringify(error.raw).includes("test-key"),
		);
	});
	await t.test("HTTP 403", async () => {
		const transport = new MockTransport(() =>
			response({ msg: "denied test-key", log_id: "log-3" }, { status: 403 }),
		);
		const adapter = getAdapter("bocha", "search");
		assert.ok(adapter?.search);
		await assert.rejects(
			adapter.search(searchRequest("bocha", transport)),
			(error: unknown) =>
				error instanceof WebAccessError &&
				error.code === "quota_exceeded" &&
				error.httpStatus === 403 &&
				!error.retryable,
		);
	});
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
							encrypted_content: "opaque-provider-payload",
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
	assert.doesNotMatch(
		JSON.stringify(result.raw),
		/encrypted_content|opaque-provider-payload/,
	);
	assert.match(JSON.stringify(result.raw), /web_search_tool_result/);
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

test("xAI hosted search 映射引用、域名过滤并脱敏 OAuth token", async () => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-xai-"));
	const authPath = join(directory, "auth.json");
	writeFileSync(
		authPath,
		JSON.stringify({ access_token: "oauth-secret-token" }),
		"utf8",
	);
	try {
		const transport = new MockTransport((url, options) => {
			assert.equal(url, "https://xai_web_search.test/responses");
			assert.equal(options.headers?.Authorization, "Bearer oauth-secret-token");
			assert.equal(options.headers?.["X-XAI-Token-Auth"], "xai-grok-cli");
			assert.equal(options.headers?.["x-grok-client-identifier"], "grok-shell");
			const body = JSON.parse(options.body ?? "");
			assert.equal(body.model, "grok-4.6");
			assert.deepEqual(body.tools, [
				{ type: "web_search", filters: { allowed_domains: ["example.com"] } },
			]);
			return response({
				output: [
					{
						type: "web_search_call",
						action: {
							sources: [
								{
									type: "url",
									url: "https://example.com/source",
									title: "Source",
								},
								{
									type: "url",
									url: "https://blocked.test/no",
									title: "Blocked",
								},
							],
						},
					},
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "See https://example.com/source.",
								annotations: [
									{
										type: "url_citation",
										url: "https://example.com/source",
										title: "Source citation",
										start_index: 4,
										end_index: 30,
									},
								],
							},
						],
					},
				],
				token: "oauth-secret-token",
			});
		});
		const adapter = getAdapter("xai_web_search", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("xai_web_search", transport);
		request.freshness = undefined;
		request.includeDomains = ["example.com"];
		request.excludeDomains = [];
		request.instance.authJson = authPath;
		request.instance.baseUrl = "https://xai_web_search.test";
		request.instance.model = "grok-4.6";
		const result = await adapter.search(request);
		assert.deepEqual(result.data.results, [
			{
				rank: 1,
				title: "Source citation",
				url: "https://example.com/source",
				snippet: "See https://example.com/source.",
			},
		]);
		assert.doesNotMatch(JSON.stringify(result.raw), /oauth-secret-token/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("xAI x_search 拒绝 freshness，并只接受真实引用", async () => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-xai-"));
	const authPath = join(directory, "auth.json");
	writeFileSync(
		authPath,
		JSON.stringify({ access_token: "oauth-secret-token" }),
		"utf8",
	);
	try {
		const transport = new MockTransport(() => response({ output: [] }));
		const adapter = getAdapter("xai_x_search", "search");
		assert.ok(adapter?.search);
		const request = searchRequest("xai_x_search", transport);
		request.instance.authJson = authPath;
		await assert.rejects(
			adapter.search(request),
			(error: unknown) =>
				error instanceof WebAccessError &&
				error.code === "provider_unavailable" &&
				transport.calls.length === 0,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
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

test("AnySearch Extract 读取 REST data.content 为 Markdown 正文", async () => {
	const transport = new MockTransport((url, options) => {
		assert.equal(url, "https://anysearch.test/v1/extract");
		assert.equal(options.method, "POST");
		assert.deepEqual(JSON.parse(options.body ?? ""), {
			url: "https://example.com/article",
		});
		return response({
			code: 0,
			message: "success",
			data: {
				url: "https://example.com/final",
				title: "AnySearch 标题",
				content: "# 正文标题\n\n正文内容",
			},
		});
	});
	const adapter = getAdapter("anysearch", "extract");
	assert.ok(adapter?.extract);
	const result = await adapter.extract(extractRequest("anysearch", transport));
	assert.deepEqual(result.data.document, {
		sourceUrl: "https://example.com/final",
		title: "AnySearch 标题",
		content: "# 正文标题\n\n正文内容",
		contentType: "text/markdown",
	});
});

test("AnySearch Extract 不把响应 JSON 序列化为正文", async () => {
	const transport = new MockTransport(() =>
		response({
			code: 0,
			data: {
				url: "https://example.com/article",
				content: { markdown: "# 标题" },
			},
		}),
	);
	const adapter = getAdapter("anysearch", "extract");
	assert.ok(adapter?.extract);
	await assert.rejects(
		adapter.extract(extractRequest("anysearch", transport)),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "no_usable_content",
	);
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

test("HTTP extract Markdown 探测规范化 URL、协商格式并验证正文", async (t) => {
	const cases = [
		{
			url: "https://example.com/article?lang=zh",
			expected: "https://example.com/article.md?lang=zh",
			contentType: "text/markdown; charset=utf-8",
		},
		{
			url: "https://example.com/docs/",
			expected: "https://example.com/docs/index.md",
			contentType: "text/plain; charset=utf-8",
		},
		{
			url: "https://example.com/article.md",
			expected: "https://example.com/article.md",
			contentType: "text/markdown",
		},
	] as const;

	for (const item of cases) {
		await t.test(item.url, async () => {
			const transport = new MockTransport((url, options) => {
				assert.equal(url, item.expected);
				assert.equal(
					options.headers?.Accept,
					"text/markdown, text/plain;q=0.9",
				);
				return response(
					"# Markdown title\n\nThis is a sufficiently long markdown document.",
					{ contentType: item.contentType },
				);
			});
			const request = extractRequest("http", transport);
			request.url = item.url;
			request.minContentCharacters = 10;
			request.instance.headers = { "X-Site": "docs" };
			const adapter = getAdapter("http", "extract");
			assert.ok(adapter?.probeExtract);
			const result = await adapter.probeExtract(request);
			assert.ok(result);
			assert.equal(result.data.document.sourceUrl, item.url);
			assert.match(result.data.document.content, /sufficiently long/);
			assert.equal(transport.calls[0]?.options.headers?.["X-Site"], "docs");
		});
	}
});

test("HTTP extract Markdown 探测忽略非 Markdown、HTML 和过短正文", async (t) => {
	const cases = [
		{ body: "# Valid markdown but wrong media type", contentType: "text/html" },
		{
			body: "<html><body>Looks like HTML</body></html>",
			contentType: "text/plain",
		},
		{
			body: "\uFEFF<!-- generated --><!doctype html><html></html>",
			contentType: "text/markdown",
		},
		{ body: "# Tiny", contentType: "text/markdown" },
		{ body: "# Error page", contentType: "text/markdown", status: 404 },
	] as const;

	for (const item of cases) {
		await t.test(
			`${"status" in item ? item.status : 200} ${item.contentType}`,
			async () => {
				const transport = new MockTransport(() =>
					response(item.body, {
						status: "status" in item ? item.status : undefined,
						contentType: item.contentType,
					}),
				);
				const adapter = getAdapter("http", "extract");
				assert.ok(adapter?.probeExtract);
				assert.equal(
					await adapter.probeExtract(extractRequest("http", transport)),
					undefined,
				);
			},
		);
	}
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
