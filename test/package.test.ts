import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERSION } from "../src/version.ts";

interface PackageManifest {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
	repository?: { url?: string };
	publishConfig?: { access?: string; registry?: string };
}

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

test("npm 包元数据与 CLI 发布契约一致", () => {
	assert.equal(manifest.name, "web-access-cli");
	assert.equal(manifest.version, VERSION);
	assert.deepEqual(manifest.bin, { "web-access": "dist/cli.js" });
	assert.equal(
		manifest.repository?.url,
		"git+https://github.com/juexe/web-access-cli.git",
	);
	assert.deepEqual(manifest.publishConfig, {
		access: "public",
		registry: "https://registry.npmjs.org/",
	});
});
