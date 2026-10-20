// Deterministic upstream fixture for the Compose smoke test. It listens on a
// container-network address and answers the provider shapes that the configured
// fixture config points at, so no real credential or public network is used.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.FIXTURE_PORT ?? "9911");
const HOST = process.env.FIXTURE_HOST ?? "0.0.0.0";

function json(response, status, body) {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload).toString(),
	});
	response.end(payload);
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
	if (url.pathname === "/fixture/article") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><html><head><title>Fixture Article</title></head>" +
				"<body><main><h1>Fixture Article</h1><p>Deterministic fixture body.</p></main></body></html>",
		);
		return;
	}
	if (url.pathname === "/fixture/short") {
		response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("short");
		return;
	}
	if (url.pathname === "/v1/search") {
		json(response, 200, {
			code: 0,
			data: {
				results: [
					{
						title: "Fixture Result",
						url: `http://fixture:${PORT}/fixture/article`,
						snippet: "fixture snippet",
					},
				],
			},
		});
		return;
	}
	if (url.pathname === "/v1/extract") {
		json(response, 200, {
			code: 0,
			data: {
				url:
					url.searchParams.get("target") ??
					`http://fixture:${PORT}/fixture/article`,
				title: "Fixture Extract",
				content: "# Fixture Extract\n\nDeterministic fixture markdown.",
			},
		});
		return;
	}
	if (url.pathname === "/healthz") {
		json(response, 200, { status: "ok" });
		return;
	}
	json(response, 404, { error: "fixture route missing" });
});

export function startFixture() {
	return new Promise((resolveStarted) => {
		server.listen(PORT, HOST, () => resolveStarted(server));
	});
}

export function stopFixture() {
	return new Promise((resolveStopped) => server.close(() => resolveStopped()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await startFixture();
	process.stderr.write(`fixture listening on ${HOST}:${PORT}\n`);
}
