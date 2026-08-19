import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import { executeExtract, executeSearch } from "../src/core/router.ts";
import type { ExtractRequest, SearchRequest } from "../src/core/types.ts";
import { MockTransport, response } from "./helpers.ts";

function loadedConfig(value: unknown): {
	loaded: LoadedConfig;
	cleanup(): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "web-access-router-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		loaded: loadConfig(path, {}),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

const searchRequest: SearchRequest = {
	query: "web access",
	provider: "auto",
	limit: 5,
	includeDomains: [],
	excludeDomains: [],
};

test("auto 跳过未配置 instance，并按 route 回退到下一 provider", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["tavily", "brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				web: {
					results: [
						{
							title: "Brave result",
							url: "https://example.com/result",
							description: "snippet",
						},
					],
				},
			}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, true);
		if (!envelope.ok || envelope.command !== "search") return;
		assert.equal(envelope.provider.id, "brave");
		assert.deepEqual(
			envelope.attempts.map((attempt) => attempt.status),
			["failed", "success"],
		);
		assert.equal(envelope.attempts[0]?.error?.code, "provider_unavailable");
	} finally {
		fixture.cleanup();
	}
});

test("显式 provider 严格执行，不触发 fallback", async () => {
	const fixture = loadedConfig({
		search: { providers: ["tavily", "brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() => response({ results: [] }));
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "tavily" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_unavailable");
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(transport.calls.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("auto 全部失败时返回 provider_exhausted 与最佳 partial", async () => {
	const fixture = loadedConfig({
		search: { providers: [] },
		extract: {
			providers: ["http"],
			minContentCharacters: 100,
		},
	});
	const request: ExtractRequest = {
		url: "https://example.com/short",
		provider: "auto",
	};
	try {
		const transport = new MockTransport(() =>
			response("太短的正文", { contentType: "text/plain" }),
		);
		const envelope = await executeExtract(request, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.partial?.provider.id, "http");
		assert.equal(envelope.partial?.data.document.content, "太短的正文");
		assert.equal(envelope.raw, "太短的正文");
	} finally {
		fixture.cleanup();
	}
});

test("route 外的显式 instance 返回 provider_disabled", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "key" },
			{ id: "brave_backup", type: "brave", apiKey: "backup-key" },
		],
		search: { providers: ["brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "brave_backup" },
			{
				loaded: fixture.loaded,
				transport: new MockTransport(() => response({ web: { results: [] } })),
			},
		);
		assert.equal(envelope.ok, false);
		if (!envelope.ok) assert.equal(envelope.error.code, "provider_disabled");
	} finally {
		fixture.cleanup();
	}
});

test("AnySearch 402 自动注册响应在 envelope 中递归脱敏", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "anysearch", type: "anysearch" }],
		search: { providers: ["anysearch"] },
		extract: { providers: ["http"] },
	});
	const transport = new MockTransport(() =>
		response(
			{
				code: 402,
				message: "quota",
				auto_registered: {
					username: "user@example.com",
					password: "secret-password",
					api_key: "response-key",
				},
			},
			{ status: 200 },
		),
	);
	try {
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "auto" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(
			serialized,
			/secret-password|response-key|user@example.com/,
		);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.error?.code, "quota_exceeded");
	} finally {
		fixture.cleanup();
	}
});

test("XCrawl 失败响应和错误消息在 envelope 中脱敏", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "xcrawl", type: "xcrawl", apiKey: "xcrawl-secret" }],
		search: { providers: ["xcrawl"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				status: "failed",
				message: "upstream rejected xcrawl-secret",
				api_key: "response-secret",
			}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(serialized, /xcrawl-secret|response-secret/);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.error?.code, "provider_error");
	} finally {
		fixture.cleanup();
	}
});

test("auto 仅在前序失败后调用 DeepSeek", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "brave-key" },
			{ id: "deepseek", type: "deepseek", apiKey: "deepseek-key" },
		],
		search: { providers: ["brave", "deepseek"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("search.brave.com"))
				return response({ error: "temporary" }, { status: 500 });
			return response({
				content: [
					{
						type: "web_search_tool_result",
						content: [
							{
								type: "web_search_result",
								title: "DeepSeek result",
								url: "https://example.com/deepseek",
								encrypted_content: "opaque-provider-payload",
							},
						],
					},
				],
			});
		});
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, true);
		if (!envelope.ok || envelope.command !== "search") return;
		assert.equal(envelope.provider.id, "deepseek");
		assert.doesNotMatch(
			JSON.stringify(envelope.raw),
			/encrypted_content|opaque-provider-payload/,
		);
		assert.deepEqual(
			envelope.attempts.map((attempt) => [attempt.provider.id, attempt.status]),
			[
				["brave", "failed"],
				["deepseek", "success"],
			],
		);
		assert.equal(transport.calls.length, 2);
	} finally {
		fixture.cleanup();
	}
});

