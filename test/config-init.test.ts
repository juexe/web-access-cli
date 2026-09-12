import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config/config.ts";
import { executeConfigInit } from "../src/config/init.ts";

function temporaryPath(): { directory: string; path: string; cleanup(): void } {
	const directory = mkdtempSync(join(tmpdir(), "web-access-config-init-"));
	const path = join(directory, "config.json");
	return {
		directory,
		path,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

test("config init 按标准凭据筛选主 Route 并写入公开 fallback", async () => {
	const fixture = temporaryPath();
	try {
		const envelope = await executeConfigInit({
			explicitPath: fixture.path,
			env: {
				TAVILY_API_KEY: "configured",
				FIRECRAWL_API_KEY: "configured",
			},
		});
		assert.equal(envelope.command, "config.init");
		assert.deepEqual(envelope.data.searchProviders, ["tavily"]);
		assert.deepEqual(envelope.data.searchFallbackProviders, []);
		assert.deepEqual(envelope.data.extractProviders, ["firecrawl"]);
		assert.deepEqual(envelope.data.extractFallbackProviders, ["http"]);

		const parsed = JSON.parse(readFileSync(fixture.path, "utf8")) as {
			providers: unknown[];
			search: { providers: string[]; providers_fallback: string[] };
			extract: { providers: string[]; providers_fallback: string[] };
		};
		assert.equal(parsed.providers.length, 13);
		assert.deepEqual(parsed.search.providers, ["tavily"]);
		assert.deepEqual(parsed.search.providers_fallback, []);
		assert.deepEqual(parsed.extract.providers, ["firecrawl"]);
		assert.deepEqual(parsed.extract.providers_fallback, ["http"]);
		assert.equal(loadConfig(fixture.path, {}).exists, true);
	} finally {
		fixture.cleanup();
	}
});

test("config init 拒绝覆盖已有文件和无 Search 凭据", async () => {
	const existing = temporaryPath();
	const missing = temporaryPath();
	try {
		writeFileSync(existing.path, "{}", "utf8");
		await assert.rejects(
			executeConfigInit({
				explicitPath: existing.path,
				env: { TAVILY_API_KEY: "key" },
			}),
			(error: unknown) => error instanceof ConfigError,
		);
		await assert.rejects(
			executeConfigInit({
				explicitPath: missing.path,
				env: { FIRECRAWL_API_KEY: "key" },
			}),
			(error: unknown) => error instanceof ConfigError,
		);
	} finally {
		existing.cleanup();
		missing.cleanup();
	}
});
