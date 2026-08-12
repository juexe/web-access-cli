import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type LoadedConfig, loadConfig } from "../src/config/config.ts";
import { executeExtract, executeSearch } from "../src/core/router.ts";
import type { ExtractRequest, SearchRequest } from "../src/core/types.ts";
import { MockTransport, response } from "./helpers.ts";

function loadedConfig(value: unknown): {
	loaded: LoadedConfig;
	cleanup(): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "web-access-router-"));
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return {
		loaded: loadConfig(path, {}),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

const searchRequest: SearchRequest = {
	query: "web access",
	provider: "auto",
	limit: 5,
	includeDomains: [],
	excludeDomains: [],
};

test("auto 跳过未配置 instance，并按 route 回退到下一 provider", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "brave", type: "brave", apiKey: "brave-key" }],
		search: { providers: ["tavily", "brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() =>
			response({
				web: {
					results: [
						{
							title: "Brave result",
							url: "https://example.com/result",
							description: "snippet",
						},
					],
				},
			}),
		);
		const envelope = await executeSearch(searchRequest, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, true);
		if (!envelope.ok || envelope.command !== "search") return;
		assert.equal(envelope.provider.id, "brave");
		assert.deepEqual(
			envelope.attempts.map((attempt) => attempt.status),
			["failed", "success"],
		);
		assert.equal(envelope.attempts[0]?.error?.code, "provider_unavailable");
	} finally {
		fixture.cleanup();
	}
});

test("显式 provider 严格执行，不触发 fallback", async () => {
	const fixture = loadedConfig({
		search: { providers: ["tavily", "brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const transport = new MockTransport(() => response({ results: [] }));
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "tavily" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_unavailable");
		assert.equal(envelope.attempts?.length, 1);
		assert.equal(transport.calls.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("auto 全部失败时返回 provider_exhausted 与最佳 partial", async () => {
	const fixture = loadedConfig({
		search: { providers: [] },
		extract: {
			providers: ["http"],
			minContentCharacters: 100,
		},
	});
	const request: ExtractRequest = {
		url: "https://example.com/short",
		provider: "auto",
	};
	try {
		const transport = new MockTransport(() =>
			response("太短的正文", { contentType: "text/plain" }),
		);
		const envelope = await executeExtract(request, {
			loaded: fixture.loaded,
			transport,
		});
		assert.equal(envelope.ok, false);
		if (envelope.ok) return;
		assert.equal(envelope.error.code, "provider_exhausted");
		assert.equal(envelope.partial?.provider.id, "http");
		assert.equal(envelope.partial?.data.document.content, "太短的正文");
		assert.equal(envelope.raw, "太短的正文");
	} finally {
		fixture.cleanup();
	}
});

test("route 外的显式 instance 返回 provider_disabled", async () => {
	const fixture = loadedConfig({
		providers: [
			{ id: "brave", type: "brave", apiKey: "key" },
			{ id: "brave_backup", type: "brave", apiKey: "backup-key" },
		],
		search: { providers: ["brave"] },
		extract: { providers: ["http"] },
	});
	try {
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "brave_backup" },
			{
				loaded: fixture.loaded,
				transport: new MockTransport(() => response({ web: { results: [] } })),
			},
		);
		assert.equal(envelope.ok, false);
		if (!envelope.ok) assert.equal(envelope.error.code, "provider_disabled");
	} finally {
		fixture.cleanup();
	}
});

test("AnySearch 402 自动注册响应在 envelope 中递归脱敏", async () => {
	const fixture = loadedConfig({
		providers: [{ id: "anysearch", type: "anysearch" }],
		search: { providers: ["anysearch"] },
		extract: { providers: ["http"] },
	});
	const transport = new MockTransport(() =>
		response(
			{
				code: 402,
				message: "quota",
				auto_registered: {
					username: "user@example.com",
					password: "secret-password",
					api_key: "response-key",
				},
			},
			{ status: 200 },
		),
	);
	try {
		const envelope = await executeSearch(
			{ ...searchRequest, provider: "auto" },
			{ loaded: fixture.loaded, transport },
		);
		assert.equal(envelope.ok, false);
		const serialized = JSON.stringify(envelope);
		assert.doesNotMatch(
			serialized,
			/secret-password|response-key|user@example.com/,
		);
		assert.match(serialized, /quota_exceeded|provider_exhausted/);
	} finally {
		fixture.cleanup();
	}
});
