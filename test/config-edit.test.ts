import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config/config.ts";
import {
	CONFIG_SCHEMA_URL,
	ensureConfigFile,
	executeConfigEdit,
} from "../src/config/edit.ts";
import { WebAccessError } from "../src/core/errors.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "web-access-config-edit-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("config edit 创建完整默认配置后再调用编辑器", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "nested", "config.json");
	const ignoredEnvPath = join(directory, "ignored.json");
	const opened: string[] = [];
	const envelope = await executeConfigEdit({
		explicitPath: path,
		env: { WEB_ACCESS_CONFIG: ignoredEnvPath, EDITOR: "test-editor" },
		openPath: async (target, editor) => {
			assert.deepEqual(editor, {
				variable: "EDITOR",
				command: "test-editor",
				arguments: [],
			});
			assert.equal(typeof JSON.parse(await readFile(target, "utf8")), "object");
			opened.push(target);
		},
	});

	assert.equal(envelope.command, "config.edit");
	assert.deepEqual(envelope.data, { path, created: true, opened: true });
	assert.deepEqual(opened, [path]);

	const contents = await readFile(path, "utf8");
	const parsed = JSON.parse(contents) as Record<string, unknown>;
	assert.equal(parsed.$schema, CONFIG_SCHEMA_URL);
	assert.deepEqual(parsed.providers, [
		{ id: "tavily", type: "tavily" },
		{ id: "exa", type: "exa" },
		{ id: "bocha", type: "bocha" },
		{ id: "brave", type: "brave" },
		{ id: "searxng", type: "searxng" },
		{ id: "firecrawl", type: "firecrawl" },
		{ id: "jina", type: "jina" },
		{ id: "http", type: "http" },
		{ id: "anysearch", type: "anysearch", searchFilterMode: "strict" },
		{ id: "xcrawl", type: "xcrawl", searchFilterMode: "strict" },
		{ id: "deepseek", type: "deepseek" },
		{ id: "xai_x_search", type: "xai_x_search" },
		{ id: "xai_web_search", type: "xai_web_search" },
	]);
	assert.deepEqual(parsed.search, {
		providers: [
			"tavily",
			"exa",
			"bocha",
			"brave",
			"searxng",
			"anysearch",
			"xcrawl",
		],
		providers_fallback: ["deepseek", "xai_x_search", "xai_web_search"],
		limit: 5,
		timeoutMs: 120_000,
		attemptTimeoutMs: 60_000,
		maxResponseBytes: 5 * 1024 * 1024,
	});
	assert.deepEqual(parsed.extract, {
		providers: ["firecrawl", "jina", "exa", "anysearch", "xcrawl"],
		providers_fallback: ["http"],
		timeoutMs: 120_000,
		attemptTimeoutMs: 45_000,
		maxResponseBytes: 5 * 1024 * 1024,
		minContentCharacters: 500,
	});
	assert.equal(loadConfig(path, {}).exists, true);

	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
	}
});

test("config edit 原样打开已有的无效 JSON 文件", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");
	const original = "尚未完成的配置\n";
	await writeFile(path, original, "utf8");
	const before = await stat(path);
	const opened: string[] = [];

	const envelope = await executeConfigEdit({
		explicitPath: path,
		env: { EDITOR: "test-editor" },
		openPath: async (target) => {
			opened.push(target);
		},
	});

	const after = await stat(path);
	assert.equal(envelope.data.created, false);
	assert.deepEqual(opened, [path]);
	assert.equal(await readFile(path, "utf8"), original);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("config edit 打开失败时保留刚创建的配置文件", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");
	const openFailure = new Error("open failure sentinel");

	await assert.rejects(
		executeConfigEdit({
			explicitPath: path,
			env: { EDITOR: "test-editor" },
			openPath: async () => {
				throw openFailure;
			},
		}),
		(error: unknown) => {
			assert.equal(error instanceof WebAccessError, true);
			if (!(error instanceof WebAccessError)) return false;
			assert.equal(error.code, "open_failed");
			assert.equal(error.retryable, false);
			assert.equal(typeof error.details, "object");
			assert.notEqual(error.details, null);
			const details = error.details as Record<string, unknown>;
			assert.equal(details.path, path);
			assert.equal(details.created, true);
			assert.equal(details.cause, openFailure.message);
			return true;
		},
	);

	assert.equal(
		JSON.parse(await readFile(path, "utf8")).$schema,
		CONFIG_SCHEMA_URL,
	);
});

