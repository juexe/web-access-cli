import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

function runCli(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", "src/cli.ts", ...args],
			{
				cwd: resolve("."),
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
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
		child.once("error", rejectRun);
		child.once("close", (status) => resolveRun({ status, stdout, stderr }));
	});
}

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

async function extractServerUrl(t: TestContext): Promise<string> {
	const server = createServer((request, response) => {
		if (request.url === "/fail") {
			response.writeHead(500, { "Content-Type": "text/plain" });
			response.end("temporary failure");
			return;
		}
		if (request.url !== "/article") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			'<!doctype html><html><head><title>Example "title"</title></head>' +
				"<body><main><h1>Article content</h1><p>Enough content for extraction.</p></main></body></html>",
		);
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
		throw new Error("提取测试服务器未监听 TCP 端口");
	return `http://127.0.0.1:${address.port}`;
}

async function anySearchExtractServerUrl(t: TestContext): Promise<string> {
	const server = createServer((request, response) => {
		if (request.url !== "/v1/extract") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
		});
		response.end(
			JSON.stringify({
				code: 0,
				message: "success",
				data: {
					url: "https://example.com/anysearch-final",
					title: "AnySearch title",
					content: "# AnySearch Markdown\n\n正文来自 content 字段。",
				},
			}),
		);
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
		throw new Error("AnySearch 测试服务器未监听 TCP 端口");
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

test("CLI 将成功 provider 写到队头并在下一进程优先使用", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-cli-order-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const requests = { a: 0, b: 0 };
	const server = createServer((request, response) => {
		if (request.url?.startsWith("/a/search")) {
			requests.a += 1;
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "temporary" }));
			return;
		}
		if (request.url?.startsWith("/b/search")) {
			requests.b += 1;
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					results: [
						{
							title: "Learned result",
							url: "https://example.com/learned",
							content: "second provider succeeded",
						},
					],
				}),
			);
			return;
		}
		response.writeHead(404).end();
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
		throw new Error("自适应排序测试服务器未监听 TCP 端口");

	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: [
				{
					id: "search_a",
					type: "searxng",
					baseUrl: `http://127.0.0.1:${address.port}/a`,
				},
				{
					id: "search_b",
					type: "searxng",
					baseUrl: `http://127.0.0.1:${address.port}/b`,
				},
			],
			search: { providers: ["search_a", "search_b"] },
			extract: { providers: ["http"] },
		}),
		"utf8",
	);
	const env = {
		...process.env,
		NO_PROXY: "127.0.0.1,localhost",
		WEB_ACCESS_CONFIG: "",
	};

	const first = await runCli(
		["--config", path, "search", "adaptive", "--json"],
		env,
	);
	assert.equal(first.status, 0);
	assert.equal(first.stderr, "");
	assert.equal(JSON.parse(first.stdout).provider, "search_b");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).search.providers, [
		"search_b",
		"search_a",
	]);

	const second = await runCli(
		["--config", path, "search", "adaptive", "--json"],
		env,
	);
	assert.equal(second.status, 0);
	assert.equal(second.stderr, "");
	assert.equal(JSON.parse(second.stdout).provider, "search_b");
	assert.deepEqual(requests, { a: 1, b: 2 });
});

test("CLI extract 默认输出 Markdown，--json 输出 JSON", async (t) => {
	const baseUrl = await extractServerUrl(t);
	const directory = mkdtempSync(
		join(tmpdir(), "web-access-cli-extract-output-"),
	);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: [{ id: "local_http", type: "http" }],
			extract: { providers: ["local_http"], minContentCharacters: 1 },
		}),
		"utf8",
	);
	const env = {
		...process.env,
		NO_PROXY: "127.0.0.1,localhost",
		WEB_ACCESS_CONFIG: "",
	};
	const args = ["--config", path, "extract", `${baseUrl}/article`];

	const markdown = await runCli(args, env);
	assert.equal(markdown.status, 0);
	assert.equal(markdown.stderr, "");
	assert.match(
		markdown.stdout,
		/^---\nprovider: "local_http"\nurl: ".*\/article"\ntitle: "Example \\"title\\""\n---\n\n/,
	);
	assert.match(markdown.stdout, /Article content/);
	assert.equal(markdown.stdout.trimStart().startsWith("{"), false);

	const json = await runCli([...args, "--json"], env);
	assert.equal(json.status, 0);
	assert.equal(json.stderr, "");
	const envelope = JSON.parse(json.stdout) as Record<string, unknown>;
	assert.equal(envelope.schemaVersion, 2);
	assert.equal(envelope.ok, true);
	assert.equal(envelope.provider, "local_http");
	assert.equal(json.stdout.trimStart().startsWith("---"), false);

	const failure = await runCli([...args.slice(0, -1), `${baseUrl}/fail`], env);
	assert.equal(failure.status, 1);
	assert.equal(failure.stderr, "");
	const failureEnvelope = JSON.parse(failure.stdout) as Record<string, unknown>;
	assert.equal(failureEnvelope.ok, false);
	assert.equal(
		failureEnvelope.error && typeof failureEnvelope.error === "object",
		true,
	);
	assert.equal(failure.stdout.trimStart().startsWith("---"), false);
});

