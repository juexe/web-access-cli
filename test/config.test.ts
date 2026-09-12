import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ConfigError,
	capabilitySupports,
	getDefaultConfigPath,
	getEffectiveRoute,
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

test("DeepSeek 使用标准 key、通用覆盖和 Search-only capability", () => {
	const fixture = configFile({
		providers: [
			{
				id: "deepseek",
				type: "deepseek",
				apiKey: "config-key",
				baseUrl: "https://deepseek.internal/anthropic/v1/",
				headers: { "X-Team": "search" },
			},
		],
		search: { providers: ["deepseek"] },
		extract: { providers: ["http"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			DEEPSEEK_API_KEY: "env-key",
			DEEPSEEK_BASE_URL: "https://ignored.example.com",
		});
		const deepseek = loaded.instances.find((item) => item.id === "deepseek");
		assert.equal(deepseek?.apiKey, "env-key");
		assert.equal(deepseek?.credentialSource, "standard_env");
		assert.equal(deepseek?.baseUrl, "https://deepseek.internal/anthropic/v1");
		assert.equal(deepseek?.baseUrlSource, "config");
		assert.equal(deepseek?.headers["X-Team"], "search");
		assert.equal(capabilitySupports("deepseek", "search"), true);
		assert.equal(capabilitySupports("deepseek", "extract"), false);
		const provider = (
			executeProviders(loaded).data as {
				providers: Array<Record<string, unknown>>;
			}
		).providers.find((item) => item.id === "deepseek");
		assert.deepEqual(provider?.capabilities, ["search"]);
		assert.deepEqual(provider?.routes, { search: true, extract: false });
		assert.equal(executeDoctor(loaded).ok, true);
	} finally {
		fixture.cleanup();
	}
});

test("DeepSeek 默认 endpoint 固定且缺少 key 时 doctor 失败", () => {
	const fixture = configFile({
		search: { providers: ["deepseek"] },
		extract: { providers: ["http"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			DEEPSEEK_BASE_URL: "https://ignored.example.com",
		});
		const deepseek = loaded.instances.find((item) => item.id === "deepseek");
		assert.equal(deepseek?.baseUrl, "https://api.deepseek.com/anthropic/v1");
		assert.equal(deepseek?.baseUrlSource, "default");
		assert.equal(deepseek?.apiKey, null);
		assert.equal(executeDoctor(loaded).ok, false);
	} finally {
		fixture.cleanup();
	}
});

test("xAI Search instance 使用 OAuth 文件、模型环境变量和 Search-only capability", () => {
	const fixture = configFile({
		providers: [
			{
				id: "xai_web_search",
				type: "xai_web_search",
				authJson: "./xai-auth.json",
			},
		],
		search: { providers: ["xai_web_search"] },
		extract: { providers: ["http"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			XAI_AUTH_JSON: "./ignored-auth.json",
			XAI_MODEL: "grok-test",
		});
		const xai = loaded.instances.find((item) => item.id === "xai_web_search");
		assert.equal(xai?.authJson, "./ignored-auth.json");
		assert.equal(xai?.authJsonSource, "standard_env");
		assert.equal(xai?.credentialSource, "auth_json");
		assert.equal(xai?.model, "grok-test");
		assert.equal(xai?.baseUrl, "https://cli-chat-proxy.grok.com/v1");
		assert.equal(capabilitySupports("xai_web_search", "search"), true);
		assert.equal(capabilitySupports("xai_web_search", "extract"), false);
		assert.equal(executeDoctor(loaded).ok, false);
	} finally {
		fixture.cleanup();
	}
});

test("Bocha 使用标准环境变量、默认 endpoint 和 Search-only capability", () => {
	const fixture = configFile({
		providers: [
			{
				id: "bocha",
				type: "bocha",
				apiKey: "config-key",
				headers: { "X-Team": "search" },
			},
		],
		search: { providers: ["bocha"] },
		extract: { providers: ["http"] },
	});
	try {
		const loaded = loadConfig(fixture.path, {
			BOCHA_API_KEY: "env-key",
			BOCHA_BASE_URL: "https://bocha.internal/root/",
		});
		const bocha = loaded.instances.find((item) => item.id === "bocha");
		assert.equal(bocha?.apiKey, "env-key");
		assert.equal(bocha?.credentialSource, "standard_env");
		assert.equal(bocha?.baseUrl, "https://bocha.internal/root");
		assert.equal(bocha?.baseUrlSource, "standard_env");
		assert.equal(bocha?.headers["X-Team"], "search");
		assert.equal(capabilitySupports("bocha", "search"), true);
		assert.equal(capabilitySupports("bocha", "extract"), false);
		const provider = (
			executeProviders(loaded).data as {
				providers: Array<Record<string, unknown>>;
			}
		).providers.find((item) => item.id === "bocha");
		assert.deepEqual(provider?.capabilities, ["search"]);
		assert.deepEqual(provider?.routes, { search: true, extract: false });
		assert.equal(executeDoctor(loaded).ok, true);
	} finally {
		fixture.cleanup();
	}
});

test("Bocha 自定义 instance 只读取自定义变量且缺少 key 时 doctor 失败", () => {
	const fixture = configFile({
		providers: [
			{
				id: "bocha_team",
				type: "bocha",
				apiKeyEnv: "TEAM_BOCHA_KEY",
				baseUrlEnv: "TEAM_BOCHA_URL",
			},
		],
		search: { providers: ["bocha_team"] },
		extract: { providers: ["http"] },
	});
	try {
		const missing = loadConfig(fixture.path, {
			BOCHA_API_KEY: "standard-key",
			BOCHA_BASE_URL: "https://ignored.example.com",
		});
		const unconfigured = missing.instances.find(
			(item) => item.id === "bocha_team",
		);
		assert.equal(unconfigured?.apiKey, null);
		assert.equal(unconfigured?.baseUrl, "https://api.bocha.cn");
		assert.equal(executeDoctor(missing).ok, false);

		const configured = loadConfig(fixture.path, {
			BOCHA_API_KEY: "standard-key",
			BOCHA_BASE_URL: "https://ignored.example.com",
			TEAM_BOCHA_KEY: "team-key",
			TEAM_BOCHA_URL: "https://team.bocha.test/",
		});
		const bocha = configured.instances.find((item) => item.id === "bocha_team");
		assert.equal(bocha?.apiKey, "team-key");
		assert.equal(bocha?.credentialSource, "custom_env");
		assert.equal(bocha?.baseUrl, "https://team.bocha.test");
		assert.equal(bocha?.baseUrlSource, "custom_env");
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

test("DeepSeek 不能进入 Extract route 或配置 searchFilterMode", () => {
	const extract = configFile({ extract: { providers: ["deepseek"] } });
	const filterMode = configFile({
		providers: [
			{ id: "deepseek", type: "deepseek", searchFilterMode: "strict" },
		],
	});
	try {
		assert.throws(() => loadConfig(extract.path, {}), isConfigError);
		assert.throws(() => loadConfig(filterMode.path, {}), isConfigError);
	} finally {
		extract.cleanup();
		filterMode.cleanup();
	}
});

test("Bocha 不能进入 Extract route", () => {
	const fixture = configFile({ extract: { providers: ["bocha"] } });
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
		"bocha",
		"brave",
		"searxng",
		"firecrawl",
		"jina",
		"http",
		"anysearch",
		"xcrawl",
		"deepseek",
		"xai_x_search",
		"xai_web_search",
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

test("缺省 route 按主轮与 fallback 分组，Search 主轮不能为空", () => {
	const defaults = configFile({});
	const disabled = configFile({
		extract: { providers: [] },
	});
	try {
		const loaded = loadConfig(defaults.path, {});
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
		assert.deepEqual(loaded.app.search.providers, [
			"tavily",
			"exa",
			"bocha",
			"brave",
			"searxng",
			"anysearch",
			"xcrawl",
		]);
		assert.deepEqual(loaded.app.search.providers_fallback, [
			"deepseek",
			"xai_x_search",
			"xai_web_search",
		]);
		assert.deepEqual(loaded.app.extract.providers, [
			"firecrawl",
			"jina",
			"exa",
			"anysearch",
			"xcrawl",
		]);
		assert.deepEqual(loaded.app.extract.providers_fallback, ["http"]);
		const emptySearch = configFile({ search: { providers: [] } });
		try {
			assert.throws(() => loadConfig(emptySearch.path, {}), isConfigError);
		} finally {
			emptySearch.cleanup();
		}
		const emptyRoutes = loadConfig(disabled.path, {});
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
});

test("公开 provider route 顺序直接用于诊断", () => {
	const fixture = configFile({
		providers: [
			{ id: "search_a", type: "searxng", baseUrl: "https://a.test" },
			{ id: "search_b", type: "searxng", baseUrl: "https://b.test" },
		],
		search: {
			providers: ["search_b", "search_a"],
			providers_fallback: [],
		},
		extract: { providers: ["http"], providers_fallback: [] },
	});
	try {
		const loaded = loadConfig(fixture.path, {});
		assert.deepEqual(loaded.app.search.providers, ["search_b", "search_a"]);
		assert.deepEqual(getEffectiveRoute(loaded.app, "search"), [
			"search_b",
			"search_a",
		]);
		const data = executeProviders(loaded).data as {
			searchRoute: string[];
			searchFallbackRoute: string[];
			extractRoute: string[];
			extractFallbackRoute: string[];
		};
		assert.deepEqual(data.searchRoute, ["search_b", "search_a"]);
		assert.deepEqual(data.searchFallbackRoute, []);
		assert.deepEqual(data.extractRoute, ["http"]);
		assert.deepEqual(data.extractFallbackRoute, []);
	} finally {
		fixture.cleanup();
	}
});

test("旧下划线顺序字段直接报配置错误", () => {
	const fixture = configFile({
		search: { _providers: ["tavily"] },
		extract: { providers: ["http"] },
	});
	try {
		assert.throws(() => loadConfig(fixture.path, {}), isConfigError);
	} finally {
		fixture.cleanup();
	}
});
