import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { request } from "undici";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import { renderPanelHtml } from "../src/gateway/panel.ts";
import {
	createGatewayRecordStore,
	GATEWAY_RECORD_RETENTION,
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
	resultCount?: number;
	results?: Array<{ title: string; url: string }>;
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
		assert.equal(viaPost.headers.allow, "GET");
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
			{ title: "Panel result", url: "https://example.com/result" },
		]);
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
		results: Array.from({ length: 7 }, (_, index) => ({
			title: `title-${index}`.repeat(30),
			url: `https://example.com/${index}/${"u".repeat(500)}`,
		})),
	});
	const record = store.list()[0];
	assert.ok(record);
	assert.equal(Array.from(record.id).length, 129);
	assert.equal(Array.from(record.query ?? "").length, 201);
	assert.equal(record.results?.length, 5);
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
