import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { request } from "undici";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import {
	createGatewayServer,
	GATEWAY_MAX_IN_FLIGHT,
	GATEWAY_MIN_API_KEY_LENGTH,
	type GatewayLogEvent,
	type GatewayServer,
	normalizeGatewayApiKey,
} from "../src/gateway/server.ts";
import type { MockTransport } from "./helpers.ts";
import { response } from "./helpers.ts";

const API_KEY = "0123456789abcdef0123456789abcdef";

function loadedConfig(value: unknown): {
	loaded: LoadedConfig;
	cleanup(): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-server-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		loaded: loadConfig(path, {}),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

const searchConfig = {
	providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
	search: { providers: ["brave"] },
	extract: { providers: ["http"] },
};

async function startServer(
	_t: TestContext,
	options: {
		config?: unknown;
		transport?: MockTransport;
		maxBodyBytes?: number;
		bodyTimeoutMs?: number;
		log?: (event: GatewayLogEvent) => void;
	} = {},
): Promise<{
	fixture: { loaded: LoadedConfig; cleanup(): void };
	gateway: GatewayServer;
	url: string;
	close(): Promise<void>;
}> {
	const fixture = loadedConfig(options.config ?? searchConfig);
	const transport = options.transport;
	const gateway = createGatewayServer({
		loaded: fixture.loaded,
		apiKey: API_KEY,
		...(transport ? { transport } : {}),
		...(options.maxBodyBytes !== undefined
			? { maxBodyBytes: options.maxBodyBytes }
			: {}),
		...(options.bodyTimeoutMs !== undefined
			? { bodyTimeoutMs: options.bodyTimeoutMs }
			: {}),
		...(options.log ? { log: options.log } : { log: () => {} }),
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

function searchBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ query: "hello", ...overrides });
}

test("健康检查不需要鉴权且只返回简单状态", async (t) => {
	const server = await startServer(t, {
		transport: new (await import("./helpers.ts")).MockTransport(() =>
			response({ web: { results: [] } }),
		),
	});
	try {
		const health = await request(`${server.url}/healthz`);
		assert.equal(health.statusCode, 200);
		assert.deepEqual(await health.body.json(), { status: "ok" });
		assert.equal(health.headers["cache-control"], "no-store");

		const ready = await request(`${server.url}/readyz`);
		assert.equal(ready.statusCode, 200);
		assert.deepEqual(await ready.body.json(), { status: "ready" });
	} finally {
		await server.close();
	}
});

test("readiness 在路由缺配置时返回 503", async (t) => {
	const server = await startServer(t, {
		config: {
			providers: [{ id: "brave", type: "brave", apiKey: "k" }],
			search: { providers: ["brave"] },
			extract: { providers: ["firecrawl"] },
		},
	});
	try {
		const ready = await request(`${server.url}/readyz`);
		assert.equal(ready.statusCode, 503);
		const body = (await ready.body.json()) as { status: string };
		assert.equal(body.status, "not_ready");
	} finally {
		await server.close();
	}
});

test("错误或重复 Bearer 返回 401 且不触发 provider", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() => response({ web: { results: [] } }));
	const server = await startServer(t, { transport });
	try {
		const missing = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: searchBody(),
		});
		assert.equal(missing.statusCode, 401);
		const missingBody = (await missing.body.json()) as {
			error: { type: string; code: string; param: null };
		};
		assert.equal(missingBody.error.type, "authentication_error");
		assert.equal(missingBody.error.code, "invalid_api_key");
		assert.equal(missingBody.error.param, null);

		const wrong = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-key-wrong-key-wrong",
			},
			body: searchBody(),
		});
		assert.equal(wrong.statusCode, 401);

		// Duplicate Authorization header lines must be rejected, not coalesced.
		const duplicated = await rawHttpRequest(
			server.url,
			`${[
				"POST /v1/tools/search HTTP/1.1",
				`Host: ${new URL(server.url).host}`,
				"Content-Type: application/json",
				`Authorization: Bearer ${API_KEY}`,
				`Authorization: Bearer ${API_KEY}`,
				`Content-Length: ${Buffer.byteLength(searchBody())}`,
				"Connection: close",
			].join("\r\n")}\r\n\r\n${searchBody()}`,
		);
		assert.match(duplicated, /^HTTP\/1\.1 401/);
		assert.match(duplicated, /invalid_api_key/);
		assert.equal(transport.calls.length, 0);
	} finally {
		await server.close();
	}
});

