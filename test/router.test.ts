import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import { executeExtract, executeSearch } from "../src/core/router.ts";
import type {
	ExtractRequest,
	OutputEnvelope,
	ProviderOrderUpdate,
	SearchRequest,
} from "../src/core/types.ts";
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

function hasProvider(
	envelope: OutputEnvelope,
): envelope is Extract<OutputEnvelope, { provider: unknown }> {
	return envelope.ok && "provider" in envelope;
}

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
			debug: true,
		});
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "brave");
		assert.deepEqual(
			envelope.debug?.attempts.map((attempt) => attempt.status),
			["failed", "success"],
		);
		assert.equal(
			envelope.debug?.attempts[0]?.error?.code,
			"provider_unavailable",
		);
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
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "provider_unavailable");
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(transport.calls.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("auto 全部失败时返回 provider_exhausted 与最佳 partial", async () => {
	const fixture = loadedConfig({
		search: { providers: ["tavily"] },
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
			debug: true,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.partial?.provider, "http");
		assert.equal(envelope.partial?.data.document.content, "太短的正文");
		assert.equal(envelope.debug?.raw, "太短的正文");
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
			{ loaded: fixture.loaded, transport, debug: true },
		);
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(
			serialized,
			/secret-password|response-key|user@example.com/,
		);
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.code, "quota_exceeded");
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
			debug: true,
		});
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(serialized, /xcrawl-secret|response-secret/);
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.attempts?.[0]?.code, "provider_error");
	} finally {
		fixture.cleanup();
	}
});

test("auto 对最终非 2xx HTTP 响应切换到下一 provider", async (t) => {
	const cases = [
		{ status: 401, code: "auth_error", retryable: false },
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
					debug: true,
				});
				assert.equal(envelope.ok, true);
				if (!hasProvider(envelope)) return;
				assert.equal(envelope.provider, "brave");
				assert.equal(transport.calls.length, 2);
				assert.deepEqual(
					envelope.debug?.attempts.map((attempt) => [
						attempt.provider.id,
						attempt.status,
					]),
					[
						["tavily", "failed"],
						["brave", "success"],
					],
				);
				assert.equal(envelope.debug?.attempts[0]?.error?.code, item.code);
				assert.equal(
					envelope.debug?.attempts[0]?.error?.httpStatus,
					item.status,
				);
				assert.equal(
					envelope.debug?.attempts[0]?.error?.retryable,
					item.retryable,
				);
			} finally {
				fixture.cleanup();
			}
		});
	}
});

test("Bocha HTTP 403 记录 quota_exceeded 并自动回退", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "bocha", type: "bocha", apiKey: "bocha-key" },
			{ id: "brave", type: "brave", apiKey: "brave-key" },
		],
		search: { providers: ["bocha", "brave"] },
		extract: { providers: [] },
	});
	try {
		const transport = new MockTransport((url) =>
			url.includes("bocha")
				? response({ msg: "quota exhausted" }, { status: 403 })
				: response({
						web: {
							results: [
								{
									title: "Brave fallback",
									url: "https://example.com/fallback",
									description: "fallback succeeded",
								},
							],
						},
					}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
			debug: true,
		});
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "brave");
		assert.equal(envelope.debug?.attempts[0]?.error?.code, "quota_exceeded");
		assert.equal(envelope.debug?.attempts[0]?.error?.httpStatus, 403);
		assert.equal(envelope.debug?.attempts[0]?.error?.retryable, false);
		assert.equal(transport.calls.length, 2);
	} finally {
		fixture.cleanup();
	}
});

