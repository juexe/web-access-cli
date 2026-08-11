import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createProgram } from "../src/cli.ts";
import type { OutputEnvelope } from "../src/core/types.ts";
import { DefaultHttpTransport } from "../src/transport/http.ts";

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
		error?: { code?: string; message?: string };
	};
	assert.equal(envelope.command, null);
	assert.equal(envelope.error?.code, "invalid_input");
	assert.equal(envelope.error?.message, "必须指定 config 子命令");
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
		assert.equal(result.stdout.trim(), "0.1.0");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("生成的 JSON Schema 包含配置、请求与输出 schema", async () => {
	for (const name of ["config", "searchRequest", "extractRequest", "output"]) {
		const schema = JSON.parse(
			await readFile(resolve(`schemas/${name}.schema.json`), "utf8"),
		) as unknown;
		assert.equal(typeof schema, "object");
	}
	const outputSchema = await readFile(
		resolve("schemas/output.schema.json"),
		"utf8",
	);
	assert.match(outputSchema, /"const": "config\.edit"/);
});
