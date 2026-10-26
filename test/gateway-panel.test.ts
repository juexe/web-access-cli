import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { request } from "undici";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import type { AdminOverviewPayload } from "../src/gateway/admin.ts";
import { renderPanelHtml } from "../src/gateway/panel.ts";
import {
	createGatewayRecordStore,
	GATEWAY_RECORD_RETENTION,
	type GatewayAttemptRecord,
	type GatewayContentBackfillSummary,
	type GatewayRecordResult,
} from "../src/gateway/records.ts";
import {
	createGatewayServer,
	type GatewayServer,
} from "../src/gateway/server.ts";
import { type MockTransport, response } from "./helpers.ts";

const API_KEY = "0123456789abcdef0123456789abcdef";

const panelConfig = {
	providers: [
		{ id: "brave", type: "brave", apiKey: "brave-key" },
		{ id: "firecrawl", type: "firecrawl", apiKey: "firecrawl-key" },
	],
	search: { providers: ["brave"] },
	extract: { providers: ["firecrawl"] },
};

interface PanelRecord {
	id: string;
	at: number;
	route: string;
	status: number;
	durationMs: number;
	code?: string;
	provider?: string;
	query?: string;
	url?: string;
	count?: number;
	needContent?: boolean;
	title?: string;
	contentPreview?: string;
	contentChars?: number;
	contentTruncated?: boolean;
	resultCount?: number;
	results?: GatewayRecordResult[];
	attempts?: GatewayAttemptRecord[];
	contentBackfill?: GatewayContentBackfillSummary;
}

interface RecordsPayload {
	records: PanelRecord[];
	count: number;
	retention: number;
	generatedAt: number;
}

