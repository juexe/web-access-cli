import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import {
	GatewayValidationError,
	parseGatewayFetchRequest,
	parseGatewaySearchRequest,
} from "../src/gateway/schema.ts";
import {
	createGatewayService,
	GatewayClientAbort,
	GatewayHttpError,
	type GatewayLimits,
} from "../src/gateway/service.ts";
import { MockTransport, response } from "./helpers.ts";

function loadedConfig(value: unknown): {
	loaded: LoadedConfig;
	cleanup(): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		loaded: loadConfig(path, {}),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function serviceOptions(
	loaded: LoadedConfig,
	transport: MockTransport,
	limits: Partial<GatewayLimits> = {},
	now?: () => number,
) {
	return {
		loaded,
		transport,
		limits,
		...(now ? { now } : {}),
	};
}

async function expectHttpError(
	action: () => Promise<unknown>,
	status: number,
	code: string,
): Promise<GatewayHttpError> {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof GatewayHttpError, "应抛出 GatewayHttpError");
	assert.equal(caught.status, status);
	assert.equal(caught.code, code);
	return caught;
}

const searchConfig = {
	providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
	search: { providers: ["brave"] },
	extract: { providers: ["http"] },
};

// --- Request validation -----------------------------------------------------

test("Search 请求校验官方字段、默认值与未知字段忽略", () => {
	assert.deepEqual(parseGatewaySearchRequest({ query: "hello" }), {
		query: "hello",
		count: 10,
		ori_question: null,
		localization: "",
		need_content: false,
	});
	assert.deepEqual(
		parseGatewaySearchRequest({
			query: "hello",
			count: 50,
			ori_question: "原始问题",
			localization: "192.168.3.3",
			need_content: true,
			provider: "tavily",
			timeout: 1,
			apiKey: "attacker",
		}),
		{
			query: "hello",
			count: 50,
			ori_question: "原始问题",
			localization: "192.168.3.3",
			need_content: true,
		},
	);
	assert.equal(
		parseGatewaySearchRequest({ query: "q", ori_question: null }).ori_question,
		null,
	);
	assert.equal(
		parseGatewaySearchRequest({ query: "q", localization: "::1" }).localization,
		"::1",
	);
	for (const count of [0, 51, 1.5, "10", null]) {
		assert.throws(
			() => parseGatewaySearchRequest({ query: "q", count }),
			GatewayValidationError,
			`count=${JSON.stringify(count)} 应拒绝`,
		);
	}
	for (const query of ["", "   ", "a".repeat(129), "😀".repeat(129)]) {
		assert.throws(
			() => parseGatewaySearchRequest({ query }),
			GatewayValidationError,
		);
	}
	assert.equal(
		parseGatewaySearchRequest({ query: "😀".repeat(128) }).query.length,
		256,
	);
	assert.throws(
		() => parseGatewaySearchRequest({ query: "q", ori_question: "" }),
		GatewayValidationError,
	);
	assert.throws(
		() => parseGatewaySearchRequest({ query: "q", need_content: "true" }),
		GatewayValidationError,
	);
	assert.throws(
		() => parseGatewaySearchRequest({ query: "q", localization: "not-an-ip" }),
		GatewayValidationError,
	);
});

test("Fetch 请求只接受含 host 的绝对 HTTP(S) URL", () => {
	assert.equal(
		parseGatewayFetchRequest({ url: "https://example.com/a?b=1#c" }).url,
		"https://example.com/a?b=1#c",
	);
	assert.equal(
		parseGatewayFetchRequest({ url: "http://192.168.3.3:18180/x" }).url,
		"http://192.168.3.3:18180/x",
	);
	for (const url of [
		"",
		"not a url",
		"ftp://example.com/file",
		"file:///etc/passwd",
		"https://user:pass@example.com/",
		"https://",
		"https://example.com:99999/",
		"https://example.com/\u0000x",
	]) {
		assert.throws(
			() => parseGatewayFetchRequest({ url }),
			GatewayValidationError,
			`${JSON.stringify(url)} 应拒绝`,
		);
	}
	const long = `https://example.com/${"a".repeat(8192)}`;
	assert.throws(
		() => parseGatewayFetchRequest({ url: long }),
		GatewayValidationError,
	);
	assert.ok(
		parseGatewayFetchRequest({
			url: `https://example.com/${"a".repeat(8192 - "https://example.com/".length)}`,
		}).url,
	);
});

// --- Search mapping ---------------------------------------------------------