test("extract auto 在前序 provider 返回非 2xx 后继续 route", async () => {
	const fixture = loadedConfig({
		search: { providers: ["tavily"] },
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
			{ loaded: fixture.loaded, transport, debug: true },
		);
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "http");
		assert.equal(envelope.debug?.attempts[0]?.error?.code, "auth_error");
		assert.equal(envelope.debug?.attempts[0]?.error?.retryable, false);
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
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.error.retryable, false);
		assert.equal(envelope.attempts?.length, 2);
		assert.deepEqual(
			envelope.attempts?.map((attempt) => [attempt.code, attempt.httpStatus]),
			[
				["auth_error", 401],
				["auth_error", 401],
			],
		);
		assert.equal("details" in envelope.error, false);
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
		if (envelope.ok || "command" in envelope) return;
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
	let writes = 0;
	try {
		const transport = new MockTransport(() =>
			response({ code: 401, message: "business auth failure" }),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
			persistProviderOrder: async () => {
				writes += 1;
			},
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "auth_error");
		assert.equal(envelope.error.retryable, false);
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(envelope.attempts?.[0]?.provider, "anysearch");
		assert.equal(transport.calls.length, 1);
		assert.equal(writes, 0);
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
		search: { providers: ["brave"], providers_fallback: ["deepseek"] },
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
			debug: true,
		});
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "brave");
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("主轮全部失败后才进入 fallback，并分别提交两组顺序", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "brave-key" },
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
		],
		search: {
			providers: ["brave"],
			providers_fallback: ["tavily"],
		},
		extract: { providers: ["http"] },
	});
	const updates: ProviderOrderUpdate[] = [];
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("api.search.brave.com"))
				return response({ error: "temporary" }, { status: 500 });
			return response({
				results: [
					{
						title: "Fallback result",
						url: "https://example.com/fallback",
						content: "fallback succeeded",
					},
				],
			});
		});
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
			debug: true,
			persistProviderOrder: async (batch) => {
				updates.push(...batch);
			},
		});
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "tavily");
		assert.deepEqual(
			envelope.debug?.attempts.map((attempt) => [
				attempt.provider.id,
				attempt.status,
			]),
			[
				["brave", "failed"],
				["tavily", "success"],
			],
		);
		assert.deepEqual(updates, [
			{
				capability: "search",
				route: "providers",
				configuredProviders: ["brave"],
				failed: ["brave"],
			},
			{
				capability: "search",
				route: "providers_fallback",
				configuredProviders: ["tavily"],
				winner: "tavily",
				failed: [],
			},
		]);
	} finally {
		fixture.cleanup();
	}
});

test("主轮不可回退错误不会调用 fallback", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "anysearch", type: "anysearch" },
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
		],
		search: {
			providers: ["anysearch"],
			providers_fallback: ["tavily"],
		},
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response({ code: 401, message: "unauthorized" }),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok || "command" in envelope) return;
		assert.equal(envelope.error.code, "auth_error");
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("显式指定 fallback provider 只执行一次", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "brave-key" },
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
		],
		search: {
			providers: ["brave"],
			providers_fallback: ["tavily"],
		},
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				results: [
					{
						title: "Explicit fallback",
						url: "https://example.com/explicit",
						content: "direct",
					},
				],
			}),
		);
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "tavily" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, true);
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("能力命令默认输出精简 envelope，debug 才包含完整诊断", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["brave"] },
		extract: { providers: [] },
	});
	const transport = new MockTransport(() =>
		response({
			web: {
				results: [
					{
						title: "Compact result",
						url: "https://example.com/compact",
						description: "compact snippet",
					},
				],
			},
		}),
	);
	try {
		const compact = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.deepEqual(Object.keys(compact).sort(), [
			"data",
			"ok",
			"provider",
			"schemaVersion",
		]);
		if (!hasProvider(compact)) return;
		assert.equal(compact.provider, "brave");
		assert.equal("raw" in compact, false);
		assert.equal("attempts" in compact, false);

		const debug = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
			debug: true,
		});
		if (!hasProvider(debug)) return;
		assert.deepEqual(Object.keys(debug).sort(), [
			"data",
			"debug",
			"ok",
			"provider",
			"schemaVersion",
		]);
		if (!debug.debug || !("query" in debug.debug.request)) return;
		assert.equal(debug.debug.request.query, "web access");
		assert.equal(debug.debug?.provider?.id, "brave");
		assert.equal(debug.debug?.attempts[0]?.status, "success");
	} finally {
		fixture.cleanup();
	}
});

