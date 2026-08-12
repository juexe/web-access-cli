import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { WebAccessError } from "../core/errors.ts";
import {
	type AppConfig,
	type Capability,
	type ExtractConfig,
	PROVIDER_TYPES,
	type ProviderInstance,
	type ProviderInstanceConfig,
	type ProviderType,
	SEARCH_FILTER_MODES,
	type SearchConfig,
	type SearchFilterMode,
} from "../core/types.ts";

export const CONFIG_ENV = "WEB_ACCESS_CONFIG";
export const DEFAULT_SEARCH_PROVIDERS = [
	"tavily",
	"exa",
	"brave",
	"searxng",
] as const;
export const DEFAULT_EXTRACT_PROVIDERS = [
	"firecrawl",
	"jina",
	"exa",
	"http",
] as const;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const DEFAULT_SEARCH_CONFIG: SearchConfig = {
	providers: [...DEFAULT_SEARCH_PROVIDERS],
	limit: 5,
	timeoutMs: 60_000,
	attemptTimeoutMs: 20_000,
	maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
};

const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
	providers: [...DEFAULT_EXTRACT_PROVIDERS],
	timeoutMs: 120_000,
	attemptTimeoutMs: 45_000,
	maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
	minContentCharacters: 500,
};

const SEARCH_TYPES = new Set<ProviderType>([
	"tavily",
	"exa",
	"brave",
	"searxng",
]);
const EXTRACT_TYPES = new Set<ProviderType>([
	"firecrawl",
	"jina",
	"exa",
	"http",
	"anysearch",
]);
SEARCH_TYPES.add("anysearch");

const DEFAULT_INSTANCE_CONFIGS: ProviderInstanceConfig[] = [
	{ id: "tavily", type: "tavily" },
	{ id: "exa", type: "exa" },
	{ id: "brave", type: "brave" },
	{ id: "searxng", type: "searxng" },
	{ id: "firecrawl", type: "firecrawl" },
	{ id: "jina", type: "jina" },
	{ id: "http", type: "http" },
	{ id: "anysearch", type: "anysearch", searchFilterMode: "strict" },
];

const STANDARD_KEY_ENV: Partial<Record<ProviderType, string>> = {
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
	brave: "BRAVE_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
	jina: "JINA_API_KEY",
	anysearch: "ANYSEARCH_API_KEY",
};

const STANDARD_BASE_ENV: Partial<Record<ProviderType, string>> = {
	tavily: "TAVILY_BASE_URL",
	exa: "EXA_BASE_URL",
	brave: "BRAVE_BASE_URL",
	searxng: "SEARXNG_BASE_URL",
	firecrawl: "FIRECRAWL_BASE_URL",
	jina: "JINA_BASE_URL",
	anysearch: "ANYSEARCH_BASE_URL",
};

const ALLOWED_INSTANCE_KEYS = new Set([
	"id",
	"type",
	"apiKey",
	"apiKeyEnv",
	"baseUrl",
	"baseUrlEnv",
	"headers",
	"searchFilterMode",
]);
const ALLOWED_SEARCH_KEYS = new Set([
	"providers",
	"limit",
	"timeoutMs",
	"attemptTimeoutMs",
	"maxResponseBytes",
]);
const ALLOWED_EXTRACT_KEYS = new Set([
	"providers",
	"timeoutMs",
	"attemptTimeoutMs",
	"maxResponseBytes",
	"minContentCharacters",
]);

export class ConfigError extends WebAccessError {
	constructor(message: string, details?: unknown) {
		super("config_error", message, { details });
		this.name = "ConfigError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
	path: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new ConfigError(`${path} 必须是 JSON 对象`);
}

function assertKnownKeys(
	value: Record<string, unknown>,
	allowed: Set<string>,
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			throw new ConfigError(`${path}.${key} 不是受支持的配置字段`);
	}
}

function parsePositiveInt(
	value: unknown,
	path: string,
	defaultValue: number,
): number {
	if (value === undefined) return defaultValue;
	if (!Number.isInteger(value) || (value as number) < 1)
		throw new ConfigError(`${path} 必须是大于 0 的整数`);
	return value as number;
}

function parseLimit(value: unknown): number {
	const limit = parsePositiveInt(
		value,
		"search.limit",
		DEFAULT_SEARCH_CONFIG.limit,
	);
	if (limit > 20) throw new ConfigError("search.limit 不能超过 20");
	return limit;
}

function parseString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new ConfigError(`${path} 必须是非空字符串`);
	return value.trim();
}

function parseOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	return parseString(value, path);
}

function validateEnvName(value: string, path: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
		throw new ConfigError(`${path} 不是合法环境变量名`);
	return value;
}

