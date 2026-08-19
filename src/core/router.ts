import type { LoadedConfig } from "../config/config.ts";
import { capabilitySupports } from "../config/config.ts";
import { ref } from "../providers/common.ts";
import { getAdapter } from "../providers/registry.ts";
import { DefaultHttpTransport, type HttpTransport } from "../transport/http.ts";
import { asWebAccessError, redactText, WebAccessError } from "./errors.ts";
import type {
	Capability,
	Command,
	ExtractData,
	ExtractRequest,
	ExtractSuccessEnvelope,
	FailureEnvelope,
	OutputEnvelope,
	ProviderAttempt,
	ProviderExecution,
	ProviderInstance,
	SearchData,
	SearchRequest,
	SearchSuccessEnvelope,
} from "./types.ts";

export interface ExecutionContext {
	loaded: LoadedConfig;
	transport?: HttpTransport;
	signal?: AbortSignal;
	now?: () => number;
}

interface RunResult<T> {
	provider: ProviderInstance;
	execution: ProviderExecution<T>;
	attempts: ProviderAttempt[];
}

interface RunFailure {
	error: WebAccessError;
	attempts: ProviderAttempt[];
	raw?: unknown;
	partial?: { provider: ProviderInstance; data: ExtractData; raw: unknown };
}

function elapsed(start: number, now: () => number): number {
	return Math.max(0, Math.round(now() - start));
}

function withProvider(
	error: WebAccessError,
	instance: ProviderInstance,
): WebAccessError {
	if (error.provider) return error;
	return new WebAccessError(error.code, error.message, {
		retryable: error.retryable,
		provider: ref(instance),
		httpStatus: error.httpStatus,
		details: error.details,
		raw: error.raw,
	});
}

function safeRaw(raw: unknown, instances: ProviderInstance[]): unknown {
	const secrets = instances.map((instance) => instance.apiKey);
	const sensitive =
		/^(?:auto[_-]?registered|api[_-]?key|password|username|user|email|access[_-]?token|refresh[_-]?token|authorization|cookie|client[_-]?secret)$/i;
	const redact = (value: unknown): unknown => {
		if (typeof value === "string") return redactText(value, secrets);
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value))
				result[key] = sensitive.test(key) ? "[REDACTED]" : redact(item);
			return result;
		}
		return value;
	};
	if (typeof raw === "string") {
		try {
			return redact(JSON.parse(raw));
		} catch {
			return redact(raw);
		}
	}
	return redact(raw);
}

function resolveInstances(
	loaded: LoadedConfig,
	capability: Capability,
	selected: string,
): { instances: ProviderInstance[]; automatic: boolean } {
	const route =
		capability === "search"
			? loaded.app.search.providers
			: loaded.app.extract.providers;
	const byId = new Map(
		loaded.instances.map((instance) => [instance.id, instance]),
	);
	if (selected !== "auto") {
		const instance = byId.get(selected);
		if (!instance)
			throw new WebAccessError(
				"provider_unknown",
				`未知 provider instance: ${selected}`,
			);
		if (!capabilitySupports(instance.type, capability))
			throw new WebAccessError(
				"provider_unknown",
				`${selected} 不支持 ${capability}`,
				{ provider: ref(instance) },
			);
		if (!route.includes(selected))
			throw new WebAccessError(
				"provider_disabled",
				`${selected} 未在 ${capability}.providers route 中启用`,
				{ provider: ref(instance) },
			);
		return { instances: [instance], automatic: false };
	}
	return {
		instances: route
			.map((id) => byId.get(id))
			.filter((instance): instance is ProviderInstance => !!instance),
		automatic: true,
	};
}

function timeoutError(instance?: ProviderInstance): WebAccessError {
	return new WebAccessError("timeout", "操作超过总超时时间", {
		retryable: true,
		...(instance ? { provider: ref(instance) } : {}),
	});
}

function unavailableError(
	instance: ProviderInstance,
	capability: Capability,
): WebAccessError {
	return new WebAccessError(
		"provider_unavailable",
		`${instance.id} 未完成 ${capability} 所需配置`,
		{ provider: ref(instance), retryable: true },
	);
}