test("auto 按内部顺序执行并提交稳定排序证据", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "tavily", type: "tavily", apiKey: "tavily-key" },
			{ id: "brave", type: "brave", apiKey: "brave-key" },
		],
		search: {
			providers: ["brave", "tavily"],
		},
		extract: { providers: [] },
	});
	const updates: ProviderOrderUpdate[] = [];
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("api.search.brave.com"))
				return response({ error: "temporary" }, { status: 500 });
			return response({
				results: [
					{
						title: "Tavily result",
						url: "https://example.com/tavily",
						content: "fallback succeeded",
					},
				],
			});
		});
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
			persistProviderOrder: async (batch) => {
				updates.push(...batch);
			},
		});
		assert.equal(envelope.ok, true);
		if (!hasProvider(envelope)) return;
		assert.equal(envelope.provider, "tavily");
		assert.match(transport.calls[0]?.url ?? "", /brave/);
		assert.match(transport.calls[1]?.url ?? "", /tavily/);
		assert.deepEqual(updates, [
			{
				capability: "search",
				route: "providers",
				configuredProviders: ["brave", "tavily"],
				winner: "tavily",
				failed: ["brave"],
			},
		]);
	} finally {
		fixture.cleanup();
	}
});

test("排序写回失败在成功和失败 envelope 中追加 warning", async () => {
	const successFixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["brave"] },
		extract: { providers: [] },
	});
	const failureFixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["brave"] },
		extract: { providers: [] },
	});
	const rejectWrite = async () => {
		throw new Error("read only");
	};
	try {
		const success = await executeSearch(searchRequest, {
			loaded: successFixture.loaded,
			transport: new MockTransport(() =>
				response({
					web: {
						results: [
							{
								title: "Result",
								url: "https://example.com/result",
								description: "success",
							},
						],
					},
				}),
			),
			persistProviderOrder: rejectWrite,
		});
		assert.equal(success.ok, true);
		const successWarnings =
			"warnings" in success ? success.warnings : undefined;
		assert.equal(successWarnings?.length, 1);
		assert.equal(successWarnings[0]?.code, "provider_order_update_failed");
		assert.equal(typeof successWarnings[0]?.message, "string");
		assert.ok(successWarnings[0]?.message.trim());

		const failure = await executeSearch(searchRequest, {
			loaded: failureFixture.loaded,
			transport: new MockTransport(() =>
				response({ error: "temporary" }, { status: 500 }),
			),
			persistProviderOrder: rejectWrite,
		});
		assert.equal(failure.ok, false);
		const failureWarnings =
			"warnings" in failure ? failure.warnings : undefined;
		assert.equal(failureWarnings?.length, 1);
		assert.equal(failureWarnings[0]?.code, "provider_order_update_failed");
		assert.equal(typeof failureWarnings[0]?.message, "string");
		assert.ok(failureWarnings[0]?.message.trim());
	} finally {
		successFixture.cleanup();
		failureFixture.cleanup();
	}
});

test("显式 provider 和用户取消不更新内部顺序", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["brave"] },
		extract: { providers: [] },
	});
	let writes = 0;
	const persistProviderOrder = async () => {
		writes += 1;
	};
	try {
		const explicit = await executeSearch(
			{ ...searchRequest, provider: "brave" },
			{
				loaded: fixture.loaded,
				transport: new MockTransport(() =>
					response({
						web: {
							results: [
								{
									title: "Result",
									url: "https://example.com/result",
									description: "success",
								},
							],
						},
					}),
				),
				persistProviderOrder,
			},
		);
		assert.equal(explicit.ok, true);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport: new MockTransport(() => {
				throw new DOMException("cancelled", "AbortError");
			}),
			signal: controller.signal,
			persistProviderOrder,
		});
		assert.equal(cancelled.ok, false);
		if (!cancelled.ok && !("command" in cancelled))
			assert.equal(cancelled.error.code, "aborted");
		assert.equal(writes, 0);
	} finally {
		fixture.cleanup();
	}
});
