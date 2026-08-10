import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ConfigError,
	loadConfig,
	resolveConfigPath,
} from "../src/config/config.ts";

function configFile(value: unknown): { path: string; cleanup(): void } {
	const directory = mkdtempSync(join(tmpdir(), "web-access-config-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		path,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
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
		assert.throws(() => loadConfig(missing.path, {}), /不存在的 instance/);
	} finally {
		unknown.cleanup();
		missing.cleanup();
	}
});

test("只读取显式或用户级配置路径", () => {
	const resolved = resolveConfigPath("./nested/config.json", {});
	assert.equal(resolved, join(process.cwd(), "nested", "config.json"));
	const loaded = loadConfig(undefined, {
		APPDATA: join(tmpdir(), "not-created"),
	});
	assert.equal(loaded.exists, false);
	assert.deepEqual(loaded.app.search.providers, [
		"tavily",
		"exa",
		"brave",
		"searxng",
	]);
});