test("auto 对最终非 2xx HTTP 响应切换到下一 provider", async (t) => {
	const cases = [
		{ status: 302, code: "provider_error", retryable: false },
		{ status: 401, code: "auth_error", retryable: false },
		{ status: 404, code: "provider_error", retryable: false },
		{ status: 500, code: "provider_error", retryable: true },
	] as const;
	for (const item of cases) {
		await t.test(String(item.status), async () => {
			const fixture = loadedConfig({
				providers: [
					{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
					{ id: "brave", type: "brave", apiKey: "brave-key" },
				],
				search: { providers: ["tavily", "brave"] },
				extract: { providers: [] },
			});
			try {
				const transport = new MockTransport((url) => {
					if (url.includes("tavily"))
						return response(
							{ error: `tavily failed with ${item.status}` },
							{ status: item.status },
						);
					return response({
						web: {
							results: [
								{
									title: "Brave fallback",
									url: "https://example.com/fallback",
									description: "fallback succeeded",
								},
							],
						},
					});
				});
				const envelope = await executeSearch(searchRequest, {
					loaded: fixture.loaded,
					transport,
				});
				assert.equal(envelope.ok, true);
				if (!envelope.ok || envelope.command !== "search") return;
				assert.equal(envelope.provider.id, "brave");
				assert.equal(transport.calls.length, 2);
				assert.deepEqual(
					envelope.attempts.map((attempt) => [
						attempt.provider.id,
						attempt.status,
					]),
					[
						["tavily", "failed"],
						["brave", "success"],
					],
				);
				assert.equal(envelope.attempts[0]?.error?.code, item.code);
				assert.equal(envelope.attempts[0]?.error?.httpStatus, item.status);
				assert.equal(envelope.attempts[0]?.error?.retryable, item.retryable);
			} finally {
				fixture.cleanup();
			}
		});
	}
});

test("extract auto 在前序 provider 返回非 2xx 后继续 route", async () => {
	const fixture = loadedConfig({
		search: { providers: [] },
		extract: {
			providers: ["jina", "http"],
			minContentCharacters: 5,
		},
	});
	try {
		const transport = new MockTransport((_url) => {
			if (transport.calls.length === 1)
				return response({ error: "jina forbidden" }, { status: 403 });
			return response("后备 HTTP provider 返回的有效正文", {
				contentType: "text/plain; charset=utf-8",
			});
		});
		const envelope = await executeExtract(
			{ url: "https://example.com/article", provider: "auto" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, true);
		if (!envelope.ok || envelope.command !== "extract") return;
		assert.equal(envelope.provider.id, "http");
		assert.equal(envelope.attempts[0]?.error?.code, "auth_error");
		assert.equal(envelope.attempts[0]?.error?.retryable, false);
		assert.equal(transport.calls.length, 2);
	} finally {
		fixture.cleanup();
	}
});

test("auto 因非 2xx 耗尽 route 时返回 provider_exhausted", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
			{ id: "brave", type: "brave", apiKey: "brave-key" },
		],
		search: { providers: ["tavily", "brave"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({ error: "credential rejected" }, { status: 401 }),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.error.retryable, false);
		assert.equal(envelope.attempts?.length, 2);
		assert.deepEqual(
			envelope.attempts?.map((attempt) => [
				attempt.error?.code,
				attempt.error?.httpStatus,
				attempt.error?.retryable,
			]),
			[
				["auth_error", 401, false],
				["auth_error", 401, false],
			],
		);
		assert.equal(
			(
				envelope.error.details as {
					lastError?: {
						code?: string;
						httpStatus?: number;
						retryable?: boolean;
					};
				}
			)?.lastError?.code,
			"auth_error",
		);
		assert.equal(transport.calls.length, 2);
	} finally {
		fixture.cleanup();
	}
});

test("显式 provider 的非 2xx 响应不触发 fallback", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
			{ id: "brave", type: "brave", apiKey: "brave-key" },
		],
		search: { providers: ["tavily", "brave"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({ error: "credential rejected" }, { status: 401 }),
		);
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "tavily" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "auth_error");
		assert.equal(envelope.error.retryable, false);
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("auto 不扩大 HTTP 2xx 内嵌业务错误的回退范围", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["anysearch", "brave"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({ code: 401, message: "business auth failure" }),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "auth_error");
		assert.equal(envelope.error.retryable, false);
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(envelope.attempts?.[0]?.provider.id, "anysearch");
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("auto 在前序成功时不调用 DeepSeek", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "brave-key" },
			{ id: "deepseek", type: "deepseek", apiKey: "deepseek-key" },
		],
		search: { providers: ["brave", "deepseek"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				web: {
					results: [
						{
							title: "Brave result",
							url: "https://example.com/brave",
							description: "first provider succeeded",
						},
					],
				},
			}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, true);
		if (!envelope.ok || envelope.command !== "search") return;
		assert.equal(envelope.provider.id, "brave");
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("DeepSeek 缺 key 时在 auto 中记录 unavailable 且不发请求", async () => {
	const fixture = loadedConfig({
		search: { providers: ["deepseek"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() => response({ content: [] }));
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.provider.id, "deepseek");
		assert.equal(envelope.attempts?.[0]?.error?.code, "provider_unavailable");
		assert.equal(transport.calls.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("DeepSeek failure raw 与 envelope 不泄漏 API key", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "deepseek", type: "deepseek", apiKey: "deepseek-secret" },
		],
		search: { providers: ["deepseek"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				content: [{ type: "text", text: "rejected deepseek-secret" }],
				api_key: "response-secret",
			}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(serialized, /deepseek-secret|response-secret/);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.error?.code, "provider_error");
	} finally {
		fixture.cleanup();
	}
});