async function startServer(options: {
	transport: MockTransport;
	recordLimit?: number;
}): Promise<{
	fixture: { loaded: LoadedConfig; cleanup(): void };
	gateway: GatewayServer;
	url: string;
	close(): Promise<void>;
}> {
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-panel-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(panelConfig), "utf8");
	const fixture = {
		loaded: loadConfig(path, {}),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
	const gateway = createGatewayServer({
		loaded: fixture.loaded,
		apiKey: API_KEY,
		transport: options.transport,
		...(options.recordLimit !== undefined
			? { recordLimit: options.recordLimit }
			: {}),
		log: () => {},
	});
	await new Promise<void>((resolveListen) => {
		gateway.server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = gateway.server.address();
	if (!address || typeof address === "string")
		throw new Error("网关测试服务器未监听 TCP 端口");
	return {
		fixture,
		gateway,
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			await gateway.shutdown(1000);
			fixture.cleanup();
		},
	};
}

function authHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${API_KEY}`,
	};
}

async function search(
	base: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = authHeaders(),
	requestId?: string,
): Promise<number> {
	const result = await request(`${base}/v1/tools/search`, {
		method: "POST",
		headers: {
			...headers,
			...(requestId ? { "X-Request-Id": requestId } : {}),
		},
		body: JSON.stringify(body),
	});
	await result.body.text();
	return result.statusCode;
}

async function fetchDocument(
	base: string,
	url: string,
	requestId?: string,
): Promise<number> {
	const result = await request(`${base}/v1/tools/fetch`, {
		method: "POST",
		headers: {
			...authHeaders(),
			...(requestId ? { "X-Request-Id": requestId } : {}),
		},
		body: JSON.stringify({ url }),
	});
	await result.body.text();
	return result.statusCode;
}

async function records(base: string, query = ""): Promise<RecordsPayload> {
	const result = await request(`${base}/admin/api/records${query}`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
	assert.equal(result.statusCode, 200);
	return (await result.body.json()) as RecordsPayload;
}

test("面板是自包含 HTML，非 GET 返回 405", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const server = await startServer({
		transport: new MockTransport(() => response({ web: { results: [] } })),
	});
	try {
		for (const path of ["/panel", "/"]) {
			const page = await request(`${server.url}${path}`);
			assert.equal(page.statusCode, 200);
			assert.match(
				String(page.headers["content-type"] ?? ""),
				/^text\/html; charset=utf-8$/,
			);
			assert.equal(page.headers["cache-control"], "no-store");
			assert.equal(page.headers["x-content-type-options"], "nosniff");
			assert.equal(page.headers["referrer-policy"], "no-referrer");
			const csp = String(page.headers["content-security-policy"] ?? "");
			assert.match(csp, /default-src 'none'/);
			assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/);
			assert.match(csp, /connect-src 'self'/);
			const html = await page.body.text();
			assert.match(html, /Web Access 网关/);
			assert.match(html, /\/admin\/api\/records/);
			assert.doesNotMatch(
				html,
				/__(?:NONCE|RETENTION|MIN_KEY_LENGTH|VERSION)__/,
			);
			assert.doesNotMatch(html, new RegExp(API_KEY));
		}

		const first = await request(`${server.url}/panel`);
		const second = await request(`${server.url}/panel`);
		await first.body.text();
		await second.body.text();
		const firstNonce = String(first.headers["content-security-policy"]).match(
			/nonce-([A-Za-z0-9_-]+)/,
		)?.[1];
		const secondNonce = String(second.headers["content-security-policy"]).match(
			/nonce-([A-Za-z0-9_-]+)/,
		)?.[1];
		assert.ok(firstNonce);
		assert.ok(secondNonce);
		assert.notEqual(firstNonce, secondNonce);

		const postPanel = await request(`${server.url}/panel`, { method: "POST" });
		assert.equal(postPanel.statusCode, 405);
		assert.equal(postPanel.headers.allow, "GET");
		await postPanel.body.text();
	} finally {
		await server.close();
	}
});

test("记录 API 需要鉴权并限制 limit 参数", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const server = await startServer({
		transport: new MockTransport(() => response({ web: { results: [] } })),
	});
	try {
		const anonymous = await request(`${server.url}/admin/api/records`);
		assert.equal(anonymous.statusCode, 401);
		await anonymous.body.text();

		const wrong = await request(`${server.url}/admin/api/records`, {
			headers: { Authorization: "Bearer wrong-key-wrong-key-wrong" },
		});
		assert.equal(wrong.statusCode, 401);
		await wrong.body.text();

		const empty = await records(server.url);
		assert.equal(empty.count, 0);
		assert.equal(empty.retention, GATEWAY_RECORD_RETENTION);
		assert.deepEqual(empty.records, []);

		for (const limit of ["0", "501", "abc", "-1", "1.5"]) {
			const invalid = await request(
				`${server.url}/admin/api/records?limit=${limit}`,
				{ headers: { Authorization: `Bearer ${API_KEY}` } },
			);
			assert.equal(invalid.statusCode, 400, `limit=${limit}`);
			await invalid.body.text();
		}

		const limited = await request(`${server.url}/admin/api/records?limit=1`, {
			headers: { Authorization: `Bearer ${API_KEY}` },
		});
		assert.equal(limited.statusCode, 200);
		await limited.body.text();

		const viaPost = await request(`${server.url}/admin/api/records`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}` },
		});
		assert.equal(viaPost.statusCode, 405);
		assert.equal(viaPost.headers.allow, "GET, DELETE");
		await viaPost.body.text();
	} finally {
		await server.close();
	}
});

test("成功搜索记录 query、provider、结果标题与请求 ID", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport((url) => {
		assert.match(url, /api\.search\.brave\.com/);
		return response({
			web: {
				results: [
					{
						title: "Panel result",
						url: "https://example.com/result",
						description: "snippet",
					},
				],
			},
		});
	});
	const server = await startServer({ transport });
	try {
		assert.equal(
			await search(
				server.url,
				{ query: "panel query", count: 3, need_content: false },
				authHeaders(),
				"panel-search-1",
			),
			200,
		);
		const payload = await records(server.url);
		assert.equal(payload.count, 1);
		const record = payload.records[0];
		assert.ok(record);
		assert.equal(record.id, "panel-search-1");
		assert.equal(record.route, "search");
		assert.equal(record.status, 200);
		assert.equal(record.query, "panel query");
		assert.equal(record.count, 3);
		assert.equal(record.needContent, false);
		assert.equal(record.provider, "brave");
		assert.equal(record.resultCount, 1);
		assert.deepEqual(record.results, [
			{
				rank: 1,
				title: "Panel result",
				url: "https://example.com/result",
				snippet: "snippet",
			},
		]);
		assert.equal(record.attempts?.length, 1);
		assert.equal(record.attempts?.[0]?.provider, "brave");
		assert.equal(record.attempts?.[0]?.status, "ok");
		assert.equal(typeof record.at, "number");
		assert.ok(record.at > 0);
		assert.ok(record.durationMs >= 0);
		assert.equal("content" in record, false);

		// Health checks and the panel itself are not tool requests.
		for (const path of ["/healthz", "/readyz", "/panel"]) {
			const extra = await request(`${server.url}${path}`);
			await extra.body.text();
		}
		assert.equal((await records(server.url)).count, 1);
	} finally {
		await server.close();
	}
});

