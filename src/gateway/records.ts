export const GATEWAY_RECORD_RETENTION = 500;
export const GATEWAY_RECORD_MAX_RESULTS = 50;
export const GATEWAY_RECORD_MAX_ATTEMPTS = 32;
export const GATEWAY_RECORD_SEARCH_PREVIEW_CHARS = 2_000;
export const GATEWAY_RECORD_FETCH_PREVIEW_CHARS = 4_000;

export interface GatewayAttemptRecord {
	provider: string;
	providerType?: string;
	status: "ok" | "failed" | "skipped";
	durationMs: number;
	errorCode?: string;
	errorMessage?: string;
	httpStatus?: number;
}

export interface GatewayBackfillItemRecord {
	rank: number;
	url: string;
	status: "ok" | "failed" | "skipped";
	provider?: string;
	durationMs: number;
	contentChars?: number;
	errorCode?: string;
	attempts?: GatewayAttemptRecord[];
}

export interface GatewayContentBackfillSummary {
	requestedCount: number;
	attemptedCount: number;
	succeededCount: number;
	failedCount: number;
	skippedCount: number;
	durationMs: number;
	items: GatewayBackfillItemRecord[];
}

export interface GatewayRecordResult {
	rank?: number;
	title: string;
	url: string;
	snippet?: string;
	contentPreview?: string;
	contentChars?: number;
	contentTruncated?: boolean;
}

/**
 * One tool request that reached the provider layer. Records live in memory only
 * and never contain raw upstream payloads, headers or credentials.
 */
export interface GatewayRequestRecord {
	id: string;
	at: number;
	route: "search" | "fetch";
	status: number;
	durationMs: number;
	code?: string;
	provider?: string;
	query?: string;
	url?: string;
	count?: number;
	needContent?: boolean;
	title?: string;
	resultCount?: number;
	results?: GatewayRecordResult[];
	contentPreview?: string;
	contentChars?: number;
	contentTruncated?: boolean;
	attempts?: GatewayAttemptRecord[];
	contentBackfill?: GatewayContentBackfillSummary;
}

export interface GatewayRecordFilter {
	limit?: number;
	route?: "search" | "fetch";
	status?: "ok" | "error";
	provider?: string;
	q?: string;
}

export interface GatewayRecordStore {
	readonly retention: number;
	readonly size: number;
	add(record: GatewayRequestRecord): void;
	/** Newest first, capped at `limit` and optionally filtered. */
	list(limitOrFilter?: number | GatewayRecordFilter): GatewayRequestRecord[];
	get(id: string): GatewayRequestRecord | undefined;
	clear(): number;
}

export interface GatewayCapabilityStats {
	attempts: number;
	successes: number;
	failures: number;
	skipped: number;
	totalDurationMs: number;
	avgDurationMs: number;
	lastUsedAt?: number;
	lastStatus?: "ok" | "failed";
	lastErrorCode?: string;
	errorCodes: Record<string, number>;
}

export interface GatewayProviderStats {
	search: GatewayCapabilityStats;
	extract: GatewayCapabilityStats;
}

export interface GatewayStatsSnapshot {
	startedAt: number;
	resetAt: number;
	totalRequests: number;
	searchRequests: number;
	searchSuccesses: number;
	fetchRequests: number;
	fetchSuccesses: number;
	successCount: number;
	errorCount: number;
	backfillRequests: number;
	backfillItemsSucceeded: number;
	backfillItemsFailed: number;
	providers: Record<string, GatewayProviderStats>;
}

export interface GatewayStatsTracker {
	recordRequest(info: {
		at: number;
		route: "search" | "fetch";
		ok: boolean;
		attempts?: GatewayAttemptRecord[];
		contentBackfill?: GatewayContentBackfillSummary;
	}): void;
	snapshot(): GatewayStatsSnapshot;
	reset(now?: number): void;
}

function truncate(value: string, max: number): string {
	const characters = Array.from(value);
	if (characters.length <= max) return value;
	return `${characters.slice(0, max).join("")}…`;
}

export function truncatePreview(
	value: string,
	maxChars: number,
): {
	preview: string;
	chars: number;
	truncated: boolean;
} {
	const characters = Array.from(value);
	const chars = characters.length;
	if (chars <= maxChars) {
		return { preview: value, chars, truncated: false };
	}
	return {
		preview: `${characters.slice(0, maxChars).join("")}…`,
		chars,
		truncated: true,
	};
}

function optionalString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0
		? truncate(value, max)
		: undefined;
}