function normalizeAbort(
	error: WebAccessError,
	parent: AbortSignal | undefined,
	instance: ProviderInstance,
): WebAccessError {
	if (error.code !== "aborted") return withProvider(error, instance);
	if (parent?.aborted)
		return new WebAccessError("aborted", "请求已取消", {
			provider: ref(instance),
		});
	return new WebAccessError("timeout", `${instance.id} 请求超时`, {
		provider: ref(instance),
		retryable: true,
	});
}

function isFallbackEligible(error: WebAccessError): boolean {
	const status = error.httpStatus;
	return (
		error.retryable || (status !== undefined && (status < 200 || status >= 300))
	);
}

async function runProviders<T>(options: {
	capability: Capability;
	selected: string;
	context: ExecutionContext;
	totalTimeoutMs: number;
	attemptTimeoutMs: number;
	invoke(
		instance: ProviderInstance,
		signal: AbortSignal,
		transport: HttpTransport,
	): Promise<ProviderExecution<T>>;
	validate?(
		execution: ProviderExecution<T>,
		instance: ProviderInstance,
	): WebAccessError | undefined;
}): Promise<RunResult<T> | RunFailure> {
	const now = options.context.now ?? performance.now.bind(performance);
	const started = now();
	const transport = options.context.transport ?? new DefaultHttpTransport();
	let resolved: { instances: ProviderInstance[]; automatic: boolean };
	try {
		resolved = resolveInstances(
			options.context.loaded,
			options.capability,
			options.selected,
		);
	} catch (error) {
		return { error: asWebAccessError(error), attempts: [] };
	}
	const attempts: ProviderAttempt[] = [];
	let lastError: WebAccessError | undefined;
	let lastRaw: unknown;
	let partial: RunFailure["partial"];

	for (const instance of resolved.instances) {
		const remaining = options.totalTimeoutMs - elapsed(started, now);
		if (remaining <= 0) {
			lastError = timeoutError(instance);
			break;
		}
		const adapter = getAdapter(instance.type, options.capability);
		const attemptStarted = now();
		if (!adapter?.isConfigured(instance)) {
			const error = unavailableError(instance, options.capability);
			attempts.push({
				provider: ref(instance),
				status: "failed",
				durationMs: elapsed(attemptStarted, now),
				error: error.toInfo(),
			});
			lastError = error;
			if (resolved.automatic) continue;
			break;
		}

		const attemptSignal = AbortSignal.any([
			...(options.context.signal ? [options.context.signal] : []),
			AbortSignal.timeout(
				Math.max(1, Math.min(remaining, options.attemptTimeoutMs)),
			),
		]);
		try {
			const execution = await options.invoke(
				instance,
				attemptSignal,
				transport,
			);
			const qualityError = options.validate?.(execution, instance);
			if (qualityError) {
				lastError = qualityError;
				lastRaw = execution.raw;
				const candidate = execution.data as ExtractData;
				if (
					!partial ||
					candidate.document.content.length >
						partial.data.document.content.length
				) {
					partial = {
						provider: instance,
						data: candidate,
						raw: execution.raw,
					};
				}
				attempts.push({
					provider: ref(instance),
					status: "failed",
					durationMs: elapsed(attemptStarted, now),
					error: qualityError.toInfo(),
				});
				if (!resolved.automatic || !isFallbackEligible(qualityError)) break;
				continue;
			}
			attempts.push({
				provider: ref(instance),
				status: "success",
				durationMs: elapsed(attemptStarted, now),
			});
			return { provider: instance, execution, attempts };
		} catch (caught) {
			const error = normalizeAbort(
				asWebAccessError(caught, "provider_error"),
				options.context.signal,
				instance,
			);
			lastError = error;
			lastRaw = error.raw;
			attempts.push({
				provider: ref(instance),
				status: "failed",
				durationMs: elapsed(attemptStarted, now),
				error: error.toInfo(),
			});
			if (!resolved.automatic || !isFallbackEligible(error)) break;
		}
	}

	if (!lastError)
		lastError = new WebAccessError(
			"provider_exhausted",
			`没有可用的 ${options.capability} provider`,
		);
	else if (
		resolved.automatic &&
		attempts.length > 0 &&
		attempts.every((attempt) => attempt.status === "failed") &&
		isFallbackEligible(lastError)
	) {
		lastError = new WebAccessError(
			"provider_exhausted",
			`所有 ${options.capability} provider 均失败`,
			{
				retryable: false,
				details: { lastError: lastError.toInfo() },
				raw: lastRaw,
			},
		);
	}
	return {
		error: lastError,
		attempts,
		raw: lastRaw,
		...(partial ? { partial } : {}),
	};
}