test("失败记录保留错误码与 provider，未鉴权请求不入面板", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() =>
		response({ error: "boom" }, { status: 500 }),
	);
	const server = await startServer({ transport });
	try {
		assert.equal(await search(server.url, { query: "failing query" }), 500);
		const payload = await records(server.url);
		assert.equal(payload.count, 1);
		const record = payload.records[0];
		assert.ok(record);
		assert.equal(record.route, "search");
		assert.equal(record.status, 500);
		assert.equal(record.code, "provider_error");
		assert.equal(record.provider, "brave");
		assert.equal(record.query, "failing query");

		const unauthenticated = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "should not be recorded" }),
		});
		assert.equal(unauthenticated.statusCode, 401);
		await unauthenticated.body.text();
		assert.equal((await records(server.url)).count, 1);
	} finally {
		await server.close();
	}
});

test("Fetch 记录 URL、页面标题与 provider", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport((url) => {
		assert.match(url, /api\.firecrawl\.dev\/v2\/scrape/);
		return response({
			data: {
				markdown: "# Fetched\n\nBody text",
				metadata: { title: "Fetched title" },
			},
		});
	});
	const server = await startServer({ transport });
	try {
		assert.equal(
			await fetchDocument(
				server.url,
				"https://example.com/article",
				"panel-fetch-1",
			),
			200,
		);
		const payload = await records(server.url);
		assert.equal(payload.count, 1);
		const record = payload.records[0];
		assert.ok(record);
		assert.equal(record.id, "panel-fetch-1");
		assert.equal(record.route, "fetch");
		assert.equal(record.status, 200);
		assert.equal(record.url, "https://example.com/article");
		assert.equal(record.title, "Fetched title");
		assert.equal(record.provider, "firecrawl");
		assert.equal(record.contentPreview, "# Fetched\n\nBody text");
		assert.equal(record.contentChars, 20);
		assert.equal(record.contentTruncated, false);
		assert.equal("content" in record, false);
		assert.equal(record.resultCount, undefined);
		assert.equal(record.results, undefined);
	} finally {
		await server.close();
	}
});

test("记录使用环形缓冲，返回顺序为新到旧", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() =>
		response({
			web: {
				results: [
					{ title: "R", url: "https://example.com/r", description: "s" },
				],
			},
		}),
	);
	const server = await startServer({ transport, recordLimit: 2 });
	try {
		for (const query of ["first", "second", "third"]) {
			assert.equal(await search(server.url, { query }), 200);
		}
		const payload = await records(server.url);
		assert.equal(payload.retention, 2);
		assert.equal(payload.count, 2);
		assert.deepEqual(
			payload.records.map((record) => record.query),
			["third", "second"],
		);
		const single = await records(server.url, "?limit=1");
		assert.equal(single.count, 1);
		assert.equal(single.records[0]?.query, "third");
	} finally {
		await server.close();
	}
});