test("CLI extract AnySearch 只输出 data.content 中的 Markdown", async (t) => {
	const baseUrl = await anySearchExtractServerUrl(t);
	const directory = mkdtempSync(
		join(tmpdir(), "web-access-cli-anysearch-extract-"),
	);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: [
				{ id: "anysearch_local", type: "anysearch", baseUrl: baseUrl },
			],
			extract: { providers: ["anysearch_local"], minContentCharacters: 1 },
		}),
		"utf8",
	);
	const result = await runCli(
		["--config", path, "extract", "https://example.com/article"],
		{ ...process.env, NO_PROXY: "127.0.0.1,localhost", WEB_ACCESS_CONFIG: "" },
	);
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	assert.match(result.stdout, /provider: "anysearch_local"/);
	assert.match(result.stdout, /# AnySearch Markdown/);
	assert.match(result.stdout, /正文来自 content 字段/);
	assert.equal(result.stdout.includes('"code":0'), false);
	assert.equal(result.stdout.includes('"data"'), false);
});

test("CLI 输入错误保持单 JSON、空 stderr 与退出码契约", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "web-access-cli-input-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			providers: [
				{ id: "tavily", type: "tavily" },
				{ id: "http", type: "http" },
			],
			search: { providers: ["tavily"] },
			extract: { providers: ["http"] },
		}),
		"utf8",
	);
	const cases = [
		{
			name: "应用校验错误不受 JSON 选项污染",
			args: ["extract", "ftp://example.com", "--json"],
			assertEnvelope: (envelope: Record<string, unknown>) => {
				assert.equal("command" in envelope, false);
				assert.equal("debug" in envelope, false);
			},
		},
		{
			name: "Commander 参数解析错误",
			args: ["search"],
			assertEnvelope: (envelope: Record<string, unknown>) => {
				assert.equal("command" in envelope, false);
			},
		},
		{
			name: "config 缺少 edit 子命令",
			args: ["config"],
			assertEnvelope: (envelope: Record<string, unknown>) => {
				assert.equal(envelope.command, null);
			},
		},
	];

	for (const item of cases) {
		await t.test(item.name, () => {
			const result = spawnSync(
				process.execPath,
				["--import", "tsx", "src/cli.ts", ...item.args],
				{
					cwd: resolve("."),
					encoding: "utf8",
					env: { ...process.env, WEB_ACCESS_CONFIG: configPath },
				},
			);
			assert.equal(result.status, 2);
			assert.equal(result.stderr, "");
			const lines = result.stdout.trim().split(/\r?\n/);
			assert.equal(lines.length, 1);
			const envelope = JSON.parse(lines[0] ?? "{}") as Record<
				string,
				unknown
			> & { error?: { code?: string } };
			assert.equal(envelope.schemaVersion, 2);
			assert.equal(envelope.ok, false);
			assert.equal(envelope.error?.code, "invalid_input");
			item.assertEnvelope(envelope);
		});
	}
});

test("CLI 注册 config edit 并向实现转发全局配置路径", async () => {
	const tasks: Array<() => Promise<OutputEnvelope> | OutputEnvelope> = [];
	let explicitPath: string | undefined;
	const program = createProgram((task) => tasks.push(task), {
		executeConfigEdit: async (options) => {
			explicitPath = options?.explicitPath;
			return {
				schemaVersion: 2,
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
	assert.equal(
		envelope && "command" in envelope ? envelope.command : undefined,
		"config.edit",
	);
});

test("CLI 注册 config init、转发路径并区分默认路径输出和 JSON", async () => {
	const tasks: Array<() => Promise<OutputEnvelope> | OutputEnvelope> = [];
	const modes: string[] = [];
	let explicitPath: string | undefined;
	const program = createProgram(
		(task, mode) => {
			tasks.push(task);
			modes.push(mode ?? "json");
		},
		{
			executeConfigInit: async (options) => {
				explicitPath = options?.explicitPath;
				return {
					schemaVersion: 2,
					ok: true,
					command: "config.init",
					durationMs: 0,
					data: {
						path: resolve("chosen-config.json"),
						created: true,
						searchProviders: ["tavily"],
						searchFallbackProviders: [],
						extractProviders: ["firecrawl"],
						extractFallbackProviders: ["http"],
					},
				};
			},
		},
	);

	await program.parseAsync([
		"node",
		"web-access",
		"--config",
		"./chosen-config.json",
		"config",
		"init",
	]);
	await program.parseAsync([
		"node",
		"web-access",
		"--config",
		"./chosen-config.json",
		"config",
		"init",
		"--json",
	]);
	assert.equal(tasks.length, 2);
	assert.deepEqual(modes, ["path", "json"]);
	await tasks[0]?.();
	await tasks[1]?.();
	assert.equal(explicitPath, "./chosen-config.json");
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

test("CLI config edit 使用 VISUAL 启动编辑器并保持单 JSON 契约", async (t) => {
	const directory = mkdtempSync(
		join(tmpdir(), "web-access-config-editor-cli-"),
	);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	const result = await runCli(["--config", path, "config", "edit", "--json"], {
		...process.env,
		VISUAL: process.execPath,
		EDITOR: "definitely-not-used-editor",
		WEB_ACCESS_CONFIG: "",
	});

	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
	const lines = result.stdout.trim().split(/\r?\n/);
	assert.equal(lines.length, 1);
	const envelope = JSON.parse(lines[0] ?? "{}") as {
		schemaVersion?: number;
		ok?: boolean;
		command?: string;
		data?: { path?: string; created?: boolean; opened?: boolean };
	};
	assert.equal(envelope.schemaVersion, 2);
	assert.equal(envelope.ok, true);
	assert.equal(envelope.command, "config.edit");
	assert.deepEqual(envelope.data, { path, created: true, opened: true });
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
