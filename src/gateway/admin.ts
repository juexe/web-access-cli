import { existsSync, readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import {
	capabilitySupports,
	type LoadedConfig,
	loadConfig,
	loadConfigContents,
} from "../config/config.ts";
import { CONFIG_SCHEMA_URL } from "../config/file.ts";
import { executeDoctor } from "../core/diagnostics.ts";
import {
	type Capability,
	type CredentialSource,
	PROVIDER_TYPES,
	type ProviderInstance,
	type ProviderInstanceConfig,
	type ProviderType,
	SEARCH_FILTER_MODES,
	type SearchFilterMode,
} from "../core/types.ts";
import { getAdapter } from "../providers/registry.ts";
import { VERSION } from "../version.ts";
import type {
	GatewayProviderStats,
	GatewayStatsSnapshot,
	GatewayStatsTracker,
} from "./records.ts";
import { GatewayValidationError } from "./schema.ts";
import {
	checkGatewayReadiness,
	type GatewayReadiness,
	type GatewayService,
} from "./service.ts";

const BUILTIN_PROVIDER_IDS = new Set<string>(PROVIDER_TYPES);

export interface AdminProviderConfigSummary {
	hasConfigApiKey: boolean;
	apiKeyEnv?: string;
	configBaseUrl?: string;
	effectiveBaseUrl: string | null;
	baseUrlEnv?: string;
	authJson?: string;
	authJsonEnv?: string;
	model?: string;
	modelEnv?: string;
	searchFilterMode?: SearchFilterMode | null;
	headerNames: string[];
}

export interface AdminProviderItem {
	id: string;
	type: ProviderType;
	isBuiltin: boolean;
	capabilities: Capability[];
	routeRole: {
		search: "primary" | "fallback" | "disabled";
		searchIndex: number | null;
		extract: "primary" | "fallback" | "disabled";
		extractIndex: number | null;
	};
	configured: {
		credential: boolean;
		baseUrl: boolean;
		adapter: boolean;
		searchReady: boolean;
		extractReady: boolean;
	};
	credentialSource: CredentialSource;
	baseUrlSource: ProviderInstance["baseUrlSource"];
	authJsonSource: ProviderInstance["authJsonSource"];
	modelSource: ProviderInstance["modelSource"];
	config: AdminProviderConfigSummary;
	stats: GatewayProviderStats;
}

export interface AdminDoctorSummary {
	ok: boolean;
	message?: string;
	routes: {
		search: boolean;
		extract: boolean;
	};
	providers: Array<{
		id: string;
		type: ProviderType;
		ok: boolean;
		checks: {
			search: boolean;
			extract: boolean;
		};
	}>;
}

export interface AdminOverviewPayload {
	generatedAt: number;
	gateway: {
		version: string;
		startedAt: number;
		uptimeMs: number;
		readiness: GatewayReadiness;
		configPath: string;
		configExists: boolean;
		configPersisted: boolean;
		persistWarning?: string;
		retention: number;
	};
	routes: {
		search: {
			providers: string[];
			providers_fallback: string[];
			limit: number;
			timeoutMs: number;
			attemptTimeoutMs: number;
			maxResponseBytes: number;
		};
		extract: {
			providers: string[];
			providers_fallback: string[];
			timeoutMs: number;
			attemptTimeoutMs: number;
			maxResponseBytes: number;
			minContentCharacters: number;
		};
	};
	providers: AdminProviderItem[];
	providerTypes: Array<{
		type: ProviderType;
		capabilities: Capability[];
		supportsFilterMode: boolean;
		isXai: boolean;
	}>;
	doctor: AdminDoctorSummary;
	stats: GatewayStatsSnapshot;
}

export interface GatewayProviderPatch {
	id: string;
	type: ProviderType;
	apiKeyAction?: "keep" | "set" | "clear";
	apiKey?: string;
	apiKeyEnv?: string | null;
	baseUrl?: string | null;
	baseUrlEnv?: string | null;
	authJson?: string | null;
	authJsonEnv?: string | null;
	model?: string | null;
	modelEnv?: string | null;
	searchFilterMode?: SearchFilterMode | null;
}

export interface GatewayConfigUpdateRequest {
	search?: {
		providers?: string[];
		providers_fallback?: string[];
		limit?: number;
		timeoutMs?: number;
		attemptTimeoutMs?: number;
		maxResponseBytes?: number;
	};
	extract?: {
		providers?: string[];
		providers_fallback?: string[];
		timeoutMs?: number;
		attemptTimeoutMs?: number;
		minContentCharacters?: number;
		maxResponseBytes?: number;
	};
	providers?: GatewayProviderPatch[];
	removeProviders?: string[];
	allowUnready?: boolean;
}

export interface GatewayAdminController {
	getOverview(): AdminOverviewPayload;
	updateConfig(patch: GatewayConfigUpdateRequest): Promise<{
		updated: true;
		persisted: boolean;
		persistWarning?: string;
		overview: AdminOverviewPayload;
	}>;
	reloadConfig(): Promise<{
		reloaded: true;
		overview: AdminOverviewPayload;
	}>;
}

function emptyProviderStats(): GatewayProviderStats {
	return {
		search: {
			attempts: 0,
			successes: 0,
			failures: 0,
			skipped: 0,
			totalDurationMs: 0,
			avgDurationMs: 0,
			errorCodes: {},
		},
		extract: {
			attempts: 0,
			successes: 0,
			failures: 0,
			skipped: 0,
			totalDurationMs: 0,
			avgDurationMs: 0,
			errorCodes: {},
		},
	};
}

function serializeLoadedConfig(loaded: LoadedConfig): string {
	return `${JSON.stringify(
		{
			$schema: CONFIG_SCHEMA_URL,
			providers: loaded.app.providers,
			search: loaded.app.search,
			extract: loaded.app.extract,
		},
		null,
		2,
	)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) {
		throw new GatewayValidationError(`${label} 必须是字符串数组。`);
	}
	return value.map((item, idx) => {
		if (typeof item !== "string" || !item.trim()) {
			throw new GatewayValidationError(`${label}[${idx}] 必须是非空字符串。`);
		}
		return item.trim().toLowerCase();
	});
}

function parseOptionalInt(
	value: unknown,
	label: string,
	min = 1,
	max?: number,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new GatewayValidationError(`${label} 必须是大于等于 ${min} 的整数。`);
	}
	if (max !== undefined && value > max) {
		throw new GatewayValidationError(`${label} 不能超过 ${max}。`);
	}
	return value;
}

function parseNullableString(
	value: unknown,
	label: string,
): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new GatewayValidationError(`${label} 必须是字符串或 null。`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function parseGatewayConfigUpdateRequest(
	body: unknown,
): GatewayConfigUpdateRequest {
	if (!isPlainObject(body)) {
		throw new GatewayValidationError("配置更新请求体必须是 JSON 对象。");
	}
	const allowedTop = new Set([
		"search",
		"extract",
		"providers",
		"removeProviders",
		"allowUnready",
	]);
	for (const key of Object.keys(body)) {
		if (!allowedTop.has(key)) {
			throw new GatewayValidationError(`未知配置更新字段: ${key}。`);
		}
	}

	const result: GatewayConfigUpdateRequest = {};

	if (body.search !== undefined) {
		if (!isPlainObject(body.search)) {
			throw new GatewayValidationError("search 必须是对象。");
		}
		const s = body.search;
		const allowedSearch = new Set([
			"providers",
			"providers_fallback",
			"limit",
			"timeoutMs",
			"attemptTimeoutMs",
			"maxResponseBytes",
		]);
		for (const key of Object.keys(s)) {
			if (!allowedSearch.has(key)) {
				throw new GatewayValidationError(`search 包含未知字段: ${key}。`);
			}
		}
		result.search = {
			...(s.providers !== undefined
				? { providers: parseStringArray(s.providers, "search.providers") }
				: {}),
			...(s.providers_fallback !== undefined
				? {
						providers_fallback: parseStringArray(
							s.providers_fallback,
							"search.providers_fallback",
						),
					}
				: {}),
			...(s.limit !== undefined
				? { limit: parseOptionalInt(s.limit, "search.limit", 1, 20) }
				: {}),
			...(s.timeoutMs !== undefined
				? { timeoutMs: parseOptionalInt(s.timeoutMs, "search.timeoutMs", 1) }
				: {}),
			...(s.attemptTimeoutMs !== undefined
				? {
						attemptTimeoutMs: parseOptionalInt(
							s.attemptTimeoutMs,
							"search.attemptTimeoutMs",
							1,
						),
					}
				: {}),
			...(s.maxResponseBytes !== undefined
				? {
						maxResponseBytes: parseOptionalInt(
							s.maxResponseBytes,
							"search.maxResponseBytes",
							1024,
						),
					}
				: {}),
		};
	}

	if (body.extract !== undefined) {
		if (!isPlainObject(body.extract)) {
			throw new GatewayValidationError("extract 必须是对象。");
		}
		const e = body.extract;
		const allowedExtract = new Set([
			"providers",
			"providers_fallback",
			"timeoutMs",
			"attemptTimeoutMs",
			"minContentCharacters",
			"maxResponseBytes",
		]);
		for (const key of Object.keys(e)) {
			if (!allowedExtract.has(key)) {
				throw new GatewayValidationError(`extract 包含未知字段: ${key}。`);
			}
		}
		result.extract = {
			...(e.providers !== undefined
				? { providers: parseStringArray(e.providers, "extract.providers") }
				: {}),
			...(e.providers_fallback !== undefined
				? {
						providers_fallback: parseStringArray(
							e.providers_fallback,
							"extract.providers_fallback",
						),
					}
				: {}),
			...(e.timeoutMs !== undefined
				? { timeoutMs: parseOptionalInt(e.timeoutMs, "extract.timeoutMs", 1) }
				: {}),
			...(e.attemptTimeoutMs !== undefined
				? {
						attemptTimeoutMs: parseOptionalInt(
							e.attemptTimeoutMs,
							"extract.attemptTimeoutMs",
							1,
						),
					}
				: {}),
			...(e.minContentCharacters !== undefined
				? {
						minContentCharacters: parseOptionalInt(
							e.minContentCharacters,
							"extract.minContentCharacters",
							1,
						),
					}
				: {}),
			...(e.maxResponseBytes !== undefined
				? {
						maxResponseBytes: parseOptionalInt(
							e.maxResponseBytes,
							"extract.maxResponseBytes",
							1024,
						),
					}
				: {}),
		};
	}

	if (body.providers !== undefined) {
		if (!Array.isArray(body.providers)) {
			throw new GatewayValidationError("providers 必须是数组。");
		}
		const allowedProviderKeys = new Set([
			"id",
			"type",
			"apiKeyAction",
			"apiKey",
			"apiKeyEnv",
			"baseUrl",
			"baseUrlEnv",
			"authJson",
			"authJsonEnv",
			"model",
			"modelEnv",
			"searchFilterMode",
		]);
		result.providers = body.providers.map((raw, idx) => {
			const label = `providers[${idx}]`;
			if (!isPlainObject(raw)) {
				throw new GatewayValidationError(`${label} 必须是对象。`);
			}
			for (const key of Object.keys(raw)) {
				if (!allowedProviderKeys.has(key)) {
					throw new GatewayValidationError(`${label} 包含未知字段: ${key}。`);
				}
			}
			if (typeof raw.id !== "string" || !raw.id.trim()) {
				throw new GatewayValidationError(`${label}.id 必须是非空字符串。`);
			}
			if (typeof raw.type !== "string" || !raw.type.trim()) {
				throw new GatewayValidationError(`${label}.type 必须是非空字符串。`);
			}
			const type = raw.type.trim().toLowerCase();
			if (!PROVIDER_TYPES.includes(type as ProviderType)) {
				throw new GatewayValidationError(`${label}.type 不受支持: ${type}。`);
			}
			let apiKeyAction: "keep" | "set" | "clear" = "keep";
			if (raw.apiKeyAction !== undefined) {
				if (
					raw.apiKeyAction !== "keep" &&
					raw.apiKeyAction !== "set" &&
					raw.apiKeyAction !== "clear"
				) {
					throw new GatewayValidationError(
						`${label}.apiKeyAction 必须是 keep、set 或 clear。`,
					);
				}
				apiKeyAction = raw.apiKeyAction;
			}
			let apiKey: string | undefined;
			if (apiKeyAction === "set") {
				if (typeof raw.apiKey !== "string" || !raw.apiKey.trim()) {
					throw new GatewayValidationError(
						`${label}.apiKey 在 apiKeyAction=set 时必须提供非空字符串。`,
					);
				}
				apiKey = raw.apiKey.trim();
			}
			const searchFilterModeRaw = parseNullableString(
				raw.searchFilterMode,
				`${label}.searchFilterMode`,
			);
			if (
				typeof searchFilterModeRaw === "string" &&
				!SEARCH_FILTER_MODES.includes(searchFilterModeRaw as SearchFilterMode)
			) {
				throw new GatewayValidationError(
					`${label}.searchFilterMode 必须是 strict 或 best_effort。`,
				);
			}
			return {
				id: raw.id.trim().toLowerCase(),
				type: type as ProviderType,
				apiKeyAction,
				...(apiKey ? { apiKey } : {}),
				apiKeyEnv: parseNullableString(raw.apiKeyEnv, `${label}.apiKeyEnv`),
				baseUrl: parseNullableString(raw.baseUrl, `${label}.baseUrl`),
				baseUrlEnv: parseNullableString(raw.baseUrlEnv, `${label}.baseUrlEnv`),
				authJson: parseNullableString(raw.authJson, `${label}.authJson`),
				authJsonEnv: parseNullableString(
					raw.authJsonEnv,
					`${label}.authJsonEnv`,
				),
				model: parseNullableString(raw.model, `${label}.model`),
				modelEnv: parseNullableString(raw.modelEnv, `${label}.modelEnv`),
				searchFilterMode: searchFilterModeRaw as
					| SearchFilterMode
					| null
					| undefined,
			};
		});
	}

	if (body.removeProviders !== undefined) {
		result.removeProviders = parseStringArray(
			body.removeProviders,
			"removeProviders",
		);
	}

	if (body.allowUnready !== undefined) {
		if (typeof body.allowUnready !== "boolean") {
			throw new GatewayValidationError("allowUnready 必须是布尔值。");
		}
		result.allowUnready = body.allowUnready;
	}

	return result;
}

async function resolveTargetFile(path: string): Promise<string> {
	try {
		const info = await lstat(path);
		if (!info.isSymbolicLink()) return path;
		const target = await realpath(path);
		const targetInfo = await stat(target);
		if (!targetInfo.isFile()) {
			throw new Error(`配置文件符号链接目标不是普通文件: ${path}`);
		}
		return target;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return path;
		}
		throw error;
	}
}

async function persistConfigText(
	configPath: string,
	contents: string,
): Promise<{ persisted: boolean; persistWarning?: string }> {
	const target = await resolveTargetFile(configPath);
	try {
		await mkdir(dirname(target), { recursive: true });
	} catch {
		// Parent directory may be on a read-only rootfs in container mode.
	}
	try {
		await writeFileAtomic(target, contents, { encoding: "utf8", fsync: true });
		return { persisted: true };
	} catch (atomicError) {
		const code = (atomicError as NodeJS.ErrnoException)?.code;
		if (
			code !== "EROFS" &&
			code !== "EBUSY" &&
			code !== "EPERM" &&
			code !== "EACCES" &&
			code !== "EXDEV" &&
			code !== "ENOENT"
		) {
			throw atomicError;
		}
		try {
			await writeFile(target, contents, "utf8");
			return { persisted: true };
		} catch (directError) {
			const directCode = (directError as NodeJS.ErrnoException)?.code;
			if (
				directCode === "EROFS" ||
				directCode === "EACCES" ||
				directCode === "EPERM" ||
				directCode === "ENOENT"
			) {
				return {
					persisted: false,
					persistWarning:
						"当前配置文件为只读挂载，修改已在内存立即生效，容器重启后将恢复文件原配置。",
				};
			}
			throw directError;
		}
	}
}

function applyPatchToConfigText(
	baseText: string,
	currentLoaded: LoadedConfig,
	patch: GatewayConfigUpdateRequest,
): string {
	let text = baseText;
	const formattingOptions = {
		insertSpaces: true,
		tabSize: 2,
		eol: text.includes("\r\n") ? "\r\n" : "\n",
	};

	const setField = (path: Array<string | number>, value: unknown) => {
		const edits = modify(text, path, value, { formattingOptions });
		text = applyEdits(text, edits);
	};

	if (patch.search) {
		for (const [key, value] of Object.entries(patch.search)) {
			if (value !== undefined) {
				setField(["search", key], value);
			}
		}
	}

	if (patch.extract) {
		for (const [key, value] of Object.entries(patch.extract)) {
			if (value !== undefined) {
				setField(["extract", key], value);
			}
		}
	}

	if (
		(patch.providers && patch.providers.length > 0) ||
		(patch.removeProviders && patch.removeProviders.length > 0)
	) {
		let parsedRoot: Record<string, unknown> = {};
		try {
			parsedRoot = JSON.parse(text) as Record<string, unknown>;
		} catch {
			parsedRoot = {};
		}
		const rawProviders = Array.isArray(parsedRoot.providers)
			? (parsedRoot.providers as ProviderInstanceConfig[])
			: [];
		const byId = new Map<string, ProviderInstanceConfig>();
		for (const entry of currentLoaded.app.providers) {
			// Include existing non-default or configured entries
			const hasCustom =
				!BUILTIN_PROVIDER_IDS.has(entry.id) ||
				entry.apiKey !== undefined ||
				entry.apiKeyEnv !== undefined ||
				entry.baseUrl !== undefined ||
				entry.baseUrlEnv !== undefined ||
				entry.authJson !== undefined ||
				entry.authJsonEnv !== undefined ||
				entry.model !== undefined ||
				entry.modelEnv !== undefined ||
				entry.headers !== undefined ||
				((entry.type === "anysearch" || entry.type === "xcrawl") &&
					entry.searchFilterMode !== undefined &&
					entry.searchFilterMode !== "strict");
			if (hasCustom) {
				byId.set(entry.id, { ...entry });
			}
		}
		for (const entry of rawProviders) {
			if (entry && typeof entry.id === "string") {
				const id = entry.id.toLowerCase();
				byId.set(id, { ...(byId.get(id) ?? {}), ...entry, id });
			}
		}

		for (const removeId of patch.removeProviders ?? []) {
			byId.delete(removeId.toLowerCase());
		}

		for (const item of patch.providers ?? []) {
			const existing =
				byId.get(item.id) ??
				currentLoaded.app.providers.find(
					(candidate) => candidate.id === item.id,
				);
			const next: ProviderInstanceConfig = {
				...(existing ? { ...existing } : {}),
				id: item.id,
				type: item.type,
			};

			if (item.apiKeyAction === "set" && item.apiKey) {
				next.apiKey = item.apiKey;
			} else if (item.apiKeyAction === "clear") {
				delete next.apiKey;
			}

			const optionalFields = [
				"apiKeyEnv",
				"baseUrl",
				"baseUrlEnv",
				"authJson",
				"authJsonEnv",
				"model",
				"modelEnv",
				"searchFilterMode",
			] as const;
			for (const field of optionalFields) {
				const val = item[field];
				if (val === null) {
					delete next[field];
				} else if (val !== undefined) {
					(next as unknown as Record<string, unknown>)[field] = val;
				}
			}

			byId.set(item.id, next);
		}

		setField(["providers"], Array.from(byId.values()));
	}

	return text;
}

export function createGatewayAdminController(options: {
	service: GatewayService;
	stats: GatewayStatsTracker;
	retention: number;
	startedAt?: number;
	env?: NodeJS.ProcessEnv;
}): GatewayAdminController {
	const { service, stats, retention } = options;
	const startedAt = options.startedAt ?? Date.now();
	const env = options.env ?? process.env;

	let configPersisted = true;
	let persistWarning: string | undefined;
	let lastConfigText: string | undefined;
	let writeQueue: Promise<unknown> = Promise.resolve();

	function readCurrentConfigText(loaded: LoadedConfig): string {
		if (lastConfigText !== undefined && !configPersisted) {
			return lastConfigText;
		}
		if (existsSync(loaded.path)) {
			try {
				return readFileSync(loaded.path, "utf8");
			} catch {
				// Fall back to serialized current config
			}
		}
		return serializeLoadedConfig(loaded);
	}

	function buildOverview(): AdminOverviewPayload {
		const loaded = service.getLoaded();
		const readiness = service.readiness();
		const statsSnapshot = stats.snapshot();
		const rawById = new Map<string, ProviderInstanceConfig>(
			loaded.app.providers.map((item) => [item.id, item]),
		);

		const searchPrimary = loaded.app.search.providers;
		const searchFallback = loaded.app.search.providers_fallback;
		const extractPrimary = loaded.app.extract.providers;
		const extractFallback = loaded.app.extract.providers_fallback;

		const providers: AdminProviderItem[] = loaded.instances.map((instance) => {
			const raw = rawById.get(instance.id);
			const searchAdapter = getAdapter(instance.type, "search");
			const extractAdapter = getAdapter(instance.type, "extract");
			const searchPrimaryIdx = searchPrimary.indexOf(instance.id);
			const searchFallbackIdx = searchFallback.indexOf(instance.id);
			const extractPrimaryIdx = extractPrimary.indexOf(instance.id);
			const extractFallbackIdx = extractFallback.indexOf(instance.id);

			const searchRole: "primary" | "fallback" | "disabled" =
				searchPrimaryIdx !== -1
					? "primary"
					: searchFallbackIdx !== -1
						? "fallback"
						: "disabled";
			const extractRole: "primary" | "fallback" | "disabled" =
				extractPrimaryIdx !== -1
					? "primary"
					: extractFallbackIdx !== -1
						? "fallback"
						: "disabled";

			const capabilities = (["search", "extract"] as const).filter((cap) =>
				capabilitySupports(instance.type, cap),
			);

			return {
				id: instance.id,
				type: instance.type,
				isBuiltin: BUILTIN_PROVIDER_IDS.has(instance.id),
				capabilities,
				routeRole: {
					search: searchRole,
					searchIndex:
						searchPrimaryIdx !== -1
							? searchPrimaryIdx
							: searchFallbackIdx !== -1
								? searchFallbackIdx
								: null,
					extract: extractRole,
					extractIndex:
						extractPrimaryIdx !== -1
							? extractPrimaryIdx
							: extractFallbackIdx !== -1
								? extractFallbackIdx
								: null,
				},
				configured: {
					credential: instance.credentialSource !== "missing",
					baseUrl: instance.baseUrl !== null,
					adapter: Boolean(searchAdapter || extractAdapter),
					searchReady: Boolean(searchAdapter?.isConfigured(instance)),
					extractReady: Boolean(extractAdapter?.isConfigured(instance)),
				},
				credentialSource: instance.credentialSource,
				baseUrlSource: instance.baseUrlSource,
				authJsonSource: instance.authJsonSource,
				modelSource: instance.modelSource,
				config: {
					hasConfigApiKey: Boolean(raw?.apiKey),
					...(raw?.apiKeyEnv ? { apiKeyEnv: raw.apiKeyEnv } : {}),
					...(raw?.baseUrl ? { configBaseUrl: raw.baseUrl } : {}),
					effectiveBaseUrl: instance.baseUrl,
					...(raw?.baseUrlEnv ? { baseUrlEnv: raw.baseUrlEnv } : {}),
					...(raw?.authJson ? { authJson: raw.authJson } : {}),
					...(raw?.authJsonEnv ? { authJsonEnv: raw.authJsonEnv } : {}),
					...(raw?.model ? { model: raw.model } : {}),
					...(raw?.modelEnv ? { modelEnv: raw.modelEnv } : {}),
					...(instance.searchFilterMode
						? { searchFilterMode: instance.searchFilterMode }
						: {}),
					headerNames: Object.keys(raw?.headers ?? {}),
				},
				stats: statsSnapshot.providers[instance.id] ?? emptyProviderStats(),
			};
		});

		const doctorEnvelope = executeDoctor(loaded);
		const doctorDetails = (
			doctorEnvelope.ok ? doctorEnvelope.data : doctorEnvelope.error.details
		) as {
			ok: boolean;
			routes: { search: boolean; extract: boolean };
			providers: Array<{
				id: string;
				type: ProviderType;
				ok: boolean;
				checks: { search: boolean; extract: boolean };
			}>;
		};

		const providerTypes = PROVIDER_TYPES.map((type) => ({
			type,
			capabilities: (["search", "extract"] as const).filter((cap) =>
				capabilitySupports(type, cap),
			),
			supportsFilterMode: type === "anysearch" || type === "xcrawl",
			isXai: type === "xai_x_search" || type === "xai_web_search",
		}));

		const now = Date.now();
		return {
			generatedAt: now,
			gateway: {
				version: VERSION,
				startedAt,
				uptimeMs: Math.max(0, now - startedAt),
				readiness,
				configPath: loaded.path,
				configExists: loaded.exists || existsSync(loaded.path),
				configPersisted,
				...(persistWarning ? { persistWarning } : {}),
				retention,
			},
			routes: {
				search: {
					providers: [...loaded.app.search.providers],
					providers_fallback: [...loaded.app.search.providers_fallback],
					limit: loaded.app.search.limit,
					timeoutMs: loaded.app.search.timeoutMs,
					attemptTimeoutMs: loaded.app.search.attemptTimeoutMs,
					maxResponseBytes: loaded.app.search.maxResponseBytes,
				},
				extract: {
					providers: [...loaded.app.extract.providers],
					providers_fallback: [...loaded.app.extract.providers_fallback],
					timeoutMs: loaded.app.extract.timeoutMs,
					attemptTimeoutMs: loaded.app.extract.attemptTimeoutMs,
					maxResponseBytes: loaded.app.extract.maxResponseBytes,
					minContentCharacters: loaded.app.extract.minContentCharacters,
				},
			},
			providers,
			providerTypes,
			doctor: {
				ok: doctorEnvelope.ok,
				...(!doctorEnvelope.ok
					? { message: doctorEnvelope.error.message }
					: {}),
				routes: doctorDetails.routes,
				providers: doctorDetails.providers,
			},
			stats: statsSnapshot,
		};
	}

	function runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const next = writeQueue.then(task, task);
		writeQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	return {
		getOverview() {
			return buildOverview();
		},

		updateConfig(patch) {
			return runExclusive(async () => {
				const currentLoaded = service.getLoaded();
				const baseText = readCurrentConfigText(currentLoaded);
				const nextText = applyPatchToConfigText(baseText, currentLoaded, patch);

				let nextLoaded: LoadedConfig;
				try {
					nextLoaded = loadConfigContents(currentLoaded.path, nextText, env);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "配置文件校验失败。";
					throw new GatewayValidationError(message);
				}

				const readiness = checkGatewayReadiness(nextLoaded);
				if (!readiness.ready && !patch.allowUnready) {
					throw new GatewayValidationError(
						`更新后的配置会导致网关未就绪（${readiness.reason}），请确保 search 与 extract 路由中各有至少一个已配置凭据的 Provider。`,
					);
				}

				const writeResult = await persistConfigText(
					currentLoaded.path,
					nextText,
				);
				configPersisted = writeResult.persisted;
				persistWarning = writeResult.persistWarning;
				lastConfigText = nextText;
				service.setLoaded({
					...nextLoaded,
					exists: writeResult.persisted || currentLoaded.exists,
				});

				return {
					updated: true as const,
					persisted: writeResult.persisted,
					...(writeResult.persistWarning
						? { persistWarning: writeResult.persistWarning }
						: {}),
					overview: buildOverview(),
				};
			});
		},

		reloadConfig() {
			return runExclusive(async () => {
				const currentLoaded = service.getLoaded();
				let nextLoaded: LoadedConfig;
				try {
					if (existsSync(currentLoaded.path)) {
						const contents = await readFile(currentLoaded.path, "utf8");
						nextLoaded = loadConfigContents(currentLoaded.path, contents, env);
						lastConfigText = contents;
					} else {
						nextLoaded = loadConfig(currentLoaded.path, env);
						lastConfigText = undefined;
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "重载配置文件失败。";
					throw new GatewayValidationError(message);
				}

				const readiness = checkGatewayReadiness(nextLoaded);
				if (!readiness.ready) {
					throw new GatewayValidationError(
						`磁盘配置未就绪（${readiness.reason}），已保留当前运行配置。`,
					);
				}

				configPersisted = true;
				persistWarning = undefined;
				service.setLoaded(nextLoaded);
				return {
					reloaded: true as const,
					overview: buildOverview(),
				};
			});
		},
	};
}