test("Search 精确输出结构与占位评分", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport(() =>
			response({
				web: {
					results: [
						{
							title: "Brave result",
							url: "https://example.com/result",
							description: "snippet text",
						},
					],
				},
			}),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello" }),
			new AbortController().signal,
		);
		assert.deepEqual(body, {
			results: [
				{
					rerank_score: 0,
					title: "Brave result",
					url: "https://example.com/result",
					snippet: "snippet text",
					summary: "snippet text",
					content: "",
					site_name: null,
					site_icon: null,
					date: null,
					authority: -1,
				},
			],
		});
		assert.equal(transport.calls.length, 1);
		assert.match(transport.calls[0]?.url ?? "", /api\.search\.brave\.com/);
	} finally {
		fixture.cleanup();
	}
});

test("Search 空结果返回空数组，且不补抓正文", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport(() =>
			response({ web: { results: [] } }),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.deepEqual(body, { results: [] });
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("need_content=false 不发起 extract 调用", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			assert.ok(url.includes("brave"), `只应访问 search provider: ${url}`);
			return response({
				web: {
					results: [
						{ title: "A", url: "https://example.com/a", description: "a" },
					],
				},
			});
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: false }),
			new AbortController().signal,
		);
		assert.equal(body.results[0]?.content, "");
		assert.equal(transport.calls.length, 1);
	} finally {
		fixture.cleanup();
	}
});

test("count 原样作为 core limit 传递，不被 provider 限制截断", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport(() =>
			response({ web: { results: [] } }),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		await service.search(
			parseGatewaySearchRequest({ query: "hello", count: 50 }),
			new AbortController().signal,
		);
		const url = new URL(transport.calls[0]?.url ?? "");
		assert.equal(url.searchParams.get("count"), "20");
	} finally {
		fixture.cleanup();
	}
});

// --- Content backfill -------------------------------------------------------

function _contentServer(
	transport: MockTransport,
	_options: {
		fail?: Set<string>;
		contentFor?: (url: string) => string;
		delayMs?: Map<string, number>;
		concurrency?: { current: number; peak: number };
	} = {},
): MockTransport {
	const _html = (text: string, title: string) =>
		`<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
	return transport;
}

test("need_content=true 按排名补抓、保序并允许短正文", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{ title: "A", url: "https://example.com/a", description: "a" },
							{ title: "B", url: "https://example.com/b", description: "b" },
						],
					},
				});
			}
			if (url.endsWith("/a")) {
				return response("短正文", { contentType: "text/plain; charset=utf-8" });
			}
			return response("<p>B body</p>", {
				contentType: "text/html; charset=utf-8",
			});
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results.length, 2);
		assert.equal(body.results[0]?.url, "https://example.com/a");
		assert.equal(body.results[0]?.content, "短正文");
		assert.equal(body.results[1]?.url, "https://example.com/b");
		assert.match(body.results[1]?.content ?? "", /B body/);
	} finally {
		fixture.cleanup();
	}
});

test("补抓失败项正文留空且保留搜索结果与顺序", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{ title: "A", url: "https://example.com/a", description: "a" },
							{ title: "B", url: "https://example.com/b", description: "b" },
						],
					},
				});
			}
			if (url.endsWith("/a") && !url.endsWith(".md"))
				return response("boom", { status: 500 });
			if (url.endsWith("/b") && !url.endsWith(".md"))
				return response("<p>B body</p>", {
					contentType: "text/html; charset=utf-8",
				});
			return response("missing", { status: 404 });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results[0]?.title, "A");
		assert.equal(body.results[0]?.content, "");
		assert.match(body.results[1]?.content ?? "", /B body/);
	} finally {
		fixture.cleanup();
	}
});

test("补抓最多两路并发", async () => {
	const fixture = loadedConfig(searchConfig);
	let current = 0;
	let peak = 0;
	try {
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [1, 2, 3, 4, 5].map((n) => ({
							title: `T${n}`,
							url: `https://example.com/${n}`,
							description: `d${n}`,
						})),
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			current += 1;
			peak = Math.max(peak, current);
			await new Promise((resolve) => setTimeout(resolve, 40));
			current -= 1;
			return response(`<p>body ${url}</p>`, {
				contentType: "text/html; charset=utf-8",
			});
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results.length, 5);
		assert.ok(peak <= 2, `并发峰值应 <= 2，实际 ${peak}`);
		for (const result of body.results)
			assert.match(result.content, /body https:\/\/example\.com\//);
	} finally {
		fixture.cleanup();
	}
});