function normalizeHeaders(
	value: unknown,
	path: string,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	assertRecord(value, path);
	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (!name.trim() || /[\r\n]/.test(name))
			throw new ConfigError(`${path} 包含非法 header 名称`);
		if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue))
			throw new ConfigError(`${path}.${name} 必须是无换行字符串`);
		headers[name] = headerValue;
	}
	return headers;
}

function normalizeBaseUrl(value: string, path: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`${path} 必须是 HTTP(S) URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ConfigError(`${path} 必须使用 http 或 https`);
	if (url.username || url.password)
		throw new ConfigError(`${path} 不允许包含 URL 用户名或密码`);
	url.search = "";
	url.hash = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function parseInstance(value: unknown, index: number): ProviderInstanceConfig {
	const path = `providers[${index}]`;
	assertRecord(value, path);
	assertKnownKeys(value, ALLOWED_INSTANCE_KEYS, path);
	const id = parseString(value.id, `${path}.id`).toLowerCase();
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || id === "auto")
		throw new ConfigError(`${path}.id 不是合法 instance id`);
	const type = parseString(value.type, `${path}.type`).toLowerCase();
	if (!PROVIDER_TYPES.includes(type as ProviderType))
		throw new ConfigError(`${path}.type 不受支持: ${type}`);
	const apiKey = parseOptionalString(value.apiKey, `${path}.apiKey`);
	const apiKeyEnvRaw = parseOptionalString(
		value.apiKeyEnv,
		`${path}.apiKeyEnv`,
	);
	const baseUrlRaw = parseOptionalString(value.baseUrl, `${path}.baseUrl`);
	const baseUrl = baseUrlRaw
		? normalizeBaseUrl(baseUrlRaw, `${path}.baseUrl`)
		: undefined;
	const baseUrlEnvRaw = parseOptionalString(
		value.baseUrlEnv,
		`${path}.baseUrlEnv`,
	);
	const headers = normalizeHeaders(value.headers, `${path}.headers`);
	const searchFilterMode =
		value.searchFilterMode === undefined
			? undefined
			: parseString(
					value.searchFilterMode,
					`${path}.searchFilterMode`,
				).toLowerCase();
	if (
		searchFilterMode !== undefined &&
		!SEARCH_FILTER_MODES.includes(searchFilterMode as SearchFilterMode)
	)
		throw new ConfigError(
			`${path}.searchFilterMode 必须是 strict 或 best_effort`,
		);
	if (searchFilterMode !== undefined && type !== "anysearch")
		throw new ConfigError(`${path}.searchFilterMode 仅适用于 anysearch`);
	return {
		id,
		type: type as ProviderType,
		...(apiKey ? { apiKey } : {}),
		...(apiKeyEnvRaw
			? { apiKeyEnv: validateEnvName(apiKeyEnvRaw, `${path}.apiKeyEnv`) }
			: {}),
		...(baseUrl ? { baseUrl } : {}),
		...(baseUrlEnvRaw
			? { baseUrlEnv: validateEnvName(baseUrlEnvRaw, `${path}.baseUrlEnv`) }
			: {}),
		...(headers ? { headers } : {}),
		...(searchFilterMode
			? { searchFilterMode: searchFilterMode as SearchFilterMode }
			: {}),
	};
}

function parseRoute(value: unknown, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value))
		throw new ConfigError(`${path} 必须是 instance id 数组`);
	const result: string[] = [];
	for (const [index, item] of value.entries()) {
		const id = parseString(item, `${path}[${index}]`).toLowerCase();
		if (id === "auto" || result.includes(id))
			throw new ConfigError(`${path} 包含重复或保留 id: ${id}`);
		result.push(id);
	}
	return result;
}

function parseSearch(value: unknown): Partial<SearchConfig> {
	if (value === undefined) return {};
	assertRecord(value, "search");
	assertKnownKeys(value, ALLOWED_SEARCH_KEYS, "search");
	return {
		providers: parseRoute(value.providers, "search.providers"),
		limit: parseLimit(value.limit),
		timeoutMs: parsePositiveInt(
			value.timeoutMs,
			"search.timeoutMs",
			DEFAULT_SEARCH_CONFIG.timeoutMs,
		),
		attemptTimeoutMs: parsePositiveInt(
			value.attemptTimeoutMs,
			"search.attemptTimeoutMs",
			DEFAULT_SEARCH_CONFIG.attemptTimeoutMs,
		),
		maxResponseBytes: parsePositiveInt(
			value.maxResponseBytes,
			"search.maxResponseBytes",
			DEFAULT_SEARCH_CONFIG.maxResponseBytes,
		),
	};
}

function parseExtract(value: unknown): Partial<ExtractConfig> {
	if (value === undefined) return {};
	assertRecord(value, "extract");
	assertKnownKeys(value, ALLOWED_EXTRACT_KEYS, "extract");
	return {
		providers: parseRoute(value.providers, "extract.providers"),
		timeoutMs: parsePositiveInt(
			value.timeoutMs,
			"extract.timeoutMs",
			DEFAULT_EXTRACT_CONFIG.timeoutMs,
		),
		attemptTimeoutMs: parsePositiveInt(
			value.attemptTimeoutMs,
			"extract.attemptTimeoutMs",
			DEFAULT_EXTRACT_CONFIG.attemptTimeoutMs,
		),
		maxResponseBytes: parsePositiveInt(
			value.maxResponseBytes,
			"extract.maxResponseBytes",
			DEFAULT_EXTRACT_CONFIG.maxResponseBytes,
		),
		minContentCharacters: parsePositiveInt(
			value.minContentCharacters,
			"extract.minContentCharacters",
			DEFAULT_EXTRACT_CONFIG.minContentCharacters,
		),
	};
}

function parseRawConfig(value: unknown): {
	instances: ProviderInstanceConfig[];
	search: Partial<SearchConfig>;
	extract: Partial<ExtractConfig>;
} {
	assertRecord(value, "config");
	assertKnownKeys(
		value,
		new Set(["$schema", "providers", "search", "extract"]),
		"config",
	);
	if (value.$schema !== undefined && typeof value.$schema !== "string")
		throw new ConfigError("$schema 必须是字符串");
	const rawInstances = value.providers === undefined ? [] : value.providers;
	if (!Array.isArray(rawInstances))
		throw new ConfigError("providers 必须是数组");
	const instances = rawInstances.map(parseInstance);
	const ids = new Set<string>();
	for (const instance of instances) {
		if (ids.has(instance.id))
			throw new ConfigError(`providers 中存在重复 id: ${instance.id}`);
		ids.add(instance.id);
	}
	return {
		instances,
		search: parseSearch(value.search),
		extract: parseExtract(value.extract),
	};
}

function mergeInstances(
	overrides: ProviderInstanceConfig[],
): ProviderInstanceConfig[] {
	const merged = DEFAULT_INSTANCE_CONFIGS.map((instance) => ({ ...instance }));
	const byId = new Map(merged.map((instance) => [instance.id, instance]));
	for (const override of overrides) {
		const existing = byId.get(override.id);
		if (existing) {
			if (existing.type !== override.type)
				throw new ConfigError(
					`默认 instance ${override.id} 的 type 不能改为 ${override.type}`,
				);
			Object.assign(existing, override);
		} else {
			const copy = { ...override };
			merged.push(copy);
			byId.set(copy.id, copy);
		}
	}
	return merged;
}

function validateRoutes(
	instances: ProviderInstanceConfig[],
	route: string[] | undefined,
	capability: Capability,
): string[] {
	const allowed = capability === "search" ? SEARCH_TYPES : EXTRACT_TYPES;
	const byId = new Map(instances.map((instance) => [instance.id, instance]));
	const chosen =
		route ??
		(capability === "search"
			? [...DEFAULT_SEARCH_PROVIDERS]
			: [...DEFAULT_EXTRACT_PROVIDERS]);
	for (const id of chosen) {
		const instance = byId.get(id);
		if (!instance)
			throw new ConfigError(
				`${capability}.providers 引用了不存在的 instance: ${id}`,
			);
		if (!allowed.has(instance.type))
			throw new ConfigError(
				`${capability}.providers 的 instance ${id} 不支持 ${capability}`,
			);
	}
	return chosen;
}

export function getDefaultConfigPath(): string {
	return join(homedir(), ".config", "web-access-cli", "config.json");
}

export function resolveConfigPath(
	explicitPath?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const raw = explicitPath || env[CONFIG_ENV] || getDefaultConfigPath();
	return isAbsolute(raw) ? raw : resolve(raw);
}

function resolveEnvValue(
	name: string | undefined,
	fallback: string | undefined,
	env: NodeJS.ProcessEnv,
): {
	value: string | null;
	source: "custom_env" | "standard_env" | "config" | "missing";
} {
	const custom = name ? env[name]?.trim() : undefined;
	if (custom) return { value: custom, source: "custom_env" };
	const standard = fallback ? env[fallback]?.trim() : undefined;
	if (standard) return { value: standard, source: "standard_env" };
	return { value: null, source: "missing" };
}

function resolveProvider(
	instance: ProviderInstanceConfig,
	env: NodeJS.ProcessEnv,
): ProviderInstance {
	const standardKeyEnv =
		instance.id === instance.type ? STANDARD_KEY_ENV[instance.type] : undefined;
	const keyEnv = resolveEnvValue(instance.apiKeyEnv, standardKeyEnv, env);
	const apiKey = keyEnv.value ?? instance.apiKey ?? null;
	const credentialSource = apiKey
		? keyEnv.value
			? keyEnv.source
			: "config"
		: "missing";
	const standardBaseEnv = STANDARD_BASE_ENV[instance.type];
	const baseEnv = resolveEnvValue(
		instance.baseUrlEnv,
		instance.id === instance.type ? standardBaseEnv : undefined,
		env,
	);
	const rawBaseUrl =
		baseEnv.value ??
		instance.baseUrl ??
		DEFAULT_BASE_URLS[instance.type] ??
		null;
	const baseUrl = rawBaseUrl
		? normalizeBaseUrl(
				rawBaseUrl,
				baseEnv.value
					? (instance.baseUrlEnv ??
							STANDARD_BASE_ENV[instance.type] ??
							"baseUrl 环境变量")
					: `providers.${instance.id}.baseUrl`,
			)
		: null;
	const baseUrlSource = baseEnv.value
		? baseEnv.source
		: instance.baseUrl
			? "config"
			: DEFAULT_BASE_URLS[instance.type]
				? "default"
				: "missing";
	return {
		id: instance.id,
		type: instance.type,
		apiKey,
		credentialSource,
		baseUrl,
		baseUrlSource,
		headers: { ...(instance.headers ?? {}) },
		searchFilterMode:
			instance.searchFilterMode ??
			(instance.type === "anysearch" ? "strict" : null),
	};
}

const DEFAULT_BASE_URLS: Partial<Record<ProviderType, string>> = {
	tavily: "https://api.tavily.com",
	exa: "https://api.exa.ai",
	brave: "https://api.search.brave.com",
	firecrawl: "https://api.firecrawl.dev",
	jina: "https://r.jina.ai",
	anysearch: "https://api.anysearch.com",
};

export interface LoadedConfig {
	path: string;
	exists: boolean;
	app: AppConfig;
	instances: ProviderInstance[];
}

export function createDefaultAppConfig(): AppConfig {
	return {
		providers: DEFAULT_INSTANCE_CONFIGS.map((instance) => ({ ...instance })),
		search: {
			...DEFAULT_SEARCH_CONFIG,
			providers: [...DEFAULT_SEARCH_CONFIG.providers],
		},
		extract: {
			...DEFAULT_EXTRACT_CONFIG,
			providers: [...DEFAULT_EXTRACT_CONFIG.providers],
		},
	};
}

export function loadConfig(
	explicitPath?: string,
	env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
	const path = resolveConfigPath(explicitPath, env);
	const defaults = createDefaultAppConfig();
	let parsed: unknown = {};
	const exists = existsSync(path);
	if (exists) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ConfigError(
				`无法解析 ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else if (explicitPath || env[CONFIG_ENV]) {
		throw new ConfigError(`配置文件不存在: ${path}`);
	}
	const raw = parseRawConfig(parsed);
	const instanceConfigs = mergeInstances(raw.instances);
	const searchProviders = validateRoutes(
		instanceConfigs,
		raw.search.providers,
		"search",
	);
	const extractProviders = validateRoutes(
		instanceConfigs,
		raw.extract.providers,
		"extract",
	);
	const search: SearchConfig = {
		providers: searchProviders,
		limit: raw.search.limit ?? defaults.search.limit,
		timeoutMs: raw.search.timeoutMs ?? defaults.search.timeoutMs,
		attemptTimeoutMs:
			raw.search.attemptTimeoutMs ?? defaults.search.attemptTimeoutMs,
		maxResponseBytes:
			raw.search.maxResponseBytes ?? defaults.search.maxResponseBytes,
	};
	const extract: ExtractConfig = {
		providers: extractProviders,
		timeoutMs: raw.extract.timeoutMs ?? defaults.extract.timeoutMs,
		attemptTimeoutMs:
			raw.extract.attemptTimeoutMs ?? defaults.extract.attemptTimeoutMs,
		maxResponseBytes:
			raw.extract.maxResponseBytes ?? defaults.extract.maxResponseBytes,
		minContentCharacters:
			raw.extract.minContentCharacters ?? defaults.extract.minContentCharacters,
	};
	const app: AppConfig = { providers: instanceConfigs, search, extract };
	return {
		path,
		exists,
		app,
		instances: instanceConfigs.map((instance) =>
			resolveProvider(instance, env),
		),
	};
}

export function capabilitySupports(
	type: ProviderType,
	capability: Capability,
): boolean {
	return capability === "search"
		? SEARCH_TYPES.has(type)
		: EXTRACT_TYPES.has(type);
}

export function getRoute(config: AppConfig, capability: Capability): string[] {
	return capability === "search"
		? config.search.providers
		: config.extract.providers;
}

export function getCapabilityConfig(
	config: AppConfig,
	capability: Capability,
): SearchConfig | ExtractConfig {
	return capability === "search" ? config.search : config.extract;
}

export function providerRef(instance: ProviderInstance): {
	id: string;
	type: ProviderType;
} {
	return { id: instance.id, type: instance.type };
}
