import open from "open";
import { WebAccessError } from "../core/errors.ts";
import {
	type ConfigEditSuccessEnvelope,
	OUTPUT_SCHEMA_VERSION,
} from "../core/types.ts";
import { resolveConfigPath } from "./config.ts";
import { ensureConfigFile } from "./file.ts";

export {
	CONFIG_SCHEMA_URL,
	ensureConfigFile,
	serializeDefaultConfig,
} from "./file.ts";

export type OpenPath = (path: string) => Promise<unknown>;

export interface ConfigEditOptions {
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	openPath?: OpenPath;
	now?: () => number;
}

function elapsed(start: number, now: () => number): number {
	return Math.max(0, Math.round(now() - start));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const openWithSystemDefault: OpenPath = async (path) => {
	await open(path, { wait: false });
};

export async function executeConfigEdit(
	options: ConfigEditOptions = {},
): Promise<ConfigEditSuccessEnvelope> {
	const now = options.now ?? performance.now.bind(performance);
	const started = now();
	const path = resolveConfigPath(options.explicitPath, options.env);
	const created = await ensureConfigFile(path);
	try {
		await (options.openPath ?? openWithSystemDefault)(path);
	} catch (error) {
		throw new WebAccessError(
			"open_failed",
			`无法用系统默认应用打开配置文件: ${path}`,
			{
				details: { path, created, cause: errorMessage(error) },
			},
		);
	}

	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		ok: true,
		command: "config.edit",
		durationMs: elapsed(started, now),
		data: { path, created, opened: true },
	};
}