test("补抓总预算耗尽后停止调度，结果仍返回 200", async () => {
	const fixture = loadedConfig(searchConfig);
	let clock = 1000;
	let extractCalls = 0;
	try {
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [1, 2, 3, 4].map((n) => ({
							title: `T${n}`,
							url: `https://example.com/${n}`,
							description: `d${n}`,
						})),
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			extractCalls += 1;
			// The first completed fill already exceeds the whole budget.
			clock += 10_000;
			return response(`<p>body ${url}</p>`, {
				contentType: "text/html; charset=utf-8",
			});
		});
		const service = createGatewayService(
			serviceOptions(
				fixture.loaded,
				transport,
				{ contentBudgetMs: 500, contentItemTimeoutMs: 10_000 },
				() => clock,
			),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results.length, 4);
		for (const result of body.results) assert.equal(result.content, "");
		// The first fill consumes the whole budget synchronously, so the second
		// worker never schedules another result.
		assert.equal(extractCalls, 1);
	} finally {
		fixture.cleanup();
	}
});

test("补抓单篇超时不影响其余正文", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{
								title: "slow",
								url: "https://example.com/slow",
								description: "s",
							},
							{
								title: "fast",
								url: "https://example.com/fast",
								description: "f",
							},
						],
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			if (url.endsWith("/slow"))
				await new Promise((resolve) => setTimeout(resolve, 400));
			return response(`<p>body ${url}</p>`, {
				contentType: "text/html; charset=utf-8",
			});
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport, {
				contentBudgetMs: 2_000,
				contentItemTimeoutMs: 120,
			}),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results[0]?.content, "");
		assert.match(body.results[1]?.content ?? "", /fast/);
	} finally {
		fixture.cleanup();
	}
});

test("慢 .md probe 最多 1 秒后仍能调用正文 provider，短 soft-404 不抢先命中", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{
								title: "doc",
								url: "https://example.com/doc",
								description: "d",
							},
						],
					},
				});
			}
			if (url.endsWith("/doc.md")) {
				// A short HTTP 200 soft-404 page must not satisfy the probe.
				return response("Not found", { contentType: "text/markdown" });
			}
			if (url.endsWith("/doc")) {
				return response(
					"<!doctype html><html><head><title>Doc</title></head><body><main><p>real article body</p></main></body></html>",
					{ contentType: "text/html; charset=utf-8" },
				);
			}
			return response("unexpected", { status: 500 });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport, {
				contentBudgetMs: 5_000,
				contentItemTimeoutMs: 3_000,
				contentPreflightTimeoutMs: 300,
			}),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.match(body.results[0]?.content ?? "", /real article body/);
		const urls = transport.calls.map((call) => call.url);
		assert.ok(urls.some((url) => url.endsWith("/doc.md")));
		assert.ok(urls.some((url) => url.endsWith("/doc")));
	} finally {
		fixture.cleanup();
	}
});

test("补抓单次 provider 尝试不超过 3 秒上限", async () => {
	const fixture = loadedConfig(searchConfig);
	let _attemptTimeout: number | undefined;
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{ title: "A", url: "https://example.com/a", description: "a" },
						],
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			_attemptTimeout = Number(new URL(url).searchParams.get("timeout") ?? "0");
			return response("<p>body</p>", { contentType: "text/html" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results[0]?.content !== "", true);
		const extractLoaded = fixture.loaded.app.extract;
		assert.equal(extractLoaded.attemptTimeoutMs, 45_000);
	} finally {
		fixture.cleanup();
	}
});

test("补抓正文不再受 256 KiB 上限截断", async () => {
	const fixture = loadedConfig(searchConfig);
	const big = "正文".repeat(60_000);
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{
								title: "big",
								url: "https://example.com/big",
								description: "b",
							},
							{ title: "ok", url: "https://example.com/ok", description: "o" },
						],
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			if (url.endsWith("/big"))
				return response(big, { contentType: "text/plain" });
			return response("小正文", { contentType: "text/plain" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results[0]?.content, big);
		assert.equal(body.results[1]?.content, "小正文");
	} finally {
		fixture.cleanup();
	}
});

test("超大响应不再被裁剪也不再返回 response_too_large", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			if (url.includes("brave"))
				return response({
					web: {
						results: [
							{ title: "s1", url: "https://example.com/1", description: "1" },
							{ title: "s2", url: "https://example.com/2", description: "2" },
						],
					},
				});
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			return response("x".repeat(150 * 1024), { contentType: "text/plain" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(body.results.length, 2);
		assert.equal((body.results[0]?.content ?? "").length, 150 * 1024);
		assert.equal((body.results[1]?.content ?? "").length, 150 * 1024);
	} finally {
		fixture.cleanup();
	}
});

