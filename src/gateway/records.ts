export const GATEWAY_RECORD_RETENTION = 500;
export const GATEWAY_RECORD_MAX_RESULTS = 5;

export interface GatewayRecordResult {
	title: string;
	url: string;
}

/**
 * One tool request that reached the provider layer. Records live in memory only
 * and never contain response bodies, headers or credentials.
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
}

export interface GatewayRecordStore {
	readonly retention: number;
	readonly size: number;
	add(record: GatewayRequestRecord): void;
	/** Newest first, capped at `limit`. */
	list(limit?: number): GatewayRequestRecord[];
}

function truncate(value: string, max: number): string {
	const characters = Array.from(value);
	if (characters.length <= max) return value;
	return `${characters.slice(0, max).join("")}…`;
}

function optionalString(value: unknown, max: number): string | undefined {
	return typeof value === "string" ? truncate(value, max) : undefined;
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
		results.push({
			title: truncate(candidate.title, 160),
			url: truncate(candidate.url, 400),
		});
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
	return sanitized;
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
		list(limit = capacity) {
			const bounded = Math.min(Math.max(1, Math.floor(limit)), capacity);
			return records.slice(-bounded).reverse();
		},
	};
}