test("记录存储截断长文本、限制结果条数并复制字段", () => {
	const store = createGatewayRecordStore(2);
	store.add({
		id: "r".repeat(200),
		at: 1,
		route: "search",
		status: 200,
		durationMs: 5,
		query: "q".repeat(300),
		results: Array.from({ length: 55 }, (_, index) => ({
			title: `title-${index}`.repeat(30),
			url: `https://example.com/${index}/${"u".repeat(500)}`,
		})),
	});
	const record = store.list()[0];
	assert.ok(record);
	assert.equal(Array.from(record.id).length, 129);
	assert.equal(Array.from(record.query ?? "").length, 201);
	assert.equal(record.results?.length, 50);
	assert.equal(Array.from(record.results?.[0]?.title ?? "").length, 161);
	assert.equal(Array.from(record.results?.[0]?.url ?? "").length, 401);

	store.add({
		id: "b",
		at: 2,
		route: "fetch",
		status: 200,
		durationMs: 1,
		url: "https://example.com",
	});
	store.add({
		id: "c",
		at: 3,
		route: "fetch",
		status: 200,
		durationMs: 1,
	});
	assert.equal(store.size, 2);
	assert.deepEqual(
		store.list().map((item) => item.id),
		["c", "b"],
	);
});

test("面板模板完成替换且内联脚本语法有效", () => {
	const html = renderPanelHtml({
		nonce: "test-nonce",
		retention: 500,
		minKeyLength: 12,
		version: "test-version",
	});
	assert.doesNotMatch(html, /__[A-Z_]+__/);
	const script = html.match(
		/<script nonce="test-nonce">([\s\S]*?)<\/script>/,
	)?.[1];
	assert.ok(script);
	assert.doesNotThrow(() => new Script(script));
});

test("面板脚本引用的每个元素 id 都存在于页面中", () => {
	const html = renderPanelHtml({
		nonce: "test-nonce",
		retention: 500,
		minKeyLength: 12,
		version: "test-version",
	});
	const declared = new Set(
		Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]),
	);
	const referenced = new Set(
		Array.from(html.matchAll(/byId\("([^"]+)"\)/g), (match) => match[1]),
	);
	assert.ok(referenced.size > 0);
	const missing = [...referenced].filter((id) => !declared.has(id));
	assert.deepEqual(missing, [], `缺少元素: ${missing.join(", ")}`);
});