function failureEnvelope(
	command: "search" | "extract",
	request: SearchRequest | ExtractRequest,
	started: number,
	now: () => number,
	result: RunFailure,
	instances: ProviderInstance[],
): FailureEnvelope {
	return {
		schemaVersion: 1,
		ok: false,
		command,
		durationMs: elapsed(started, now),
		request,
		attempts: result.attempts,
		error: result.error.toInfo(),
		...(result.raw !== undefined
			? { raw: safeRaw(result.raw, instances) }
			: {}),
		...(result.partial
			? {
					partial: {
						provider: ref(result.partial.provider),
						data: result.partial.data,
						raw: safeRaw(result.partial.raw, instances),
					},
				}
			: {}),
	};
}

export async function executeSearch(
	request: SearchRequest,
	context: ExecutionContext,
): Promise<OutputEnvelope> {
	const now = context.now ?? performance.now.bind(performance);
	const started = now();
	const config = context.loaded.app.search;
	const result = await runProviders<SearchData>({
		capability: "search",
		selected: request.provider,
		context,
		totalTimeoutMs: request.timeoutMs ?? config.timeoutMs,
		attemptTimeoutMs: config.attemptTimeoutMs,
		invoke: (instance, signal, transport) => {
			const adapter = getAdapter(instance.type, "search");
			if (!adapter?.search) throw unavailableError(instance, "search");
			return adapter.search({
				query: request.query,
				limit: request.limit,
				freshness: request.freshness,
				includeDomains: request.includeDomains,
				excludeDomains: request.excludeDomains,
				signal,
				maxResponseBytes: config.maxResponseBytes,
				instance,
				transport,
			});
		},
	});
	if ("error" in result)
		return failureEnvelope(
			"search",
			request,
			started,
			now,
			result,
			context.loaded.instances,
		);
	const envelope: SearchSuccessEnvelope = {
		schemaVersion: 1,
		ok: true,
		command: "search",
		durationMs: elapsed(started, now),
		request,
		provider: ref(result.provider),
		attempts: result.attempts,
		data: result.execution.data,
		raw: safeRaw(result.execution.raw, context.loaded.instances),
	};
	return envelope;
}

export async function executeExtract(
	request: ExtractRequest,
	context: ExecutionContext,
): Promise<OutputEnvelope> {
	const now = context.now ?? performance.now.bind(performance);
	const started = now();
	const config = context.loaded.app.extract;
	const result = await runProviders<ExtractData>({
		capability: "extract",
		selected: request.provider,
		context,
		totalTimeoutMs: request.timeoutMs ?? config.timeoutMs,
		attemptTimeoutMs: config.attemptTimeoutMs,
		invoke: (instance, signal, transport) => {
			const adapter = getAdapter(instance.type, "extract");
			if (!adapter?.extract) throw unavailableError(instance, "extract");
			return adapter.extract({
				url: request.url,
				signal,
				maxResponseBytes: config.maxResponseBytes,
				minContentCharacters: config.minContentCharacters,
				instance,
				transport,
			});
		},
		validate: (execution, instance) => {
			const characters = execution.data.document.content.trim().length;
			if (characters >= config.minContentCharacters) return undefined;
			return new WebAccessError(
				"no_usable_content",
				`${instance.id} 返回的正文过短`,
				{
					provider: ref(instance),
					retryable: true,
					details: { characters, minimum: config.minContentCharacters },
					raw: execution.raw,
				},
			);
		},
	});
	if ("error" in result)
		return failureEnvelope(
			"extract",
			request,
			started,
			now,
			result,
			context.loaded.instances,
		);
	const envelope: ExtractSuccessEnvelope = {
		schemaVersion: 1,
		ok: true,
		command: "extract",
		durationMs: elapsed(started, now),
		request,
		provider: ref(result.provider),
		attempts: result.attempts,
		data: result.execution.data,
		raw: safeRaw(result.execution.raw, context.loaded.instances),
	};
	return envelope;
}

export function errorEnvelope(
	error: unknown,
	command: Command | null = null,
): FailureEnvelope {
	const normalized = asWebAccessError(error);
	return {
		schemaVersion: 1,
		ok: false,
		command,
		durationMs: 0,
		error: normalized.toInfo(),
	};
}
