// Offline Compose acceptance test for the gateway image.
//
// It builds the production image, starts a deterministic in-network fixture and
// a gateway configured ONLY against that fixture, then asserts authentication,
// search, fetch, short content and restart recovery. It uses a throwaway project
// name, fake keys and temporary files; it never contacts a real provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..");
const project = `web-access-cli-smoke-${process.pid}`;
const image = `web-access-cli-smoke:${process.pid}`;
const workspace = mkdtempSync(join(tmpdir(), "web-access-cli-docker-"));
const providerConfig = join(workspace, "provider-config.json");
const gatewayKeyFile = join(workspace, "gateway-api-key");
const envFile = join(workspace, "deploy.env");
const gatewayKey = randomBytes(32).toString("hex");
const BIND_PORT = 18_180 + (process.pid % 500);
const baseUrl = `http://127.0.0.1:${BIND_PORT}`;

// The gateway image runs as uid 1000, and a bind mount keeps the host file's
// owner and mode. A 0600 file created by a different host user is therefore
// unreadable inside the container, which reproduced as an immediate
// `EACCES ... /run/secrets/gateway-api-key` startup failure on Linux CI. Use a
// world-readable mode here: this fixture is a throwaway key, and the check below
// still proves the image itself carries no credential.
const secretMode = 0o644;

writeFileSync(gatewayKeyFile, `${gatewayKey}\n`, { mode: secretMode });
writeFileSync(
	providerConfig,
	JSON.stringify(
		{
			providers: [
				{
					id: "anysearch",
					type: "anysearch",
					apiKey: "fixture-anysearch-key",
					baseUrl: "http://fixture:9911",
				},
			],
			search: { providers: ["anysearch"], providers_fallback: [] },
			extract: { providers: ["http"], providers_fallback: [] },
		},
		null,
		2,
	),
	{ mode: secretMode },
);
writeFileSync(
	envFile,
	[
		`WEB_ACCESS_IMAGE=${image}`,
		`WEB_ACCESS_BIND=127.0.0.1:${BIND_PORT}`,
		`WEB_ACCESS_SECRET_PROVIDER_CONFIG=${providerConfig}`,
		`WEB_ACCESS_SECRET_GATEWAY_KEY=${gatewayKeyFile}`,
		"",
	].join("\n"),
);

function docker(args, options = {}) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(options.docker ?? "docker", args, {
			cwd: repository,
			stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", rejectRun);
		child.once("close", (code) => resolveRun({ code, stdout, stderr }));
	});
}

async function compose(args, options = {}) {
	return docker(
		[
			"compose",
			"-p",
			project,
			"-f",
			"deploy/compose.yaml",
			"-f",
			"test/compose.gateway.yaml",
			"--env-file",
			envFile,
			...args,
		],
		options,
	);
}

async function requestJson(path, body, headers = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		headers: response.headers,
		body: await response.json(),
	};
}

async function waitUntilReady(timeoutMs = 120_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(`${baseUrl}/readyz`);
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	throw new Error("gateway 未在期限内就绪");
}