test("认证后的搜索请求返回 200 与 no-store", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() =>
		response({
			web: {
				results: [
					{ title: "A", url: "https://example.com/a", description: "a" },
				],
			},
		}),
	);
	const server = await startServer(t, { transport });
	try {
		const result = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: searchBody(),
		});
		assert.equal(result.statusCode, 200);
		assert.match(
			String(result.headers["content-type"] ?? ""),
			/application\/json/,
		);
		assert.equal(result.headers["cache-control"], "no-store");
		const body = (await result.body.json()) as {
			results: Array<{ url: string; summary: string }>;
		};
		assert.equal(body.results[0]?.url, "https://example.com/a");
		assert.equal(body.results[0]?.summary, "a");
	} finally {
		await server.close();
	}
});

test("请求方法、未知路由与 Content-Type 契约", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() => response({ web: { results: [] } }));
	const server = await startServer(t, { transport });
	try {
		const getSearch = await request(`${server.url}/v1/tools/search`);
		assert.equal(getSearch.statusCode, 405);
		assert.equal(getSearch.headers.allow, "POST");
		const getBody = (await getSearch.body.json()) as {
			error: { type: string; code: string; param: null };
		};
		assert.equal(getBody.error.param, null);

		const unknown = await request(`${server.url}/v1/search`);
		assert.equal(unknown.statusCode, 404);
		const unknownBody = (await unknown.body.json()) as {
			error: { code: string };
		};
		assert.equal(unknownBody.error.code, "not_found");

		const noType = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}` },
			body: searchBody(),
		});
		assert.equal(noType.statusCode, 400);

		const formType = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: searchBody(),
		});
		assert.equal(formType.statusCode, 400);

		const gzip = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Encoding": "gzip",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: searchBody(),
		});
		assert.equal(gzip.statusCode, 400);

		const charted = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: searchBody(),
		});
		assert.equal(charted.statusCode, 200);

		const badJson = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: "{not json",
		});
		assert.equal(badJson.statusCode, 400);

		const nonObject = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: "[]",
		});
		assert.equal(nonObject.statusCode, 400);

		const invalid = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: searchBody({ count: 51 }),
		});
		assert.equal(invalid.statusCode, 400);
		const invalidBody = (await invalid.body.json()) as {
			error: { type: string; code: string };
		};
		assert.equal(invalidBody.error.type, "invalid_request_error");
		assert.equal(invalidBody.error.code, "invalid_request_error");
	} finally {
		await server.close();
	}
});

test("并发满时返回 429 与 Retry-After", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const transport = new MockTransport(async () => {
		await gate;
		return response({ web: { results: [] } });
	});
	const server = await startServer(t, { transport });
	try {
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${API_KEY}`,
		};
		const pending = Array.from({ length: GATEWAY_MAX_IN_FLIGHT }, () =>
			request(`${server.url}/v1/tools/search`, {
				method: "POST",
				headers,
				body: searchBody(),
			}),
		);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		const rejected = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers,
			body: searchBody(),
		});
		assert.equal(rejected.statusCode, 429);
		assert.equal(rejected.headers["retry-after"], "1");
		release?.();
		const results = await Promise.all(pending);
		for (const result of results) {
			assert.equal(result.statusCode, 200);
			await result.body.text();
		}
	} finally {
		release?.();
		await server.close();
	}
});