function sanitizeAttempts(value: unknown): GatewayAttemptRecord[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attempts: GatewayAttemptRecord[] = [];
	for (const item of value) {
		if (attempts.length >= GATEWAY_RECORD_MAX_ATTEMPTS) break;
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.provider !== "string") continue;
		const status =
			candidate.status === "ok" ||
			candidate.status === "failed" ||
			candidate.status === "skipped"
				? candidate.status
				: undefined;
		if (!status) continue;
		const attempt: GatewayAttemptRecord = {
			provider: truncate(candidate.provider, 64),
			status,
			durationMs:
				typeof candidate.durationMs === "number" &&
				Number.isFinite(candidate.durationMs)
					? Math.max(0, Math.round(candidate.durationMs))
					: 0,
		};
		const providerType = optionalString(candidate.providerType, 32);
		if (providerType) attempt.providerType = providerType;
		const errorCode = optionalString(candidate.errorCode, 64);
		if (errorCode) attempt.errorCode = errorCode;
		const errorMessage = optionalString(candidate.errorMessage, 240);
		if (errorMessage) attempt.errorMessage = errorMessage;
		if (
			typeof candidate.httpStatus === "number" &&
			Number.isInteger(candidate.httpStatus)
		) {
			attempt.httpStatus = candidate.httpStatus;
		}
		attempts.push(attempt);
	}
	return attempts.length > 0 ? attempts : undefined;
}

function sanitizeBackfill(
	value: unknown,
): GatewayContentBackfillSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (!Array.isArray(candidate.items)) return undefined;
	const items: GatewayBackfillItemRecord[] = [];
	for (const rawItem of candidate.items) {
		if (items.length >= GATEWAY_RECORD_MAX_RESULTS) break;
		if (!rawItem || typeof rawItem !== "object") continue;
		const entry = rawItem as Record<string, unknown>;
		if (typeof entry.url !== "string") continue;
		const status =
			entry.status === "ok" ||
			entry.status === "failed" ||
			entry.status === "skipped"
				? entry.status
				: "failed";
		const item: GatewayBackfillItemRecord = {
			rank:
				typeof entry.rank === "number" && Number.isFinite(entry.rank)
					? Math.max(1, Math.floor(entry.rank))
					: items.length + 1,
			url: truncate(entry.url, 400),
			status,
			durationMs:
				typeof entry.durationMs === "number" &&
				Number.isFinite(entry.durationMs)
					? Math.max(0, Math.round(entry.durationMs))
					: 0,
		};
		const provider = optionalString(entry.provider, 64);
		if (provider) item.provider = provider;
		if (
			typeof entry.contentChars === "number" &&
			Number.isFinite(entry.contentChars)
		) {
			item.contentChars = Math.max(0, Math.floor(entry.contentChars));
		}
		const errorCode = optionalString(entry.errorCode, 64);
		if (errorCode) item.errorCode = errorCode;
		const attempts = sanitizeAttempts(entry.attempts);
		if (attempts) item.attempts = attempts;
		items.push(item);
	}
	const num = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v)
			? Math.max(0, Math.floor(v))
			: 0;
	return {
		requestedCount: num(candidate.requestedCount),
		attemptedCount: num(candidate.attemptedCount),
		succeededCount: num(candidate.succeededCount),
		failedCount: num(candidate.failedCount),
		skippedCount: num(candidate.skippedCount),
		durationMs: num(candidate.durationMs),
		items,
	};
}

function sanitizeResults(value: unknown): GatewayRecordResult[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const results: GatewayRecordResult[] = [];
	for (const item of value) {
		if (results.length >= GATEWAY_RECORD_MAX_RESULTS) break;
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (
			typeof candidate.title !== "string" ||
			typeof candidate.url !== "string"
		)
			continue;
		const result: GatewayRecordResult = {
			title: truncate(candidate.title, 160),
			url: truncate(candidate.url, 400),
		};
		if (typeof candidate.rank === "number" && Number.isFinite(candidate.rank)) {
			result.rank = Math.max(1, Math.floor(candidate.rank));
		}
		const snippet = optionalString(candidate.snippet, 600);
		if (snippet) result.snippet = snippet;
		if (
			typeof candidate.contentPreview === "string" &&
			candidate.contentPreview.length > 0
		) {
			const preview = truncatePreview(
				candidate.contentPreview,
				GATEWAY_RECORD_SEARCH_PREVIEW_CHARS,
			);
			result.contentPreview = preview.preview;
			result.contentChars =
				typeof candidate.contentChars === "number" &&
				Number.isFinite(candidate.contentChars)
					? Math.max(preview.chars, Math.floor(candidate.contentChars))
					: preview.chars;
			result.contentTruncated =
				typeof candidate.contentTruncated === "boolean"
					? candidate.contentTruncated || preview.truncated
					: preview.truncated;
		}
		results.push(result);
	}
	return results.length > 0 ? results : undefined;
}