let built = false;
try {
	const version = await docker(["--version"]);
	if (version.code !== 0) {
		console.error("Docker 不可用，跳过 test:docker");
		process.exit(0);
	}
	const config = await compose(["config", "--quiet"]);
	assert.equal(config.code, 0, config.stderr);

	const build = await compose(["build", "gateway"], { inherit: true });
	assert.equal(build.code, 0, "镜像构建失败");
	built = true;

	const imageId = await docker([
		"image",
		"inspect",
		"--format",
		"{{.Id}}",
		image,
	]);
	assert.equal(imageId.code, 0, imageId.stderr);
	const imageIdValue = imageId.stdout.trim();
	assert.match(imageIdValue, /^sha256:[0-9a-f]{64}$/);

	// The image must not carry provider credentials or local configuration.
	const history = await docker([
		"history",
		"--no-trunc",
		"--format",
		"{{.CreatedBy}}",
		image,
	]);
	const findConfig = await docker([
		"run",
		"--rm",
		"--entrypoint",
		"sh",
		image,
		"-c",
		"ls /app && ! test -e /app/.env && ! test -e /app/config.json && ! test -e /app/secrets",
	]);
	assert.equal(findConfig.code, 0, findConfig.stderr);

	const up = await compose(["up", "-d", "--wait", "gateway"], {
		inherit: true,
	});
	assert.equal(up.code, 0, "compose up 失败");
	await waitUntilReady();

	const health = await fetch(`${baseUrl}/healthz`);
	assert.equal(health.status, 200);
	const ready = await fetch(`${baseUrl}/readyz`);
	assert.equal(ready.status, 200);

	// Authentication and validation.
	const unauthenticated = await requestJson("/v1/tools/search", {
		query: "fixture",
	});
	assert.equal(unauthenticated.status, 401);
	assert.equal(unauthenticated.body.error?.type, "authentication_error");

	const invalid = await requestJson(
		"/v1/tools/search",
		{ query: "fixture", count: 51 },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error?.code, "invalid_request_error");

	// Search against the fixture provider, without content backfill.
	const search = await requestJson(
		"/v1/tools/search",
		{ query: "fixture", count: 1, need_content: false },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(search.status, 200);
	assert.equal(search.body.results?.length, 1);
	const result = search.body.results[0];
	assert.equal(result.summary, result.snippet);
	assert.equal(result.rerank_score, 0);
	assert.equal(result.authority, -1);
	assert.equal(result.content, "");
	assert.deepEqual(Object.keys(result).sort(), [
		"authority",
		"content",
		"date",
		"rerank_score",
		"site_icon",
		"site_name",
		"snippet",
		"summary",
		"title",
		"url",
	]);

	// Fetch through the direct HTTP provider and accept a short body.
	const fetchResponse = await requestJson(
		"/v1/tools/fetch",
		{ url: "http://fixture:9911/fixture/article" },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(fetchResponse.status, 200);
	assert.equal(fetchResponse.body.title, "Fixture Article");
	assert.match(fetchResponse.body.content, /Deterministic fixture body/);

	const shortFetch = await requestJson(
		"/v1/tools/fetch",
		{ url: "http://fixture:9911/fixture/short" },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(shortFetch.status, 200);
	assert.equal(shortFetch.body.content, "short");

	const missing = await requestJson(
		"/v1/tools/fetch",
		{ url: "http://fixture:9911/fixture/missing" },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(missing.status, 404);
	assert.equal(missing.body.error?.code, "no_usable_content");

	// Request panel: the HTML is public but the records API needs the key.
	const panel = await fetch(`${baseUrl}/panel`);
	assert.equal(panel.status, 200);
	assert.match(panel.headers.get("content-type") ?? "", /text\/html/);
	const panelHtml = await panel.text();
	assert.match(panelHtml, /Web Access 网关/);
	assert.doesNotMatch(panelHtml, new RegExp(gatewayKey));
	const anonymousRecords = await fetch(`${baseUrl}/admin/api/records`);
	assert.equal(anonymousRecords.status, 401);
	await anonymousRecords.text();
	const recordsResponse = await fetch(`${baseUrl}/admin/api/records`, {
		headers: { Authorization: `Bearer ${gatewayKey}` },
	});
	assert.equal(recordsResponse.status, 200);
	const recordsBody = await recordsResponse.json();
	assert.equal(recordsBody.retention, 500);
	assert.ok(Array.isArray(recordsBody.records));
	assert.ok(
		recordsBody.records.some(
			(record) => record.route === "search" && record.query === "fixture",
		),
	);
	assert.ok(
		recordsBody.records.some(
			(record) =>
				record.route === "fetch" && record.title === "Fixture Article",
		),
	);
	const overviewResponse = await fetch(`${baseUrl}/admin/api/overview`, {
		headers: { Authorization: `Bearer ${gatewayKey}` },
	});
	assert.equal(overviewResponse.status, 200);
	const overviewBody = await overviewResponse.json();
	assert.equal(overviewBody.doctor?.ok, true);
	assert.ok(Array.isArray(overviewBody.providers));

	// Restart the gateway alone and verify recovery.
	const restart = await compose(["restart", "gateway"], { inherit: true });
	assert.equal(restart.code, 0, "restart 失败");
	await waitUntilReady();
	const afterRestart = await requestJson(
		"/v1/tools/search",
		{ query: "fixture", count: 1 },
		{ Authorization: `Bearer ${gatewayKey}` },
	);
	assert.equal(afterRestart.status, 200);

	// Wait for the container healthcheck itself (up to three intervals).
	let status = "starting";
	for (let attempt = 0; attempt < 30 && status !== "healthy"; attempt++) {
		const health = await docker([
			"inspect",
			"--format",
			"{{.State.Health.Status}}",
			`${project}-gateway-1`,
		]);
		if (health.code === 0) status = health.stdout.trim();
		if (status === "healthy") break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
	}

	// The runtime container is non-root and has a read-only root filesystem.
	const inspect = await docker([
		"inspect",
		"--format",
		["{{.Config.User}}", "{{.HostConfig.ReadonlyRootfs}}"].join("|"),
		`${project}-gateway-1`,
	]);
	assert.equal(inspect.code, 0, inspect.stderr);
	const [user, readonly] = inspect.stdout.trim().split("|");
	assert.equal(user, "1000:1000");
	assert.equal(readonly, "true");
	assert.equal(status, "healthy");

	if (history.code === 0)
		assert.doesNotMatch(history.stdout, new RegExp(gatewayKey));
	console.log(
		JSON.stringify({
			image,
			imageId: imageIdValue,
			project,
			baseUrl,
			status: "passed",
		}),
	);
} finally {
	if (built) {
		// Only this run's explicitly named project and image are removed.
		await compose(["down", "-v", "--remove-orphans"], { inherit: true });
		await docker(["image", "rm", "-f", image]);
	}
	rmSync(workspace, { recursive: true, force: true });
}