test("请求体超限返回 413，读取超时返回 408", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() => response({ web: { results: [] } }));
	const server = await startServer(t, {
		transport,
		maxBodyBytes: 1024,
		bodyTimeoutMs: 200,
	});
	try {
		const oversized = await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: JSON.stringify({ query: "x".repeat(2000) }),
		});
		assert.equal(oversized.statusCode, 413);
		const body = (await oversized.body.json()) as {
			error: { type: string; code: string };
		};
		assert.equal(body.error.type, "invalid_request_error");
		assert.equal(body.error.code, "request_too_large");
	} finally {
		await server.close();
	}
});

test("慢请求体在读取超时后返回 408", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() => response({ web: { results: [] } }));
	const server = await startServer(t, {
		transport,
		bodyTimeoutMs: 150,
	});
	try {
		const url = new URL(server.url);
		const net = await import("node:net");
		const responseText = await new Promise<string>(
			(resolveText, rejectText) => {
				const socket = new net.Socket();
				let data = "";
				socket.connect(Number(url.port), url.hostname, () => {
					socket.write(
						[
							"POST /v1/tools/search HTTP/1.1",
							`Host: ${url.host}`,
							"Content-Type: application/json",
							`Authorization: Bearer ${API_KEY}`,
							"Content-Length: 1000",
							"Connection: close",
							"",
							"",
						].join("\r\n"),
					);
					// Send a partial body and then stop writing entirely.
					socket.write('{"query":');
				});
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					data += chunk;
				});
				socket.on("close", () => resolveText(data));
				socket.on("error", rejectText);
				setTimeout(() => {
					socket.destroy();
					resolveText(data);
				}, 2000).unref();
			},
		);
		assert.match(responseText, /^HTTP\/1\.1 408/);
		assert.match(responseText, /request_timeout/);
	} finally {
		await server.close();
	}
});

test("请求正常读完不会被误判为客户端断开", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() =>
		response({
			web: {
				results: [
					{ title: "A", url: "https://example.com/a", description: "a" },
				],
			},
		}),
	);
	const server = await startServer(t, { transport });
	try {
		for (let attempt = 0; attempt < 5; attempt++) {
			const result = await request(`${server.url}/v1/tools/search`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${API_KEY}`,
				},
				body: searchBody(),
			});
			assert.equal(result.statusCode, 200);
			await result.body.text();
		}
	} finally {
		await server.close();
	}
});

test("日志只记录方法、固定路由、状态、耗时、请求 ID 与错误码", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const events: GatewayLogEvent[] = [];
	const transport = new MockTransport(() =>
		response({ error: "leaky upstream detail" }, { status: 500 }),
	);
	const server = await startServer(t, {
		transport,
		log: (event) => events.push(event),
	});
	try {
		await request(`${server.url}/v1/tools/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
				"X-Request-Id": "req-123",
			},
			body: searchBody(),
		});
		assert.equal(events.length, 1);
		const event = events[0];
		assert.ok(event);
		assert.deepEqual(Object.keys(event).sort(), [
			"code",
			"durationMs",
			"method",
			"requestId",
			"route",
			"status",
		]);
		assert.equal(event.method, "POST");
		assert.equal(event.route, "search");
		assert.equal(event.requestId, "req-123");
		const serialized = JSON.stringify(events);
		assert.doesNotMatch(serialized, /leaky upstream detail/);
		assert.doesNotMatch(serialized, new RegExp(API_KEY));
		assert.doesNotMatch(serialized, /hello/);
	} finally {
		await server.close();
	}
});