function sanitizeRecord(record: GatewayRequestRecord): GatewayRequestRecord {
	const sanitized: GatewayRequestRecord = {
		id: truncate(record.id, 128),
		at: record.at,
		route: record.route,
		status: record.status,
		durationMs: record.durationMs,
	};
	const code = optionalString(record.code, 64);
	if (code) sanitized.code = code;
	const provider = optionalString(record.provider, 64);
	if (provider) sanitized.provider = provider;
	const query = optionalString(record.query, 200);
	if (query) sanitized.query = query;
	const url = optionalString(record.url, 500);
	if (url) sanitized.url = url;
	if (typeof record.count === "number") sanitized.count = record.count;
	if (typeof record.needContent === "boolean")
		sanitized.needContent = record.needContent;
	const title = optionalString(record.title, 200);
	if (title) sanitized.title = title;
	if (typeof record.resultCount === "number")
		sanitized.resultCount = record.resultCount;
	const results = sanitizeResults(record.results);
	if (results) sanitized.results = results;
	if (
		typeof record.contentPreview === "string" &&
		record.contentPreview.length > 0
	) {
		const preview = truncatePreview(
			record.contentPreview,
			GATEWAY_RECORD_FETCH_PREVIEW_CHARS,
		);
		sanitized.contentPreview = preview.preview;
		sanitized.contentChars =
			typeof record.contentChars === "number" &&
			Number.isFinite(record.contentChars)
				? Math.max(preview.chars, Math.floor(record.contentChars))
				: preview.chars;
		sanitized.contentTruncated =
			typeof record.contentTruncated === "boolean"
				? record.contentTruncated || preview.truncated
				: preview.truncated;
	}
	const attempts = sanitizeAttempts(record.attempts);
	if (attempts) sanitized.attempts = attempts;
	const contentBackfill = sanitizeBackfill(record.contentBackfill);
	if (contentBackfill) sanitized.contentBackfill = contentBackfill;
	return sanitized;
}

function matchesFilter(
	record: GatewayRequestRecord,
	filter: GatewayRecordFilter,
): boolean {
	if (filter.route && record.route !== filter.route) return false;
	if (filter.status === "ok" && (record.status < 200 || record.status >= 300))
		return false;
	if (filter.status === "error" && record.status >= 200 && record.status < 300)
		return false;
	if (filter.provider) {
		const target = filter.provider.toLowerCase();
		const matchedPrimary = record.provider?.toLowerCase() === target;
		const matchedAttempt = record.attempts?.some(
			(attempt) => attempt.provider.toLowerCase() === target,
		);
		const matchedBackfill = record.contentBackfill?.items.some(
			(item) => item.provider?.toLowerCase() === target,
		);
		if (!matchedPrimary && !matchedAttempt && !matchedBackfill) return false;
	}
	if (filter.q) {
		const needle = filter.q.trim().toLowerCase();
		if (needle.length > 0) {
			const haystacks = [
				record.id,
				record.query,
				record.url,
				record.title,
				record.code,
				record.provider,
			];
			const matchedField = haystacks.some(
				(field) =>
					typeof field === "string" && field.toLowerCase().includes(needle),
			);
			const matchedResult = record.results?.some(
				(item) =>
					item.title.toLowerCase().includes(needle) ||
					item.url.toLowerCase().includes(needle) ||
					(item.snippet ? item.snippet.toLowerCase().includes(needle) : false),
			);
			if (!matchedField && !matchedResult) return false;
		}
	}
	return true;
}

export function createGatewayRecordStore(
	retention: number = GATEWAY_RECORD_RETENTION,
): GatewayRecordStore {
	const capacity = Math.max(1, Math.floor(retention));
	const records: GatewayRequestRecord[] = [];
	return {
		get retention() {
			return capacity;
		},
		get size() {
			return records.length;
		},
		add(record) {
			records.push(sanitizeRecord(record));
			if (records.length > capacity)
				records.splice(0, records.length - capacity);
		},
		list(limitOrFilter?: number | GatewayRecordFilter) {
			const filter: GatewayRecordFilter =
				typeof limitOrFilter === "number"
					? { limit: limitOrFilter }
					: (limitOrFilter ?? {});
			const bounded = Math.min(
				Math.max(1, Math.floor(filter.limit ?? capacity)),
				capacity,
			);
			const hasCriteria = Boolean(
				filter.route || filter.status || filter.provider || filter.q?.trim(),
			);
			if (!hasCriteria) {
				return records.slice(-bounded).reverse();
			}
			const matched: GatewayRequestRecord[] = [];
			for (let index = records.length - 1; index >= 0; index--) {
				const item = records[index];
				if (!item) continue;
				if (matchesFilter(item, filter)) {
					matched.push(item);
					if (matched.length >= bounded) break;
				}
			}
			return matched;
		},
		get(id: string) {
			for (let index = records.length - 1; index >= 0; index--) {
				const item = records[index];
				if (item && item.id === id) return item;
			}
			return undefined;
		},
		clear() {
			const cleared = records.length;
			records.length = 0;
			return cleared;
		},
	};
}

