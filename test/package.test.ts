import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERSION } from "../src/version.ts";

interface PackageManifest {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
}

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

test("npm 包元数据与 CLI 发布契约一致", () => {
	assert.equal(manifest.name, "web-access-cli");
	assert.equal(manifest.version, VERSION);
	assert.deepEqual(manifest.bin, { "web-access": "dist/cli.js" });
});

test("网关入口不改变 npm bin 契约，并提供独立脚本", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		bin?: Record<string, string>;
		files?: string[];
		scripts?: Record<string, string>;
		version?: string;
	};
	assert.deepEqual(manifest.bin, { "web-access": "dist/cli.js" });
	assert.equal(manifest.version, VERSION);
	assert.ok(manifest.scripts?.["start:gateway"]);
	assert.ok(manifest.scripts?.["test:docker"]);
	// The gateway must not become a second npm bin or a published extra entry.
	assert.equal(Object.keys(manifest.bin ?? {}).length, 1);
});