test("网关密钥文件读取拒绝空值、过短与控制字符", () => {
	assert.equal(normalizeGatewayApiKey(`${API_KEY}\n`), API_KEY);
	assert.equal(normalizeGatewayApiKey(`${API_KEY}\r\n`), API_KEY);
	assert.throws(() => normalizeGatewayApiKey(""));
	assert.throws(() => normalizeGatewayApiKey("   \n"));
	// 11 characters is below the 12-character floor; 12 is accepted.
	assert.throws(() => normalizeGatewayApiKey("a".repeat(11)));
	assert.equal(
		normalizeGatewayApiKey("a".repeat(GATEWAY_MIN_API_KEY_LENGTH)),
		"a".repeat(GATEWAY_MIN_API_KEY_LENGTH),
	);
	assert.throws(() => normalizeGatewayApiKey(`${API_KEY}\u0000`));
	assert.throws(() => normalizeGatewayApiKey(`${API_KEY} extra`));
});

test("shutdown 停止接收新请求并可再次调用", async (t) => {
	const { MockTransport } = await import("./helpers.ts");
	const transport = new MockTransport(() => response({ web: { results: [] } }));
	const server = await startServer(t, { transport });
	try {
		await server.gateway.shutdown(500);
		await server.gateway.shutdown(500);
		await assert.rejects(async () => {
			const result = await request(`${server.url}/healthz`);
			await result.body.text();
		});
	} finally {
		await server.close();
	}
});

// --- Helpers ----------------------------------------------------------------

async function rawHttpRequest(base: string, payload: string): Promise<string> {
	const url = new URL(base);
	const net = await import("node:net");
	return new Promise<string>((resolveText, rejectText) => {
		const socket = new net.Socket();
		let data = "";
		socket.connect(Number(url.port), url.hostname, () => {
			socket.write(payload);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			data += chunk;
		});
		socket.on("close", () => resolveText(data));
		socket.on("error", rejectText);
		socket.setTimeout(3000, () => {
			socket.destroy();
			resolveText(data);
		});
	});
}

// --- Process boundary --------------------------------------------------------

function serverEnv(configPath: string, keyPath: string, port: number) {
	return {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		WEB_ACCESS_CONFIG: configPath,
		WEB_ACCESS_GATEWAY_API_KEY_FILE: keyPath,
		WEB_ACCESS_GATEWAY_HOST: "127.0.0.1",
		WEB_ACCESS_GATEWAY_PORT: String(port),
	};
}

async function freePort(): Promise<number> {
	const probe = createHttpServer();
	await new Promise<void>((resolveListen) =>
		probe.listen(0, "127.0.0.1", () => resolveListen()),
	);
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("no port");
	await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
	return address.port;
}

async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await request(`${url}/readyz`);
			await result.body.text();
			if (result.statusCode === 200) return;
		} catch {
			// Server not listening yet.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error("网关进程未在期限内就绪");
}