test("config edit 拒绝把目录当作配置文件", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");
	await mkdir(path);
	let opened = false;

	await assert.rejects(
		executeConfigEdit({
			explicitPath: path,
			env: { EDITOR: "test-editor" },
			openPath: async () => {
				opened = true;
			},
		}),
		(error: unknown) =>
			error instanceof WebAccessError && error.code === "config_error",
	);
	assert.equal(opened, false);
});

test("config edit 优先使用 VISUAL，并将参数和配置路径分开传递", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "folder with spaces", "config.json");
	let received:
		| { path: string; command: string; arguments: string[] }
		| undefined;

	await executeConfigEdit({
		explicitPath: path,
		env: {
			VISUAL: '"C:\\Program Files\\Editor\\editor.exe" --reuse-window',
			EDITOR: "fallback-editor --should-not-run",
		},
		openPath: async (target, editor) => {
			received = {
				path: target,
				command: editor.command,
				arguments: editor.arguments,
			};
		},
	});

	assert.deepEqual(received, {
		path,
		command: "C:\\Program Files\\Editor\\editor.exe",
		arguments: ["--reuse-window"],
	});
});

test("config edit 在 VISUAL 为空时使用 EDITOR，并在缺少编辑器时失败", async (t) => {
	const directory = await temporaryDirectory(t);
	const fallbackPath = join(directory, "fallback.json");
	let selected: string | undefined;

	await executeConfigEdit({
		explicitPath: fallbackPath,
		env: { VISUAL: "  ", EDITOR: "nano --literal" },
		openPath: async (_path, editor) => {
			selected = `${editor.variable}:${editor.command}:${editor.arguments.join(",")}`;
		},
	});
	assert.equal(selected, "EDITOR:nano:--literal");

	const missingPath = join(directory, "missing.json");
	await assert.rejects(
		executeConfigEdit({
			explicitPath: missingPath,
			env: { VISUAL: "", EDITOR: " " },
		}),
		(error: unknown) =>
			error instanceof WebAccessError &&
			error.code === "open_failed" &&
			error.details &&
			typeof error.details === "object" &&
			(error.details as Record<string, unknown>).created === true,
	);
	assert.equal(
		(await readFile(missingPath, "utf8")).includes('"$schema"'),
		true,
	);
});

test("config edit 拒绝未闭合引号且不回退到 EDITOR", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "invalid-editor.json");
	let opened = false;

	await assert.rejects(
		executeConfigEdit({
			explicitPath: path,
			env: { VISUAL: '"broken-editor', EDITOR: "working-editor" },
			openPath: async () => {
				opened = true;
			},
		}),
		(error: unknown) =>
			error instanceof WebAccessError && error.code === "open_failed",
	);
	assert.equal(opened, false);
});

test("config edit 接受普通文件符号链接并拒绝断链", {
	skip: process.platform === "win32",
}, async (t) => {
	const directory = await temporaryDirectory(t);
	const target = join(directory, "target.json");
	const link = join(directory, "config.json");
	await writeFile(target, "{}\n", "utf8");
	await symlink(target, link, "file");
	assert.equal(await ensureConfigFile(link), false);
	assert.equal(await readFile(target, "utf8"), "{}\n");

	const broken = join(directory, "broken.json");
	await symlink(join(directory, "missing.json"), broken, "file");
	await assert.rejects(
		ensureConfigFile(broken),
		(error: unknown) =>
			error instanceof WebAccessError && error.code === "config_error",
	);
	assert.equal((await lstat(broken)).isSymbolicLink(), true);
});
