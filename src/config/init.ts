import {
	type ConfigInitSuccessEnvelope,
	OUTPUT_SCHEMA_VERSION,
} from "../core/types.ts";
import {
	ConfigError,
	createDefaultAppConfig,
	loadConfigContents,
	resolveConfigPath,
} from "./config.ts";
import { CONFIG_SCHEMA_URL, writeNewConfigFile } from "./file.ts";

export interface ConfigInitOptions {
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

function elapsed(start: number, now: () => number): number {
	return Math.max(0, Math.round(now() - start));
}

export async function executeConfigInit(
	options: ConfigInitOptions = {},
): Promise<ConfigInitSuccessEnvelope> {
	const env = options.env ?? process.env;
	const now = options.now ?? performance.now.bind(performance);
	const started = now();
	const path = resolveConfigPath(options.explicitPath, env);
	const defaults = createDefaultAppConfig();
	const resolved = loadConfigContents(path, "{}", env);
	const byId = new Map(
		resolved.instances.map((instance) => [instance.id, instance]),
	);
	const hasStandardCredential = (id: string): boolean => {
		const instance = byId.get(id);
		return !!instance && instance.credentialSource !== "missing";
	};
	const searchCandidates = [
		...defaults.search.providers,
		...defaults.search.providers_fallback,
	];
	const searchProviders = searchCandidates.filter(
		(id, index) =>
			searchCandidates.indexOf(id) === index && hasStandardCredential(id),
	);
	const extractProviders = defaults.extract.providers.filter((id) =>
		hasStandardCredential(id),
	);
	if (searchProviders.length === 0)
		throw new ConfigError("config init 未检测到可用的 Search provider 凭据");
	if (extractProviders.length === 0)
		throw new ConfigError("config init 未检测到可用的 Extract provider 凭据");

	const contents = `${JSON.stringify(
		{
			$schema: CONFIG_SCHEMA_URL,
			...defaults,
			search: {
				...defaults.search,
				providers: searchProviders,
				providers_fallback: [],
			},
			extract: {
				...defaults.extract,
				providers: extractProviders,
				providers_fallback: ["http"],
			},
		},
		null,
		2,
	)}\n`;
	await writeNewConfigFile(path, contents);
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		ok: true,
		command: "config.init",
		durationMs: elapsed(started, now),
		data: {
			path,
			created: true,
			searchProviders,
			searchFallbackProviders: [],
			extractProviders,
			extractFallbackProviders: ["http"],
		},
	};
}
