import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
	lstat,
	mkdtemp,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createDefaultAppConfig, loadConfig } from "../src/config/config.ts";
import { persistProviderOrder } from "../src/config/provider-order.ts";
import { reorderProviders } from "../src/core/provider-order.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "web-access-provider-order-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("稳定分组将成功者置顶、未尝试者居中、失败者置尾", () => {
	assert.deepEqual(
		reorderProviders(["a", "b", "c", "d"], {
			winner: "c",
			failed: ["a", "b"],
		}),
		["c", "d", "a", "b"],
	);
	assert.deepEqual(
		reorderProviders(["a", "b", "c"], { failed: ["a", "b", "c"] }),
		["a", "b", "c"],
	);
	assert.deepEqual(reorderProviders(["a", "b", "c"], { failed: ["a"] }), [
		"b",
		"c",
		"a",
	]);
});

test("写回只更新对应 capability 的内部顺序", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");
	const original = `{
  "providers": [
    { "id": "a", "type": "searxng", "baseUrl": "https://a.test" },
    { "id": "b", "type": "searxng", "baseUrl": "https://b.test" },
    { "id": "c", "type": "searxng", "baseUrl": "https://c.test" }
  ],
  "search": {
    "providers": ["a", "b", "c"]
  },
  "extract": {
    "providers": ["http"]
  }
}
`;
	await writeFile(path, original, "utf8");
	const loaded = loadConfig(path, {});

	await persistProviderOrder(
		loaded,
		{
			capability: "search",
			configuredProviders: ["a", "b", "c"],
			winner: "b",
			failed: ["a"],
		},
		{},
	);

	const contents = await readFile(path, "utf8");
	const parsed = JSON.parse(contents) as {
		search: { providers: string[]; _providers?: string[] };
		extract: { providers: string[]; _providers?: string[] };
	};
	assert.deepEqual(parsed.search.providers, ["a", "b", "c"]);
	assert.deepEqual(parsed.search._providers, ["b", "c", "a"]);
	assert.equal(parsed.extract._providers, undefined);
	assert.match(contents, / {2}"providers": \[/);
});

test("配置成员在请求期间变化时由用户 route 整组重置", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "config.json");
	await writeFile(
		path,
		JSON.stringify({
			providers: [
				{ id: "a", type: "searxng", baseUrl: "https://a.test" },
				{ id: "b", type: "searxng", baseUrl: "https://b.test" },
				{ id: "c", type: "searxng", baseUrl: "https://c.test" },
			],
			search: { providers: ["a", "b"] },
			extract: { providers: ["http"] },
		}),
		"utf8",
	);
	const loaded = loadConfig(path, {});
	await writeFile(
		path,
		JSON.stringify({
			providers: [
				{ id: "a", type: "searxng", baseUrl: "https://a.test" },
				{ id: "b", type: "searxng", baseUrl: "https://b.test" },
				{ id: "c", type: "searxng", baseUrl: "https://c.test" },
			],
			search: {
				providers: ["a", "b", "c"],
				_providers: ["b", "a", "c"],
			},
			extract: { providers: ["http"] },
		}),
		"utf8",
	);

	await persistProviderOrder(
		loaded,
		{
			capability: "search",
			configuredProviders: ["a", "b"],
			winner: "b",
			failed: ["a"],
		},
		{},
	);

	const parsed = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(parsed.search._providers, ["a", "b", "c"]);
});

test("默认配置缺失时创建完整配置并写入内部顺序", async (t) => {
	const directory = await temporaryDirectory(t);
	const path = join(directory, "nested", "config.json");
	const app = createDefaultAppConfig();

	await persistProviderOrder(
		{ path, exists: false, app, instances: [] },
		{
			capability: "search",
			configuredProviders: [...app.search.providers],
			winner: "exa",
			failed: ["tavily"],
		},
		{},
	);

	const parsed = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(parsed.search._providers, [
		"exa",
		"brave",
		"searxng",
		"anysearch",
		"xcrawl",
		"deepseek",
		"tavily",
	]);
	assert.equal(Array.isArray(parsed.providers), true);
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
	}
});

test("已有配置符号链接写入目标且保留链接", {
	skip: process.platform === "win32",
}, async (t) => {
	const directory = await temporaryDirectory(t);
	const target = join(directory, "target.json");
	const link = join(directory, "config.json");
	await writeFile(
		target,
		JSON.stringify({
			providers: [
				{ id: "a", type: "searxng", baseUrl: "https://a.test" },
				{ id: "b", type: "searxng", baseUrl: "https://b.test" },
			],
			search: { providers: ["a", "b"] },
			extract: { providers: ["http"] },
		}),
		"utf8",
	);
	await symlink(target, link, "file");
	const loaded = loadConfig(link, {});

	await persistProviderOrder(
		loaded,
		{
			capability: "search",
			configuredProviders: ["a", "b"],
			winner: "b",
			failed: ["a"],
		},
		{},
	);

	assert.equal((await lstat(link)).isSymbolicLink(), true);
	assert.deepEqual(
		JSON.parse(await readFile(target, "utf8")).search._providers,
		["b", "a"],
	);
});