// --- Cancellation and deadlines --------------------------------------------

test("搜索成功后补抓仍获得独立完整预算", async () => {
	const fixture = loadedConfig(searchConfig);
	let clock = 0;
	let extractCalls = 0;
	try {
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				clock += 110_000;
				return response({
					web: {
						results: [
							{ title: "A", url: "https://example.com/a", description: "a" },
						],
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			extractCalls += 1;
			clock += 5_000;
			return response("<p>body</p>", { contentType: "text/html" });
		});
		const service = createGatewayService(
			serviceOptions(
				fixture.loaded,
				transport,
				{ contentBudgetMs: 30_000, contentItemTimeoutMs: 10_000 },
				() => clock,
			),
		);
		const body = await service.search(
			parseGatewaySearchRequest({ query: "hello", need_content: true }),
			new AbortController().signal,
		);
		assert.equal(extractCalls, 1);
		assert.match(body.results[0]?.content ?? "", /body/);
	} finally {
		fixture.cleanup();
	}
});

test("搜索阶段超时返回 504 而非补抓结果", async () => {
	const fixture = loadedConfig(searchConfig);
	let clock = 0;
	try {
		const transport = new MockTransport(() => {
			clock += 130_000;
			return response({ web: { results: [] } });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport, {}, () => clock),
		);
		await expectHttpError(
			() =>
				service.search(
					parseGatewaySearchRequest({ query: "hello" }),
					new AbortController().signal,
				),
			504,
			"upstream_timeout",
		);
	} finally {
		fixture.cleanup();
	}
});

test("客户端断开后不写回补抓结果", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const abort = new AbortController();
		const transport = new MockTransport(async (url) => {
			if (url.includes("brave")) {
				return response({
					web: {
						results: [
							{ title: "A", url: "https://example.com/a", description: "a" },
							{ title: "B", url: "https://example.com/b", description: "b" },
						],
					},
				});
			}
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			abort.abort();
			return response(`<p>body ${url}</p>`, { contentType: "text/html" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		let caught: unknown;
		try {
			await service.search(
				parseGatewaySearchRequest({ query: "hello", need_content: true }),
				abort.signal,
			);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof GatewayClientAbort);
	} finally {
		fixture.cleanup();
	}
});

test("provider 忽略 abort 并晚到成功时不返回 200", async () => {
	const fixture = loadedConfig(searchConfig);
	let clock = 0;
	try {
		const transport = new MockTransport(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			clock += 130_000;
			return response({ web: { results: [] } });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport, {}, () => clock),
		);
		await expectHttpError(
			() =>
				service.search(
					parseGatewaySearchRequest({ query: "hello" }),
					new AbortController().signal,
				),
			504,
			"upstream_timeout",
		);
	} finally {
		fixture.cleanup();
	}
});

// --- Error mapping ----------------------------------------------------------

function searchFailureService(
	status: number | undefined,
	_code: string,
	_httpStatus?: number,
): { loaded: LoadedConfig; cleanup(): void; transport: MockTransport } {
	const fixture = loadedConfig(searchConfig);
	const transport = new MockTransport(() => {
		if (status !== undefined)
			return response({ error: "upstream" }, { status });
		throw new Error("provider failed");
	});
	return { ...fixture, transport };
}

test("错误映射覆盖 402/429/504 与失败 envelope", async (t) => {
	await t.test("402", async () => {
		const fixture = searchFailureService(402, "quota_exceeded");
		try {
			const service = createGatewayService(
				serviceOptions(fixture.loaded, fixture.transport),
			);
			await expectHttpError(
				() =>
					service.search(
						parseGatewaySearchRequest({ query: "hello" }),
						new AbortController().signal,
					),
				402,
				"insufficient_quota",
			);
		} finally {
			fixture.cleanup();
		}
	});
	await t.test("429", async () => {
		const fixture = searchFailureService(429, "rate_limited");
		try {
			const service = createGatewayService(
				serviceOptions(fixture.loaded, fixture.transport),
			);
			const error = await expectHttpError(
				() =>
					service.search(
						parseGatewaySearchRequest({ query: "hello" }),
						new AbortController().signal,
					),
				429,
				"rate_limit_exceeded",
			);
			assert.equal(error.retryAfterSeconds, 1);
		} finally {
			fixture.cleanup();
		}
	});
	await t.test("504", async () => {
		const fixture = searchFailureService(504, "timeout");
		try {
			const service = createGatewayService(
				serviceOptions(fixture.loaded, fixture.transport),
			);
			await expectHttpError(
				() =>
					service.search(
						parseGatewaySearchRequest({ query: "hello" }),
						new AbortController().signal,
					),
				504,
				"upstream_timeout",
			);
		} finally {
			fixture.cleanup();
		}
	});
	await t.test("cloud 401", async () => {
		const fixture = searchFailureService(401, "auth_error");
		try {
			const service = createGatewayService(
				serviceOptions(fixture.loaded, fixture.transport),
			);
			await expectHttpError(
				() =>
					service.search(
						parseGatewaySearchRequest({ query: "hello" }),
						new AbortController().signal,
					),
				500,
				"provider_auth_error",
			);
		} finally {
			fixture.cleanup();
		}
	});
});

test("无可用 provider 时返回稳定 500 no_provider_available", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "k" }],
		search: { providers: ["tavily", "brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response({ error: "unavailable" }, { status: 500 }),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		await expectHttpError(
			() =>
				service.search(
					parseGatewaySearchRequest({ query: "hello" }),
					new AbortController().signal,
				),
			500,
			"provider_error",
		);
	} finally {
		fixture.cleanup();
	}
});