test("服务器进程：鉴权、SIGTERM 优雅退出并释放端口", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-proc-"));
	const upstream = createHttpServer((incoming, outgoing) => {
		if (incoming.url === "/article") {
			outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			outgoing.end(
				"<!doctype html><html><head><title>Proc</title></head><body><main><h1>Proc</h1><p>Process body</p></main></body></html>",
			);
			return;
		}
		outgoing.writeHead(404).end();
	});
	await new Promise<void>((resolveListen) =>
		upstream.listen(0, "127.0.0.1", () => resolveListen()),
	);
	const upstreamAddress = upstream.address();
	if (!upstreamAddress || typeof upstreamAddress === "string")
		throw new Error("上游 fixture 未监听");
	const configPath = join(directory, "config.json");
	const keyPath = join(directory, "gateway-api-key");
	writeFileSync(
		configPath,
		JSON.stringify({
			providers: [{ id: "brave", type: "brave", apiKey: "proc-key" }],
			extract: { providers: ["http"] },
		}),
		"utf8",
	);
	writeFileSync(keyPath, `${API_KEY}\n`, "utf8");
	const port = await freePort();
	const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
		cwd: resolve("."),
		env: serverEnv(configPath, keyPath, port),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolveExit) =>
			child.once("exit", (code, signal) => resolveExit({ code, signal })),
	);
	t.after(async () => {
		if (child.exitCode === null) child.kill("SIGKILL");
		await new Promise<void>((resolveClose) =>
			upstream.close(() => resolveClose()),
		);
		rmSync(directory, { recursive: true, force: true });
	});
	const base = `http://127.0.0.1:${port}`;
	await waitForReady(base);
	const unauthenticated = await request(`${base}/v1/tools/fetch`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url: `http://127.0.0.1:${upstreamAddress.port}/article`,
		}),
	});
	assert.equal(unauthenticated.statusCode, 401);
	await unauthenticated.body.text();

	const fetched = await request(`${base}/v1/tools/fetch`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${API_KEY}`,
		},
		body: JSON.stringify({
			url: `http://127.0.0.1:${upstreamAddress.port}/article`,
		}),
	});
	assert.equal(fetched.statusCode, 200);
	const body = (await fetched.body.json()) as {
		title: string;
		content: string;
	};
	assert.equal(body.title, "Proc");
	assert.match(body.content, /Process body/);

	child.kill("SIGTERM");
	const exit = await Promise.race([
		exited,
		new Promise<"timeout">((resolveTimeout) =>
			setTimeout(() => resolveTimeout("timeout"), 12_000),
		),
	]);
	assert.notEqual(exit, "timeout", "SIGTERM 后应在期限内退出");
	if (process.platform === "win32") {
		// Windows terminates the child instead of delivering SIGTERM; the graceful
		// drain path is covered by the in-process shutdown test.
		assert.equal(typeof exit === "object" ? exit.signal : null, "SIGTERM");
	} else {
		assert.equal(typeof exit === "object" ? exit.code : null, 0);
	}
	assert.equal(stdout, "", "stdout 不应输出内容");
	assert.doesNotMatch(stderr, new RegExp(API_KEY));
	// The port must be free again after shutdown.
	const probe = createHttpServer();
	await new Promise<void>((resolveListen) =>
		probe.listen(port, "127.0.0.1", () => resolveListen()),
	);
	await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
});

test("服务器 import 无副作用：不监听端口也不注册信号", async () => {
	const root = pathToFileURL(resolve(".")).href;
	const script = [
		`import { createGatewayServer } from "${root}/src/gateway/server.ts";`,
		`import { startGateway } from "${root}/src/server.ts";`,
		`if (typeof createGatewayServer !== "function" || typeof startGateway !== "function") process.exit(1);`,
		`const listeners = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");`,
		`process.stdout.write("ok:" + listeners);`,
		`process.exit(0);`,
	].join("\n");
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-import-"));
	const scriptPath = join(directory, "import-check.mts");
	writeFileSync(scriptPath, script, "utf8");
	try {
		const result = await new Promise<{ code: number | null; stdout: string }>(
			(resolveRun) => {
				const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
					cwd: resolve("."),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
				});
				child.once("exit", (code) => resolveRun({ code, stdout }));
			},
		);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "ok:0");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("startGateway 在路由未就绪时拒绝启动并释放 transport", async () => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-gateway-notready-"));
	const configPath = join(directory, "config.json");
	const keyPath = join(directory, "gateway-api-key");
	writeFileSync(
		configPath,
		JSON.stringify({
			providers: [{ id: "brave", type: "brave", apiKey: "k" }],
			search: { providers: ["brave"] },
			extract: { providers: ["firecrawl"] },
		}),
		"utf8",
	);
	writeFileSync(keyPath, `${API_KEY}\n`, "utf8");
	try {
		const { startGateway } = await import("../src/server.ts");
		await assert.rejects(
			startGateway({
				PATH: process.env.PATH ?? "",
				SystemRoot: process.env.SystemRoot ?? "",
				WEB_ACCESS_CONFIG: configPath,
				WEB_ACCESS_GATEWAY_API_KEY_FILE: keyPath,
				WEB_ACCESS_GATEWAY_HOST: "127.0.0.1",
				WEB_ACCESS_GATEWAY_PORT: String(await freePort()),
			}),
			/extract_route_unconfigured/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
