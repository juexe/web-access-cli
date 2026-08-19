import type { LoadedConfig } from "../config/config.ts";
import { capabilitySupports } from "../config/config.ts";
import { getAdapter } from "../providers/registry.ts";
import type {
	DiagnosticSuccessEnvelope,
	FailureEnvelope,
	ProviderInstance,
} from "./types.ts";
import { OUTPUT_SCHEMA_VERSION } from "./types.ts";

function providerInfo(
	instance: ProviderInstance,
	loaded: LoadedConfig,
): Record<string, unknown> {
	const searchEnabled = loaded.app.search.providers.includes(instance.id);
	const extractEnabled = loaded.app.extract.providers.includes(instance.id);
	const adapter =
		getAdapter(instance.type, "search") ?? getAdapter(instance.type, "extract");
	return {
		id: instance.id,
		type: instance.type,
		capabilities: ["search", "extract"].filter((capability) =>
			capabilitySupports(instance.type, capability as "search" | "extract"),
		),
		routes: { search: searchEnabled, extract: extractEnabled },
		configured: {
			credential: instance.credentialSource !== "missing",
			baseUrl: instance.baseUrl !== null,
			adapter: !!adapter,
		},
		credentialSource: instance.credentialSource,
		baseUrlSource: instance.baseUrlSource,
		...(instance.type === "anysearch" || instance.type === "xcrawl"
			? { searchFilterMode: instance.searchFilterMode ?? "strict" }
			: {}),
	};
}

export function executeProviders(
	loaded: LoadedConfig,
): DiagnosticSuccessEnvelope {
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		ok: true,
		command: "providers",
		durationMs: 0,
		data: {
			config: { path: loaded.path, exists: loaded.exists },
			searchRoute: loaded.app.search.providers,
			extractRoute: loaded.app.extract.providers,
			providers: loaded.instances.map((instance) =>
				providerInfo(instance, loaded),
			),
		},
	};
}

export function executeDoctor(
	loaded: LoadedConfig,
): DiagnosticSuccessEnvelope | FailureEnvelope {
	const providers = loaded.instances.map((instance) => {
		const checks = {
			search:
				!loaded.app.search.providers.includes(instance.id) ||
				(!!getAdapter(instance.type, "search") &&
					(getAdapter(instance.type, "search")?.isConfigured(instance) ??
						false)),
			extract:
				!loaded.app.extract.providers.includes(instance.id) ||
				(!!getAdapter(instance.type, "extract") &&
					(getAdapter(instance.type, "extract")?.isConfigured(instance) ??
						false)),
		};
		return {
			id: instance.id,
			type: instance.type,
			checks,
			ok: checks.search && checks.extract,
			...(instance.type === "anysearch" || instance.type === "xcrawl"
				? { searchFilterMode: instance.searchFilterMode ?? "strict" }
				: {}),
		};
	});
	const routeChecks = {
		search: loaded.app.search.providers.length > 0,
		extract: loaded.app.extract.providers.length > 0,
	};
	const ok =
		routeChecks.search &&
		routeChecks.extract &&
		providers.every((provider) => provider.ok);
	const data = {
		ok,
		config: { path: loaded.path, exists: loaded.exists },
		routes: routeChecks,
		providers,
	};
	if (!ok)
		return {
			schemaVersion: OUTPUT_SCHEMA_VERSION,
			ok: false,
			command: "doctor",
			durationMs: 0,
			error: {
				code: "doctor_failed",
				message: "诊断发现未完成配置的已启用 provider",
				retryable: false,
				details: data,
			},
		};
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		ok: true,
		command: "doctor",
		durationMs: 0,
		data,
	};
}
