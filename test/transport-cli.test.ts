import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createProgram } from "../src/cli.ts";
import type { OutputEnvelope } from "../src/core/types.ts";
import { getAdapter } from "../src/providers/registry.ts";
import { DefaultHttpTransport } from "../src/transport/http.ts";
import { VERSION } from "../src/version.ts";
import { instance } from "./helpers.ts";

async function serverUrl(t: TestContext): Promise<string> {
	const server = createServer((request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { Location: "/final" });
			response.end();
			return;
		}
		if (request.url === "/large") {
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.end("x".repeat(200));
			return;
		}
		response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("redirect complete");
	});
	await new Promise<void>((resolveListen) =>
		server.listen(0, "127.0.0.1", resolveListen),
	);
	t.after(
		() =>
			new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("测试服务器未监听 TCP 端口");
	return `http://127.0.0.1:${address.port}`;
}

test("HTTP transport 跟随重定向并执行响应大小硬上限", async (t) => {
	const baseUrl = await serverUrl(t);
	const previousNoProxy = process.env.NO_PROXY;
	process.env.NO_PROXY = "127.0.0.1,localhost";
	try {
		const transport = new DefaultHttpTransport();
		const result = await transport.request(`${baseUrl}/redirect`, {
			signal: new AbortController().signal,
			maxResponseBytes: 1024,
		});
		assert.equal(result.status, 200);
		assert.equal(result.body, "redirect complete");
		await assert.rejects(
			transport.request(`${baseUrl}/large`, {
				signal: new AbortController().signal,
				maxResponseBytes: 50,
			}),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "response_too_large",
		);
	} finally {
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
	}
});

test("DeepSeek adapter 严格拒绝重定向且不接触 Location 目标", async (t) => {
	let targetRequests = 0;
	const target = createServer((_request, response) => {
		targetRequests++;
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(
			JSON.stringify({
				content: [{ type: "web_search_tool_result", content: [] }],
			}),
		);
	});
	await new Promise<void>((resolveListen) =>
		target.listen(0, "127.0.0.1", resolveListen),
	);
	t.after(
		() =>
			new Promise<void>((resolveClose) => target.close(() => resolveClose())),
	);
	const targetAddress = target.address();
	if (!targetAddress || typeof targetAddress === "string")
		throw new Error("目标测试服务器未监听 TCP 端口");

	const redirect = createServer((_request, response) => {
		response.writeHead(302, {
			Location: `http://127.0.0.1:${targetAddress.port}/result`,
		});
		response.end();
	});
	await new Promise<void>((resolveListen) =>
		redirect.listen(0, "127.0.0.1", resolveListen),
	);
	t.after(
		() =>
			new Promise<void>((resolveClose) => redirect.close(() => resolveClose())),
	);
	const redirectAddress = redirect.address();
	if (!redirectAddress || typeof redirectAddress === "string")
		throw new Error("重定向测试服务器未监听 TCP 端口");

	const previousNoProxy = process.env.NO_PROXY;
	process.env.NO_PROXY = "127.0.0.1,localhost";
	try {
		const adapter = getAdapter("deepseek", "search");
		assert.ok(adapter?.search);
		await assert.rejects(
			adapter.search({
				query: "redirect policy",
				limit: 5,
				includeDomains: [],
				excludeDomains: [],
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
				instance: instance("deepseek", {
					baseUrl: `http://127.0.0.1:${redirectAddress.port}`,
				}),
				transport: new DefaultHttpTransport(),
			}),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "provider_error",
		);
		assert.equal(targetRequests, 0);
	} finally {
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
	}
});