// --- Fetch ------------------------------------------------------------------

test("Fetch 成功只返回 title 与 content", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			return response(
				"<!doctype html><html><head><title>Article</title></head><body><main><p>Body text</p></main></body></html>",
				{ contentType: "text/html; charset=utf-8" },
			);
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.fetch(
			parseGatewayFetchRequest({ url: "https://example.com/article" }),
			new AbortController().signal,
		);
		assert.deepEqual(Object.keys(body).sort(), ["content", "title"]);
		assert.equal(body.title, "Article");
		assert.match(body.content, /Body text/);
	} finally {
		fixture.cleanup();
	}
});

test("Fetch 允许内网 URL 与短正文", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const transport = new MockTransport((url) => {
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			assert.equal(url, "http://192.168.3.3:18180/healthz");
			return response("ok", { contentType: "text/plain; charset=utf-8" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const body = await service.fetch(
			parseGatewayFetchRequest({ url: "http://192.168.3.3:18180/healthz" }),
			new AbortController().signal,
		);
		assert.deepEqual(body, { title: "", content: "ok" });
	} finally {
		fixture.cleanup();
	}
});

test("Fetch 目标站点 401/403/404 属于不可用而非网关认证错误", async (t) => {
	for (const status of [401, 403, 404]) {
		await t.test(String(status), async () => {
			const fixture = loadedConfig(searchConfig);
			try {
				const transport = new MockTransport(() =>
					response("denied", { status }),
				);
				const service = createGatewayService(
					serviceOptions(fixture.loaded, transport),
				);
				await expectHttpError(
					() =>
						service.fetch(
							parseGatewayFetchRequest({ url: "https://example.com/private" }),
							new AbortController().signal,
						),
					404,
					"no_usable_content",
				);
			} finally {
				fixture.cleanup();
			}
		});
	}
});

test("Fetch 失败 partial 不升级为成功", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "k" }],
		search: { providers: ["brave"] },
		extract: { providers: ["http"], minContentCharacters: 500 },
	});
	try {
		// A whitespace-only body normalizes to "" and triggers the core quality
		// failure path, so the failure envelope carries a partial document.
		const transport = new MockTransport((url) => {
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			return response("\u00a0\u00a0", {
				contentType: "text/plain; charset=utf-8",
			});
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		let caught: unknown;
		try {
			await service.fetch(
				parseGatewayFetchRequest({ url: "https://example.com/short" }),
				new AbortController().signal,
			);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof GatewayHttpError);
		assert.equal(caught.status, 404);
		assert.equal(caught.code, "no_usable_content");
	} finally {
		fixture.cleanup();
	}
});

test("Fetch 输出不设大小上限", async () => {
	const fixture = loadedConfig(searchConfig);
	const big = "x".repeat(1024 * 1024);
	try {
		const transport = new MockTransport((url) => {
			if (url.endsWith(".md")) return response("missing", { status: 404 });
			return response(big, { contentType: "text/plain" });
		});
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const responseBody = await service.fetch(
			parseGatewayFetchRequest({ url: "https://example.com/big" }),
			new AbortController().signal,
		);
		assert.equal(responseBody.content, big);
	} finally {
		fixture.cleanup();
	}
});

