import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ConfigError,
	capabilitySupports,
	getDefaultConfigPath,
	loadConfig,
	resolveConfigPath,
} from "../src/config/config.ts";
import { executeDoctor, executeProviders } from "../src/core/diagnostics.ts";

function configFile(value: unknown): { path: string; cleanup(): void } {
	const directory = mkdtempSync(join(tmpdir(), "web-access-config-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		path,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function isConfigError(error: unknown): boolean {
	assert.equal(error instanceof ConfigError, true);
	if (!(error instanceof ConfigError)) return false;
	assert.equal(error.code, "config_error");
	return true;
}

test("配置支持同类型多 instance、严格 route，并让环境变量覆盖明文 key", () => {
	const fixture = configFile({
		providers: [
			{
				id: "exa_team",
				type: "exa",
				apiKey: "config-key",
				apiKeyEnv: "TEAM_EXA_KEY",
				headers: { "X-Team": "docs" },
			},
		],
		search: { providers: ["exa_team"], limit: 8 },
		extract: { providers: ["http"], minContentCharacters: 20 },
	});
	try {
		const loaded = loadConfig(fixture.path, { TEAM_EXA_KEY: "env-key" });
		assert.deepEqual(loaded.app.search.providers, ["exa_team"]);
		assert.deepEqual(loaded.app.extract.providers, ["http"]);
		assert.equal(loaded.app.search.limit, 8);
		const exa = loaded.instances.find((provider) => provider.id === "exa_team");
		assert.equal(exa?.apiKey, "env-key");
		assert.equal(exa?.credentialSource, "custom_env");
		assert.equal(exa?.headers["X-Team"], "docs");
	} finally {
		fixture.cleanup();
	}
});

test("配置拒绝未知字段与不存在的 route instance", () => {
	const unknown = configFile({ search: { answer: true } });
	const missing = configFile({ search: { providers: ["ghost"] } });
	try {
		assert.throws(() => loadConfig(unknown.path, {}), ConfigError);
		assert.throws(() => loadConfig(missing.path, {}), isConfigError);
	} finally {
		unknown.cleanup();
		missing.cleanup();
	}
});

test("AnySearch 配置支持匿名、标准环境变量和专属过滤模式", () => {
	const fixture = configFile({
		providers: [
			{ id: "anysearch", type: "anysearch", searchFilterMode: "best_effort" },
		],
		search: { providers: ["anysearch"] },
		extract: { providers: ["anysearch"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			ANYSEARCH_BASE_URL: "https://custom.anysearch.test/",
		});
		const anysearch = loaded.instances.find((item) => item.id === "anysearch");
		assert.equal(anysearch?.baseUrl, "https://custom.anysearch.test");
		assert.equal(anysearch?.apiKey, null);
		assert.equal(anysearch?.searchFilterMode, "best_effort");
	} finally {
		fixture.cleanup();
	}
});

test("XCrawl 配置标准环境变量、双能力和过滤模式", () => {
	const fixture = configFile({
		providers: [
			{ id: "xcrawl", type: "xcrawl", searchFilterMode: "best_effort" },
		],
		search: { providers: ["xcrawl"] },
		extract: { providers: ["xcrawl"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			XCRAWL_API_KEY: "xcrawl-key",
			XCRAWL_BASE_URL: "https://xcrawl.internal/",
		});
		const xcrawl = loaded.instances.find((item) => item.id === "xcrawl");
		assert.equal(xcrawl?.apiKey, "xcrawl-key");
		assert.equal(xcrawl?.credentialSource, "standard_env");
		assert.equal(xcrawl?.baseUrl, "https://xcrawl.internal");
		assert.equal(xcrawl?.baseUrlSource, "standard_env");
		assert.equal(xcrawl?.searchFilterMode, "best_effort");
		const provider = (
			executeProviders(loaded).data as {
				providers: Array<Record<string, unknown>>;
			}
		).providers.find((item) => item.id === "xcrawl");
		assert.deepEqual(provider?.capabilities, ["search", "extract"]);
		assert.deepEqual(provider?.routes, { search: true, extract: true });
		assert.equal(executeDoctor(loaded).ok, true);
	} finally {
		fixture.cleanup();
	}
});

test("XCrawl 缺少凭据时 doctor 报告未完成配置", () => {
	const fixture = configFile({
		search: { providers: ["xcrawl"] },
		extract: { providers: [] },
	});
	try {
		const loaded = loadConfig(fixture.path, {});
		const xcrawl = loaded.instances.find((item) => item.id === "xcrawl");
		assert.equal(xcrawl?.baseUrl, "https://run.xcrawl.com");
		assert.equal(xcrawl?.apiKey, null);
		assert.equal(executeDoctor(loaded).ok, false);
	} finally {
		fixture.cleanup();
	}
});

test("不支持过滤策略的 instance 拒绝 searchFilterMode", () => {
	const fixture = configFile({
		providers: [{ id: "http", type: "http", searchFilterMode: "strict" }],
	});
	try {
		assert.throws(() => loadConfig(fixture.path, {}), isConfigError);
	} finally {
		fixture.cleanup();
	}
});

test("providers 省略或为空时合并全部内置 instance，自定义 id 只追加配置", () => {
	const omitted = configFile({});
	const empty = configFile({ providers: [] });
	const custom = configFile({ providers: [{ id: "exa_team", type: "exa" }] });
	const builtinIds = [
		"tavily",
		"exa",
		"brave",
		"searxng",
		"firecrawl",
		"jina",
		"http",
		"anysearch",
		"xcrawl",
	];
	try {
		assert.deepEqual(
			loadConfig(omitted.path, {}).instances.map((item) => item.id),
			builtinIds,
		);
		assert.deepEqual(
			loadConfig(empty.path, {}).instances.map((item) => item.id),
			builtinIds,
		);
		const customized = loadConfig(custom.path, {});
		assert.deepEqual(
			customized.instances.map((item) => item.id),
			[...builtinIds, "exa_team"],
		);
		assert.equal(customized.app.search.providers.includes("exa_team"), false);
		assert.equal(customized.app.extract.providers.includes("exa_team"), false);
	} finally {
		omitted.cleanup();
		empty.cleanup();
		custom.cleanup();
	}
});

test("缺省 route 覆盖全部支持能力的内置 provider，显式空 route 保持禁用", () => {
	const defaults = configFile({});
	const disabled = configFile({
		search: { providers: [] },
		extract: { providers: [] },
	});
	try {
		const loaded = loadConfig(defaults.path, {});
		assert.deepEqual(loaded.app.search.providers, [
			"tavily",
			"exa",
			"brave",
			"searxng",
			"anysearch",
			"xcrawl",
		]);
		assert.deepEqual(loaded.app.extract.providers, [
			"firecrawl",
			"jina",
			"exa",
			"anysearch",
			"xcrawl",
			"http",
		]);
		const providerDiagnostics = (
			executeProviders(loaded).data as {
				providers: Array<{
					id: string;
					routes: { search: boolean; extract: boolean };
				}>;
			}
		).providers;
		for (const id of ["anysearch", "xcrawl"]) {
			assert.deepEqual(
				providerDiagnostics.find((provider) => provider.id === id)?.routes,
				{ search: true, extract: true },
			);
		}
		for (const capability of ["search", "extract"] as const) {
			const route =
				capability === "search"
					? loaded.app.search.providers
					: loaded.app.extract.providers;
			const supported = loaded.instances
				.filter((instance) => capabilitySupports(instance.type, capability))
				.map((instance) => instance.id);
			assert.equal(new Set(route).size, route.length);
			assert.deepEqual([...route].sort(), supported.sort());
		}
		const emptyRoutes = loadConfig(disabled.path, {});
		assert.deepEqual(emptyRoutes.app.search.providers, []);
		assert.deepEqual(emptyRoutes.app.extract.providers, []);
	} finally {
		defaults.cleanup();
		disabled.cleanup();
	}
});

test("只读取显式或用户级配置路径", () => {
	const resolved = resolveConfigPath("./nested/config.json", {});
	assert.equal(resolved, join(process.cwd(), "nested", "config.json"));
	assert.equal(
		resolveConfigPath(undefined, {
			WEB_ACCESS_CONFIG: "./env-config.json",
		}),
		join(process.cwd(), "env-config.json"),
	);
	assert.equal(
		getDefaultConfigPath(),
		join(homedir(), ".config", "web-access-cli", "config.json"),
	);
	assert.equal(resolveConfigPath(undefined, {}), getDefaultConfigPath());
	const fixture = configFile({});
	try {
		const loaded = loadConfig(fixture.path, {});
		assert.deepEqual(loaded.app.search.providers, [
			"tavily",
			"exa",
			"brave",
			"searxng",
			"anysearch",
			"xcrawl",
		]);
		assert.deepEqual(loaded.app.extract.providers, [
			"firecrawl",
			"jina",
			"exa",
			"anysearch",
			"xcrawl",
			"http",
		]);
		assert.equal(
			loaded.instances.find((item) => item.id === "xcrawl")?.searchFilterMode,
			"strict",
		);
	} finally {
		fixture.cleanup();
	}
});
