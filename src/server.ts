import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type LoadedConfig, loadConfig } from "./config/config.ts";
import {
	createGatewayServer,
	type GatewayServer,
	normalizeGatewayApiKey,
} from "./gateway/server.ts";
import { DefaultHttpTransport } from "./transport/http.ts";

export const GATEWAY_API_KEY_FILE_ENV = "WEB_ACCESS_GATEWAY_API_KEY_FILE";
export const GATEWAY_HOST_ENV = "WEB_ACCESS_GATEWAY_HOST";
export const GATEWAY_PORT_ENV = "WEB_ACCESS_GATEWAY_PORT";
export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 8080;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface GatewayRuntime {
	server: GatewayServer;
	host: string;
	port: number;
	close(): Promise<void>;
}

function requireApiKeyPath(env: NodeJS.ProcessEnv): string {
	const path = env[GATEWAY_API_KEY_FILE_ENV]?.trim();
	if (!path)
		throw new Error(`${GATEWAY_API_KEY_FILE_ENV} 必须指向网关 API key 文件`);
	return path;
}

export function gatewayHost(env: NodeJS.ProcessEnv): string {
	const host = env[GATEWAY_HOST_ENV]?.trim();
	return host || DEFAULT_GATEWAY_HOST;
}

export function gatewayPort(env: NodeJS.ProcessEnv): number {
	const raw = env[GATEWAY_PORT_ENV]?.trim();
	if (!raw) return DEFAULT_GATEWAY_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`${GATEWAY_PORT_ENV} 必须是 1–65535 的整数`);
	return port;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): {
	loaded: LoadedConfig;
	apiKey: string;
	host: string;
	port: number;
} {
	const loaded = loadConfig(undefined, env);
	const apiKey = normalizeGatewayApiKey(
		readFileSync(requireApiKeyPath(env), "utf8"),
	);
	return { loaded, apiKey, host: gatewayHost(env), port: gatewayPort(env) };
}

/** Start the gateway. Only this function opens a listening socket. */
export async function startGateway(
	env: NodeJS.ProcessEnv = process.env,
	log?: (event: unknown) => void,
): Promise<GatewayRuntime> {
	const { loaded, apiKey, host, port } = loadGatewayConfig(env);
	const transport = new DefaultHttpTransport();
	const server = createGatewayServer({
		loaded,
		apiKey,
		transport,
		...(log ? { log } : {}),
	});
	const readiness = server.service.readiness();
	if (!readiness.ready) {
		await transport.close();
		await transport.destroy();
		throw new Error(
			`网关未就绪: ${readiness.reason ?? "unknown"}（search 与 extract 路由各需至少一个已配置 adapter）`,
		);
	}
	await new Promise<void>((resolve, reject) => {
		server.server.once("error", reject);
		server.server.listen(port, host, () => {
			server.server.off("error", reject);
			resolve();
		});
	});
	let closed = false;
	return {
		server,
		host,
		port,
		async close() {
			if (closed) return;
			closed = true;
			await server.shutdown(SHUTDOWN_TIMEOUT_MS);
			await transport.close();
			await transport.destroy();
		},
	};
}

export function isMainModule(
	moduleUrl: string,
	entryPath: string | undefined,
): boolean {
	if (!entryPath) return false;
	try {
		return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	let runtime: GatewayRuntime;
	try {
		runtime = await startGateway();
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify({
				message: "网关启动失败",
				code: "startup_failed",
				detail: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
		process.exitCode = 1;
		return;
	}
	process.stderr.write(
		`${JSON.stringify({
			message: "网关已启动",
			host: runtime.host,
			port: runtime.port,
		})}\n`,
	);
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		process.stderr.write(
			`${JSON.stringify({ message: "网关正在停止", signal })}\n`,
		);
		try {
			await runtime.close();
			process.exitCode = 0;
		} catch (error) {
			process.stderr.write(
				`${JSON.stringify({
					message: "网关停止失败",
					detail: error instanceof Error ? error.message : String(error),
				})}\n`,
			);
			process.exitCode = 1;
		}
	};
	process.once("SIGINT", () => void stop("SIGINT"));
	process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (isMainModule(import.meta.url, process.argv[1])) {
	await main();
}
