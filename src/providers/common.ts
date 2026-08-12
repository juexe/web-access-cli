import { redactText, WebAccessError } from "../core/errors.ts";
import type {
	ProviderInstance,
	ProviderRef,
	SearchFreshness,
	SearchHit,
} from "../core/types.ts";
import type { HttpResponse } from "../transport/http.ts";

export function ref(instance: ProviderInstance): ProviderRef {
	return { id: instance.id, type: instance.type };
}

export function requireCredential(instance: ProviderInstance): string {
	if (!instance.apiKey)
		throw new WebAccessError(
			"provider_unavailable",
			`${instance.id} 缺少 API key`,
			{ provider: ref(instance) },
		);
	return instance.apiKey;
}

export function requireBaseUrl(instance: ProviderInstance): string {
	if (!instance.baseUrl)
		throw new WebAccessError(
			"provider_unavailable",
			`${instance.id} 缺少 baseUrl`,
			{ provider: ref(instance) },
		);
	return instance.baseUrl;
}

export function classifyHttpFailure(
	response: HttpResponse,
	instance: ProviderInstance,
	secrets: string[] = [],
): WebAccessError {
	const status = response.status;
	const body = redactText(response.body.slice(0, 500), secrets);
	if (status === 401 || status === 403) {
		return new WebAccessError(
			"auth_error",
			`${instance.id} 返回 HTTP ${status}${body ? `: ${body}` : ""}`,
			{
				provider: ref(instance),
				httpStatus: status,
				raw: parseRawBody(response.body),
			},
		);
	}
	if (status === 402) {
		return new WebAccessError(
			"quota_exceeded",
			`${instance.id} 返回 HTTP 402${body ? `: ${body}` : ""}`,
			{
				provider: ref(instance),
				httpStatus: status,
				retryable: true,
				raw: parseRawBody(response.body),
			},
		);
	}
	if (status === 408 || status === 425 || status === 429) {
		return new WebAccessError(
			"rate_limited",
			`${instance.id} 返回 HTTP ${status}${body ? `: ${body}` : ""}`,
			{
				provider: ref(instance),
				httpStatus: status,
				retryable: true,
				raw: parseRawBody(response.body),
			},
		);
	}
	return new WebAccessError(
		status >= 500 ? "provider_error" : "provider_error",
		`${instance.id} 返回 HTTP ${status}${body ? `: ${body}` : ""}`,
		{
			provider: ref(instance),
			httpStatus: status,
			retryable: status >= 500,
			raw: parseRawBody(response.body),
		},
	);
}

export function parseRawBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export function parseJsonResponse(
	response: HttpResponse,
	instance: ProviderInstance,
): Record<string, unknown> {
	if (!response.body.trim())
		throw new WebAccessError("invalid_response", `${instance.id} 返回空响应`, {
			provider: ref(instance),
			httpStatus: response.status,
			raw: response.body,
		});
	try {
		const value: unknown = JSON.parse(response.body);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("JSON 根节点必须是对象");
		return value as Record<string, unknown>;
	} catch (error) {
		throw new WebAccessError(
			"invalid_response",
			`${instance.id} 返回无效 JSON: ${error instanceof Error ? error.message : String(error)}`,
			{
				provider: ref(instance),
				httpStatus: response.status,
				retryable: true,
				raw: response.body,
			},
		);
	}
}

export function assertOk(
	response: HttpResponse,
	instance: ProviderInstance,
): void {
	if (!response.status || response.status < 200 || response.status >= 300)
		throw classifyHttpFailure(
			response,
			instance,
			instance.apiKey ? [instance.apiKey] : [],
		);
}

export function normalizeDomain(raw: string): string {
	let value = raw.trim().toLowerCase();
	if (!value || /\s/.test(value))
		throw new WebAccessError("invalid_input", `域名无效: ${raw}`);
	try {
		value = new URL(
			value.includes("://") ? value : `https://${value}`,
		).hostname.toLowerCase();
	} catch {
		throw new WebAccessError("invalid_input", `域名无效: ${raw}`);
	}
	value = value.replace(/^\.+|\.+$/g, "");
	if (!value || value.includes("/") || value.includes(":"))
		throw new WebAccessError("invalid_input", `域名无效: ${raw}`);
	return value;
}

export function normalizeDomains(values: string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		const domain = normalizeDomain(value);
		if (!result.includes(domain)) result.push(domain);
	}
	return result;
}

export function searchQueryWithDomains(
	query: string,
	includeDomains: string[],
	excludeDomains: string[],
): string {
	const parts = [query];
	if (includeDomains.length === 1) parts.push(`site:${includeDomains[0]}`);
	else if (includeDomains.length > 1)
		parts.push(
			`(${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`,
		);
	for (const domain of excludeDomains) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

export function hostMatches(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return host === domain || host.endsWith(`.${domain}`);
}

export function urlMatchesDomains(
	url: string,
	includeDomains: string[],
	excludeDomains: string[],
): boolean {
	let hostname: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return false;
		hostname = parsed.hostname;
	} catch {
		return false;
	}
	if (
		includeDomains.length > 0 &&
		!includeDomains.some((domain) => hostMatches(hostname, domain))
	)
		return false;
	return !excludeDomains.some((domain) => hostMatches(hostname, domain));
}

export function normalizeHits(
	items: unknown,
	limit: number,
	includeDomains: string[],
	excludeDomains: string[],
): SearchHit[] {
	if (!Array.isArray(items)) return [];
	const seen = new Set<string>();
	const result: SearchHit[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const raw = item as Record<string, unknown>;
		if (
			typeof raw.url !== "string" ||
			!urlMatchesDomains(raw.url, includeDomains, excludeDomains)
		)
			continue;
		let url: string;
		try {
			const parsed = new URL(raw.url);
			parsed.hash = "";
			url = parsed.toString();
		} catch {
			continue;
		}
		if (seen.has(url)) continue;
		seen.add(url);
		const title =
			typeof raw.title === "string" && raw.title.trim()
				? raw.title.trim()
				: url;
		const snippet =
			typeof raw.snippet === "string"
				? raw.snippet
				: typeof raw.description === "string"
					? raw.description
					: typeof raw.content === "string"
						? raw.content
						: typeof raw.text === "string"
							? raw.text
							: Array.isArray(raw.highlights)
								? raw.highlights
										.filter(
											(value): value is string => typeof value === "string",
										)
										.join(" ")
								: "";
		result.push({
			rank: result.length + 1,
			title,
			url,
			snippet: snippet.replace(/\s+/g, " ").trim(),
		});
		if (result.length >= limit) break;
	}
	return result;
}

export function freshnessStartDate(
	value: SearchFreshness,
	now = new Date(),
): string {
	const date = new Date(now);
	if (value === "day") date.setUTCDate(date.getUTCDate() - 1);
	if (value === "month") date.setUTCMonth(date.getUTCMonth() - 1);
	if (value === "year") date.setUTCFullYear(date.getUTCFullYear() - 1);
	return date.toISOString().slice(0, 10);
}

export function providerHeaders(
	instance: ProviderInstance,
	generated: Record<string, string>,
): Record<string, string> {
	return { ...generated, ...instance.headers };
}

export function providerHeadersWithCredential(
	instance: ProviderInstance,
	generated: Record<string, string>,
): Record<string, string> {
	const headers = providerHeaders(instance, generated);
	if (instance.apiKey) {
		if (instance.type === "brave")
			headers["X-Subscription-Token"] = instance.apiKey;
		else headers.Authorization = `Bearer ${instance.apiKey}`;
	}
	return headers;
}