test("记录完整回退链路 attempts、补抓明细与截断正文预览，并支持过滤与清空", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-trace-"));
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: [
				{ id: "tavily", type: "tavily", apiKey: "secret-tavily-key" },
				{ id: "brave", type: "brave", apiKey: "secret-brave-key" },
				{ id: "firecrawl", type: "firecrawl", apiKey: "secret-firecrawl-key" },
			],
			search: { providers: ["tavily"], providers_fallback: ["brave"] },
			extract: { providers: ["firecrawl"] },
		}),
		"utf8",
	);
	const loaded = loadConfig(path, {});
	const transport = new MockTransport((url) => {
		if (url.includes("api.tavily.com")) {
			return response(
				{ error: "upstream failed with secret-tavily-key" },
				{ status: 500 },
			);
		}
		if (url.includes("api.search.brave.com")) {
			return response({
				web: {
					results: [
						{
							title: "Hit One",
							url: "https://example.com/one",
							description: "First hit snippet",
						},
					],
				},
			});
		}
		if (url.includes("api.firecrawl.dev/v2/scrape")) {
			return response({
				data: {
					markdown: `Backfilled markdown ${"A".repeat(2500)}`,
					metadata: { title: "Hit One" },
				},
			});
		}
		throw new Error(`unexpected url: ${url}`);
	});
	const gateway = createGatewayServer({
		loaded,
		apiKey: API_KEY,
		transport,
		log: () => {},
	});
	await new Promise<void>((resolveListen) => {
		gateway.server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = gateway.server.address();
	if (!address || typeof address === "string")
		throw new Error("未监听测试端口");
	const url = `http://127.0.0.1:${address.port}`;

	try {
		assert.equal(
			await search(
				url,
				{ query: "fallback trace", count: 5, need_content: true },
				authHeaders(),
				"req-trace-1",
			),
			200,
		);
		const list = await records(url);
		assert.equal(list.count, 1);
		const rec = list.records[0];
		assert.ok(rec);
		assert.equal(rec.provider, "brave");
		assert.equal(rec.attempts?.length, 2);
		assert.equal(rec.attempts?.[0]?.provider, "tavily");
		assert.equal(rec.attempts?.[0]?.status, "failed");
		assert.doesNotMatch(
			rec.attempts?.[0]?.errorMessage ?? "",
			/secret-tavily-key/,
		);
		assert.equal(rec.attempts?.[1]?.provider, "brave");
		assert.equal(rec.attempts?.[1]?.status, "ok");

		assert.ok(rec.contentBackfill);
		assert.equal(rec.contentBackfill.requestedCount, 1);
		assert.equal(rec.contentBackfill.attemptedCount, 1);
		assert.equal(rec.contentBackfill.succeededCount, 1);
		assert.equal(rec.contentBackfill.items.length, 1);
		assert.equal(rec.contentBackfill.items[0]?.status, "ok");
		assert.equal(rec.contentBackfill.items[0]?.provider, "firecrawl");

		assert.equal(rec.results?.length, 1);
		assert.equal(rec.results?.[0]?.snippet, "First hit snippet");
		assert.equal(rec.results?.[0]?.contentTruncated, true);
		assert.equal(rec.results?.[0]?.contentChars, 2520);
		assert.ok((rec.results?.[0]?.contentPreview?.length ?? 0) <= 2001);

		// Filter by provider in attempts (tavily failed but is searchable)
		const byTavily = await records(url, "?provider=tavily");
		assert.equal(byTavily.count, 1);
		const byUnknown = await records(url, "?provider=exa");
		assert.equal(byUnknown.count, 0);
		const byStatusError = await records(url, "?status=error");
		assert.equal(byStatusError.count, 0);
		const byQuery = await records(url, "?q=First%20hit");
		assert.equal(byQuery.count, 1);

		// Clear records via DELETE /admin/api/records
		const cleared = await request(`${url}/admin/api/records`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		assert.equal(cleared.statusCode, 200);
		const clearedBody = (await cleared.body.json()) as {
			cleared: number;
			generatedAt: number;
		};
		assert.equal(clearedBody.cleared, 1);
		assert.ok(clearedBody.generatedAt > 0);
		assert.equal((await records(url)).count, 0);
	} finally {
		await gateway.shutdown(1000);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("管理后台 overview 与在线配置更新支持持久化写回、只读回退及热重载，且不泄漏密钥", async (_t) => {
	const { MockTransport } = await import("./helpers.ts");
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-admin-"));
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: [
				{ id: "brave", type: "brave", apiKey: "super-secret-brave-key" },
				{
					id: "firecrawl",
					type: "firecrawl",
					apiKey: "super-secret-firecrawl-key",
				},
			],
			search: { providers: ["brave"] },
			extract: { providers: ["firecrawl"] },
		}),
		"utf8",
	);
	const loaded = loadConfig(path, {});
	const transport = new MockTransport((url) => {
		if (url.includes("api.search.brave.com")) {
			return response({
				web: {
					results: [
						{ title: "B", url: "https://example.com/b", description: "s" },
					],
				},
			});
		}
		if (url.includes("api.tavily.com")) {
			return response({
				results: [
					{ title: "T", url: "https://example.com/t", content: "tavily hit" },
				],
			});
		}
		return response({
			data: { markdown: "# Doc\n\nBody", metadata: { title: "Doc" } },
		});
	});
	const gateway = createGatewayServer({
		loaded,
		apiKey: API_KEY,
		transport,
		log: () => {},
	});
	await new Promise<void>((resolveListen) => {
		gateway.server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = gateway.server.address();
	if (!address || typeof address === "string")
		throw new Error("未监听测试端口");
	const url = `http://127.0.0.1:${address.port}`;

	try {
		// Unauthenticated overview request is rejected
		const unauthOv = await request(`${url}/admin/api/overview`);
		assert.equal(unauthOv.statusCode, 401);
		await unauthOv.body.text();

		// Perform one search request to populate provider stats
		assert.equal(await search(url, { query: "stat check" }), 200);

		const ovRes = await request(`${url}/admin/api/overview`, {
			headers: authHeaders(),
		});
		assert.equal(ovRes.statusCode, 200);
		const ovRaw = await ovRes.body.text();
		assert.doesNotMatch(ovRaw, /super-secret-brave-key/);
		assert.doesNotMatch(ovRaw, /super-secret-firecrawl-key/);

		const ov = JSON.parse(ovRaw) as AdminOverviewPayload;
		assert.equal(ov.doctor.ok, true);
		assert.equal(ov.stats.totalRequests, 1);
		assert.equal(ov.stats.searchRequests, 1);
		assert.equal(ov.stats.searchSuccesses, 1);
		const braveInfo = ov.providers.find((p) => p.id === "brave");
		assert.ok(braveInfo);
		assert.equal(braveInfo.config.hasConfigApiKey, true);
		assert.equal(braveInfo.stats.search.attempts, 1);
		assert.equal(braveInfo.stats.search.successes, 1);

		// Reset stats
		const resetRes = await request(`${url}/admin/api/stats/reset`, {
			method: "POST",
			headers: authHeaders(),
		});
		assert.equal(resetRes.statusCode, 200);
		const resetData = (await resetRes.body.json()) as {
			reset: boolean;
			stats: { totalRequests: number };
		};
		assert.equal(resetData.reset, true);
		assert.equal(resetData.stats.totalRequests, 0);

		// Reject invalid config update (empty search route)
		const badUpdate = await request(`${url}/admin/api/config`, {
			method: "PUT",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({
				search: { providers: [] },
			}),
		});
		assert.equal(badUpdate.statusCode, 400);
		await badUpdate.body.text();

		// Valid online config update: configure tavily key and switch search primary route to tavily -> brave
		const goodUpdate = await request(`${url}/admin/api/config`, {
			method: "PUT",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({
				search: {
					providers: ["tavily"],
					providers_fallback: ["brave"],
					limit: 8,
				},
				providers: [
					{
						id: "tavily",
						type: "tavily",
						apiKeyAction: "set",
						apiKey: "new-tavily-secret-key",
					},
					{
						id: "brave",
						type: "brave",
						apiKeyAction: "keep",
					},
				],
			}),
		});
		assert.equal(goodUpdate.statusCode, 200);
		const updateBody = (await goodUpdate.body.json()) as {
			persisted: boolean;
			overview: AdminOverviewPayload;
		};
		assert.equal(updateBody.persisted, true);
		assert.deepEqual(updateBody.overview.routes.search.providers, ["tavily"]);
		assert.deepEqual(updateBody.overview.routes.search.providers_fallback, [
			"brave",
		]);
		assert.equal(updateBody.overview.routes.search.limit, 8);

		// Verify file on disk has both new tavily key and preserved brave key
		const diskJson = JSON.parse(readFileSync(path, "utf8")) as {
			providers: Array<{ id: string; apiKey?: string }>;
		};
		assert.equal(
			diskJson.providers.find((p) => p.id === "tavily")?.apiKey,
			"new-tavily-secret-key",
		);
		assert.equal(
			diskJson.providers.find((p) => p.id === "brave")?.apiKey,
			"super-secret-brave-key",
		);

		// Verify subsequent search request immediately uses tavily
		assert.equal(await search(url, { query: "after hot swap" }), 200);
		const latestRecords = await records(url, "?limit=1");
		assert.equal(latestRecords.records[0]?.provider, "tavily");

		// Simulate read-only config file and verify in-memory fallback works
		chmodSync(path, 0o444);
		try {
			const roUpdate = await request(`${url}/admin/api/config`, {
				method: "PUT",
				headers: { ...authHeaders(), "Content-Type": "application/json" },
				body: JSON.stringify({
					search: {
						providers: ["brave"],
						providers_fallback: ["tavily"],
						limit: 6,
					},
				}),
			});
			assert.equal(roUpdate.statusCode, 200);
			const roBody = (await roUpdate.body.json()) as {
				persisted: boolean;
				persistWarning?: string;
				overview: AdminOverviewPayload;
			};
			if (!roBody.persisted) {
				assert.ok(roBody.persistWarning);
				assert.equal(roBody.overview.gateway.configPersisted, false);
			}
			assert.deepEqual(roBody.overview.routes.search.providers, ["brave"]);
		} finally {
			chmodSync(path, 0o666);
		}

		// Reload config from disk
		const reloadRes = await request(`${url}/admin/api/config/reload`, {
			method: "POST",
			headers: authHeaders(),
		});
		assert.equal(reloadRes.statusCode, 200);
		const reloadBody = (await reloadRes.body.json()) as {
			reloaded: boolean;
			overview: AdminOverviewPayload;
		};
		assert.equal(reloadBody.reloaded, true);
	} finally {
		try {
			chmodSync(path, 0o666);
		} catch {
			// Ignore cleanup error
		}
		await gateway.shutdown(1000);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("面板刷新时保留已展开的记录行状态与 DOM 节点", async (_t) => {
	const { parseHTML } = await import("linkedom");
	const vm = await import("node:vm");
	const { MockTransport } = await import("./helpers.ts");
	const server = await startServer({
		transport: new MockTransport((url) =>
			response({
				web: {
					results: [
						{
							title: `Hit for ${url}`,
							url: "https://example.com/item",
							description: "snippet text",
						},
					],
				},
			}),
		),
	});
	try {
		await search(
			server.url,
			{ query: "first query", count: 1 },
			authHeaders(),
			"req-first",
		);
		const pageRes = await request(`${server.url}/panel`);
		const html = await pageRes.body.text();
		const scriptMatch = html.match(
			/<script nonce="[^"]+">([\s\S]*?)<\/script>/,
		);
		assert.ok(scriptMatch?.[1]);

		const dom = parseHTML(html);
		const storage = new Map<string, string>([
			["web-access-gateway-key", API_KEY],
		]);
		const intervals: Array<() => void> = [];
		const context = vm.createContext({
			document: dom.document,
			window: dom.window,
			location: {
				hash: "",
				pathname: "/panel",
				search: "",
			},
			history: {
				replaceState() {},
			},
			sessionStorage: {
				getItem: (k: string) => storage.get(k) ?? null,
				setItem: (k: string, v: string) => storage.set(k, v),
				removeItem: (k: string) => storage.delete(k),
			},
			navigator: {
				clipboard: {
					writeText: async () => {},
				},
			},
			URL,
			URLSearchParams,
			Blob,
			setInterval: (fn: () => void) => {
				intervals.push(fn);
				return intervals.length;
			},
			clearInterval: () => {},
			setTimeout,
			clearTimeout,
			fetch: async (target: string, init?: RequestInit) => {
				const res = await fetch(`${server.url}${target}`, init);
				return res;
			},
		});

		vm.runInContext(scriptMatch[1], context);
		// Wait for initial boot load() to settle
		for (let i = 0; i < 20; i += 1) {
			const list = dom.document.getElementById("records");
			if (list && list.children.length > 0) break;
			await new Promise((r) => setTimeout(r, 25));
		}

		const recordsList = dom.document.getElementById("records");
		assert.ok(recordsList);
		assert.equal(recordsList.children.length, 1);

		const firstRow = recordsList.children[0] as HTMLElement;
		const headBtn = firstRow.querySelector(".record-head") as HTMLElement;
		const detailDiv = firstRow.querySelector(".record-detail") as HTMLElement;
		assert.equal(headBtn.getAttribute("aria-expanded"), "false");
		assert.equal(detailDiv.hidden, true);

		// Click to expand the first row
		headBtn.click();
		assert.equal(headBtn.getAttribute("aria-expanded"), "true");
		assert.equal(detailDiv.hidden, false);
		assert.equal(firstRow.classList.contains("expanded"), true);

		// Add a second search request, then trigger refresh
		await search(
			server.url,
			{ query: "second query", count: 1 },
			authHeaders(),
			"req-second",
		);
		(dom.document.getElementById("refresh") as HTMLElement).click();

		for (let i = 0; i < 20; i += 1) {
			if (Number(recordsList.children.length) === 2) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(Number(recordsList.children.length), 2);

		// Newest row is at index 0 (collapsed), previously expanded row is at index 1 and still expanded + same DOM node
		const newestRow = recordsList.children[0] as HTMLElement;
		const preservedRow = recordsList.children[1] as HTMLElement;
		assert.equal(
			newestRow.querySelector(".record-head")?.getAttribute("aria-expanded"),
			"false",
		);
		assert.equal(preservedRow, firstRow);
		assert.equal(
			preservedRow.querySelector(".record-head")?.getAttribute("aria-expanded"),
			"true",
		);
		assert.equal(
			(preservedRow.querySelector(".record-detail") as HTMLElement).hidden,
			false,
		);
		assert.equal(preservedRow.classList.contains("expanded"), true);
	} finally {
		await server.close();
	}
});