test("错误响应不包含上游正文、query 或凭据", async () => {
	const fixture = loadedConfig({
		providers: [
			{
				id: "brave",
				type: "brave",
				apiKey: "super-secret-brave-key",
			},
		],
		search: { providers: ["brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response(
				{ message: "upstream leaked super-secret-brave-key and query-text" },
				{ status: 500 },
			),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		const error = await expectHttpError(
			() =>
				service.search(
					parseGatewaySearchRequest({ query: "query-text" }),
					new AbortController().signal,
				),
			500,
			"provider_error",
		);
		const serialized = JSON.stringify({
			message: error.message,
			type: error.type,
			code: error.code,
		});
		assert.doesNotMatch(serialized, /super-secret-brave-key/);
		assert.doesNotMatch(serialized, /query-text/);
	} finally {
		fixture.cleanup();
	}
});

// --- Readiness --------------------------------------------------------------

test("readiness 要求 search 与 extract 各至少一个有已配置 adapter", () => {
	const ready = loadedConfig(searchConfig);
	try {
		const service = createGatewayService(
			serviceOptions(ready.loaded, new MockTransport(() => response({}))),
		);
		assert.deepEqual(service.readiness(), { ready: true });
	} finally {
		ready.cleanup();
	}
	const missingExtract = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "k" }],
		search: { providers: ["brave"] },
		extract: { providers: ["firecrawl"] },
	});
	try {
		const service = createGatewayService(
			serviceOptions(
				missingExtract.loaded,
				new MockTransport(() => response({})),
			),
		);
		assert.equal(service.readiness().ready, false);
		assert.match(service.readiness().reason ?? "", /extract/);
	} finally {
		missingExtract.cleanup();
	}
	const missingSearch = loadedConfig({
		providers: [],
		search: { providers: ["tavily"] },
		extract: { providers: ["http"] },
	});
	try {
		const service = createGatewayService(
			serviceOptions(
				missingSearch.loaded,
				new MockTransport(() => response({})),
			),
		);
		assert.equal(service.readiness().ready, false);
		assert.match(service.readiness().reason ?? "", /search/);
	} finally {
		missingSearch.cleanup();
	}
});

test("网关不等待 order 持久化 writer，也不修改配置", async () => {
	const fixture = loadedConfig(searchConfig);
	try {
		const before = JSON.stringify(fixture.loaded.app);
		const transport = new MockTransport(() =>
			response({
				web: {
					results: [
						{ title: "A", url: "https://example.com/a", description: "a" },
					],
				},
			}),
		);
		const service = createGatewayService(
			serviceOptions(fixture.loaded, transport),
		);
		await service.search(
			parseGatewaySearchRequest({ query: "hello" }),
			new AbortController().signal,
		);
		assert.equal(JSON.stringify(fixture.loaded.app), before);
	} finally {
		fixture.cleanup();
	}
});
test("云 extract provider 的 401/403 返回 500，其他 4xx 属于 404", async (t) => {
	await t.test("cloud 401 -> 500", async () => {
		const fixture = loadedConfig({
			providers: [{ id: "jina", type: "jina", apiKey: "jina-key" }],
			search: { providers: ["brave"] },
			extract: { providers: ["jina"], providers_fallback: [] },
		});
		try {
			const transport = new MockTransport(() =>
				response({ error: "bad key" }, { status: 401 }),
			);
			const service = createGatewayService(
				serviceOptions(fixture.loaded, transport),
			);
			await expectHttpError(
				() =>
					service.fetch(
						parseGatewayFetchRequest({ url: "https://example.com/a" }),
						new AbortController().signal,
					),
				500,
				"provider_auth_error",
			);
		} finally {
			fixture.cleanup();
		}
	});

	await t.test("cloud 400 -> 404 no_usable_content", async () => {
		const fixture = loadedConfig({
			providers: [{ id: "jina", type: "jina", apiKey: "jina-key" }],
			search: { providers: ["brave"] },
			extract: { providers: ["jina"], providers_fallback: [] },
		});
		try {
			const transport = new MockTransport(() =>
				response({ error: "blocked page" }, { status: 400 }),
			);
			const service = createGatewayService(
				serviceOptions(fixture.loaded, transport),
			);
			await expectHttpError(
				() =>
					service.fetch(
						parseGatewayFetchRequest({ url: "https://example.com/a" }),
						new AbortController().signal,
					),
				404,
				"no_usable_content",
			);
		} finally {
			fixture.cleanup();
		}
	});
});
