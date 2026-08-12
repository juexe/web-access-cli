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

test("config edit 创建完整默认配置后再调用系统打开器", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "nested", "config.json");
	const ignoredEnvPath = join(directory, "ignored.json");
	const opened: string[] = [];
	const ticks = [100, 108];
	const envelope = await executeConfigEdit({
		explicitPath: path,
		env: { WEB_ACCESS_CONFIG: ignoredEnvPath },
		openPath: async (target) => {
			assert.equal(typeof JSON.parse(await readFile(target, "utf8")), "object");
			opened.push(target);
		},
		now: () => ticks.shift() ?? 108,
	});

	assert.equal(envelope.command, "config.edit");
	assert.equal(envelope.durationMs, 8);
	assert.deepEqual(envelope.data, { path, created: true, opened: true });
	assert.deepEqual(opened, [path]);

	const contents = await readFile(path, "utf8");
	assert.equal(contents.endsWith("\n"), true);
	assert.equal(contents.includes("apiKey"), false);
	const parsed = JSON.parse(contents) as Record<string, unknown>;
	assert.equal(parsed.$schema, CONFIG_SCHEMA_URL);
	assert.deepEqual(parsed.providers, [
		{ id: "tavily", type: "tavily" },
		{ id: "exa", type: "exa" },
		{ id: "brave", type: "brave" },
		{ id: "searxng", type: "searxng" },
		{ id: "firecrawl", type: "firecrawl" },
		{ id: "jina", type: "jina" },
		{ id: "http", type: "http" },
		{ id: "anysearch", type: "anysearch", searchFilterMode: "strict" },
		{ id: "xcrawl", type: "xcrawl", searchFilterMode: "strict" },
	]);
	assert.deepEqual(parsed.search, {
		providers: ["tavily", "exa", "brave", "searxng"],
		limit: 5,
		timeoutMs: 60_000,
		attemptTimeoutMs: 20_000,
		maxResponseBytes: 5 * 1024 * 1024,
	});
	assert.deepEqual(parsed.extract, {
		providers: ["firecrawl", "jina", "exa", "http"],
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
		env: {},
		openPath: async (target) => {
			opened.push(target);
		},
	});

	const after = await stat(path);
	assert.equal(envelope.data.created, false);
	assert.deepEqual(opened, [path]);
	assert.equal(await readFile(path, "utf8"), original);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("config edit 打开失败时保留刚创建的配置文件", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");

	await assert.rejects(
		executeConfigEdit({
			explicitPath: path,
			env: {},
			openPath: async () => {
				throw new Error("没有可用的默认应用");
			},
		}),
		(error: unknown) => {
			assert.equal(error instanceof WebAccessError, true);
			if (!(error instanceof WebAccessError)) return false;
			assert.equal(error.code, "open_failed");
			assert.equal(error.retryable, false);
			assert.deepEqual(error.details, {
				path,
				created: true,
				cause: "没有可用的默认应用",
			});
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
			env: {},
			openPath: async () => {
				opened = true;
			},
		}),
		(error: unknown) =>
			error instanceof WebAccessError && error.code === "config_error",
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