function emptyCapabilityStats(): GatewayCapabilityStats {
	return {
		attempts: 0,
		successes: 0,
		failures: 0,
		skipped: 0,
		totalDurationMs: 0,
		avgDurationMs: 0,
		errorCodes: {},
	};
}

function applyAttemptToCapabilityStats(
	stats: GatewayCapabilityStats,
	attempt: GatewayAttemptRecord,
	at: number,
): void {
	if (attempt.status === "skipped") {
		stats.skipped += 1;
		return;
	}
	stats.attempts += 1;
	stats.totalDurationMs += Math.max(0, attempt.durationMs);
	stats.avgDurationMs = Math.round(stats.totalDurationMs / stats.attempts);
	stats.lastUsedAt = at;
	stats.lastStatus = attempt.status;
	if (attempt.status === "ok") {
		stats.successes += 1;
	} else {
		stats.failures += 1;
		const code = attempt.errorCode ?? "unknown";
		stats.lastErrorCode = code;
		stats.errorCodes[code] = (stats.errorCodes[code] ?? 0) + 1;
	}
}

export function createGatewayStatsTracker(
	startedAt: number = Date.now(),
): GatewayStatsTracker {
	let resetAt = startedAt;
	let totalRequests = 0;
	let searchRequests = 0;
	let searchSuccesses = 0;
	let fetchRequests = 0;
	let fetchSuccesses = 0;
	let successCount = 0;
	let errorCount = 0;
	let backfillRequests = 0;
	let backfillItemsSucceeded = 0;
	let backfillItemsFailed = 0;
	const providers = new Map<string, GatewayProviderStats>();

	function ensureProvider(id: string): GatewayProviderStats {
		let entry = providers.get(id);
		if (!entry) {
			entry = {
				search: emptyCapabilityStats(),
				extract: emptyCapabilityStats(),
			};
			providers.set(id, entry);
		}
		return entry;
	}

	return {
		recordRequest(info) {
			totalRequests += 1;
			if (info.route === "search") {
				searchRequests += 1;
				if (info.ok) searchSuccesses += 1;
			} else {
				fetchRequests += 1;
				if (info.ok) fetchSuccesses += 1;
			}
			if (info.ok) {
				successCount += 1;
			} else {
				errorCount += 1;
			}
			const capability: "search" | "extract" =
				info.route === "search" ? "search" : "extract";
			for (const attempt of info.attempts ?? []) {
				const providerStats = ensureProvider(attempt.provider);
				applyAttemptToCapabilityStats(
					providerStats[capability],
					attempt,
					info.at,
				);
			}
			if (info.contentBackfill) {
				backfillRequests += 1;
				backfillItemsSucceeded += info.contentBackfill.succeededCount;
				backfillItemsFailed += info.contentBackfill.failedCount;
				for (const item of info.contentBackfill.items) {
					if (item.attempts && item.attempts.length > 0) {
						for (const attempt of item.attempts) {
							const providerStats = ensureProvider(attempt.provider);
							applyAttemptToCapabilityStats(
								providerStats.extract,
								attempt,
								info.at,
							);
						}
					} else if (
						item.provider &&
						(item.status === "ok" || item.status === "failed")
					) {
						const providerStats = ensureProvider(item.provider);
						applyAttemptToCapabilityStats(
							providerStats.extract,
							{
								provider: item.provider,
								status: item.status,
								durationMs: item.durationMs,
								...(item.errorCode ? { errorCode: item.errorCode } : {}),
							},
							info.at,
						);
					}
				}
			}
		},

		snapshot() {
			const providerOut: Record<string, GatewayProviderStats> = {};
			for (const [id, entry] of providers.entries()) {
				providerOut[id] = {
					search: {
						...entry.search,
						errorCodes: { ...entry.search.errorCodes },
					},
					extract: {
						...entry.extract,
						errorCodes: { ...entry.extract.errorCodes },
					},
				};
			}
			return {
				startedAt,
				resetAt,
				totalRequests,
				searchRequests,
				searchSuccesses,
				fetchRequests,
				fetchSuccesses,
				successCount,
				errorCount,
				backfillRequests,
				backfillItemsSucceeded,
				backfillItemsFailed,
				providers: providerOut,
			};
		},

		reset(now = Date.now()) {
			resetAt = now;
			totalRequests = 0;
			searchRequests = 0;
			searchSuccesses = 0;
			fetchRequests = 0;
			fetchSuccesses = 0;
			successCount = 0;
			errorCount = 0;
			backfillRequests = 0;
			backfillItemsSucceeded = 0;
			backfillItemsFailed = 0;
			providers.clear();
		},
	};
}