test("DeepSeek 通过统一 transport 映射取消与网络失败", async (t) => {
	let markRequestStarted: (() => void) | undefined;
	const requestStarted = new Promise<void>((resolveStarted) => {
		markRequestStarted = resolveStarted;
	});
	const hanging = createServer(() => {
		markRequestStarted?.();
	});
	await new Promise<void>((resolveListen) =>
		hanging.listen(0, "127.0.0.1", resolveListen),
	);
	t.after(
		() =>
			new Promise<void>((resolveClose) => hanging.close(() => resolveClose())),
	);
	const hangingAddress = hanging.address();
	if (!hangingAddress || typeof hangingAddress === "string")
		throw new Error("取消测试服务器未监听 TCP 端口");

	const closed = createServer();
	await new Promise<void>((resolveListen) =>
		closed.listen(0, "127.0.0.1", resolveListen),
	);
	const closedAddress = closed.address();
	if (!closedAddress || typeof closedAddress === "string")
		throw new Error("网络失败测试服务器未监听 TCP 端口");
	await new Promise<void>((resolveClose) => closed.close(() => resolveClose()));

	const previousNoProxy = process.env.NO_PROXY;
	process.env.NO_PROXY = "127.0.0.1,localhost";
	try {
		const adapter = getAdapter("deepseek", "search");
		assert.ok(adapter?.search);
		const controller = new AbortController();
		const cancelled = adapter.search({
			query: "cancel",
			limit: 5,
			includeDomains: [],
			excludeDomains: [],
			signal: controller.signal,
			maxResponseBytes: 1024,
			instance: instance("deepseek", {
				baseUrl: `http://127.0.0.1:${hangingAddress.port}`,
			}),
			transport: new DefaultHttpTransport(),
		});
		await requestStarted;
		controller.abort();
		await assert.rejects(
			cancelled,
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "aborted",
		);

		await assert.rejects(
			adapter.search({
				query: "network",
				limit: 5,
				includeDomains: [],
				excludeDomains: [],
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
				instance: instance("deepseek", {
					baseUrl: `http://127.0.0.1:${closedAddress.port}`,
				}),
				transport: new DefaultHttpTransport(),
			}),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "network_error" &&
				"retryable" in error &&
				error.retryable === true,
		);
	} finally {
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
	}
});

test("CLI 输入错误也只在 stdout 输出一个 JSON envelope，并返回退出码 2", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "src/cli.ts", "extract", "ftp://example.com"],
		{
			cwd: resolve("."),
			encoding: "utf8",
			env: { ...process.env, WEB_ACCESS_CONFIG: "" },
		},
	);
	assert.equal(result.status, 2);
	assert.equal(result.stderr, "");
	const lines = result.stdout.trim().split(/\r?\n/);
	assert.equal(lines.length, 1);
	const envelope = JSON.parse(lines[0] ?? "{}") as {
		ok?: boolean;
		error?: { code?: string };
	};
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error?.code, "invalid_input");
});

test("CLI 自身的参数解析错误不会向 stderr 泄漏文本", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "src/cli.ts", "search"],
		{ cwd: resolve("."), encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout) as {
		ok?: boolean;
		error?: { code?: string };
	};
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error?.code, "invalid_input");
});

test("CLI 注册 config edit 并向实现转发全局配置路径", async () => {
	const tasks: Array<() => Promise<OutputEnvelope> | OutputEnvelope> = [];
	let explicitPath: string | undefined;
	const program = createProgram((task) => tasks.push(task), {
		executeConfigEdit: async (options) => {
			explicitPath = options?.explicitPath;
			return {
				schemaVersion: 1,
				ok: true,
				command: "config.edit",
				durationMs: 0,
				data: {
					path: resolve("chosen-config.json"),
					created: true,
					opened: true,
				},
			};
		},
	});

	await program.parseAsync([
		"node",
		"web-access",
		"--config",
		"./chosen-config.json",
		"config",
		"edit",
	]);
	assert.equal(tasks.length, 1);
	const envelope = await tasks[0]?.();
	assert.equal(explicitPath, "./chosen-config.json");
	assert.equal(envelope?.command, "config.edit");
});

test("CLI config edit 的路径错误保持单 JSON 与退出码契约", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"src/cli.ts",
			"--config",
			resolve("."),
			"config",
			"edit",
		],
		{ cwd: resolve("."), encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.equal(result.stderr, "");
	const lines = result.stdout.trim().split(/\r?\n/);
	assert.equal(lines.length, 1);
	const envelope = JSON.parse(lines[0] ?? "{}") as {
		command?: string;
		error?: { code?: string };
	};
	assert.equal(envelope.command, "config.edit");
	assert.equal(envelope.error?.code, "config_error");
});

test("CLI config 缺少 edit 子命令时返回输入错误 envelope", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "src/cli.ts", "config"],
		{ cwd: resolve("."), encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout) as {
		command?: string | null;
		error?: { code?: string };
	};
	assert.equal(envelope.command, null);
	assert.equal(envelope.error?.code, "invalid_input");
});

test("CLI 通过符号链接入口运行时仍会执行主程序", () => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-cli-link-"));
	const repositoryLink = join(directory, "repository");
	try {
		symlinkSync(
			resolve("."),
			repositoryLink,
			process.platform === "win32" ? "junction" : "dir",
		);
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(repositoryLink, "src", "cli.ts"), "--version"],
			{ cwd: resolve("."), encoding: "utf8" },
		);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout.trim(), VERSION);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
