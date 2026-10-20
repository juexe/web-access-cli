import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebAccessError } from "../core/errors.ts";
import type {
	ProviderAdapter,
	ProviderExecution,
	SearchAdapterRequest,
	SearchData,
} from "../core/types.ts";
import { buildEndpoint } from "../transport/http.ts";
import { VERSION } from "../version.ts";
import {
	assertOk,
	freshnessStartDate,
	normalizeHits,
	parseJsonResponse,
	ref,
	requireBaseUrl,
} from "./common.ts";

const XAI_TYPES = new Set(["xai_x_search", "xai_web_search"]);
const PROTECTED_HEADERS = new Set([
	"authorization",
	"content-type",
	"accept",
	"x-xai-token-auth",
	"x-grok-client-version",
	"x-grok-client-identifier",
	"x-grok-client-mode",
	"x-grok-model-override",
	"x-authenticateresponse",
	"user-agent",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function redact(value: unknown, secrets: string[]): unknown {
	if (typeof value === "string") {
		return secrets.reduce(
			(text, secret) =>
				secret.length >= 4 ? text.split(secret).join("[REDACTED]") : text,
			value,
		);
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
	);
}

function authError(
	request: SearchAdapterRequest,
	message: string,
	secrets: string[] = [],
): WebAccessError {
	return new WebAccessError("auth_error", message, {
		provider: ref(request.instance),
		retryable: false,
		raw: redact({ path: request.instance.authJson }, secrets),
	});
}

function readAccessToken(request: SearchAdapterRequest): string {
	const authPath = request.instance.authJson;
	if (!authPath) throw authError(request, "xAI OAuth authJson 未配置");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolve(authPath), "utf8"));
	} catch {
		throw authError(request, "xAI OAuth authJson 无法读取或解析");
	}
	if (!isRecord(parsed) || parsed.disabled === true)
		throw authError(request, "xAI OAuth 凭据已禁用");
	const token = parsed.access_token;
	if (typeof token !== "string" || token.trim() === "")
		throw authError(request, "xAI OAuth authJson 缺少 access_token");
	return token;
}

function snippet(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number") return "";
	const value = text
		.slice(Math.max(0, start - 120), Math.min(text.length, end + 120))
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

function mapResponse(
	parsed: Record<string, unknown>,
	request: SearchAdapterRequest,
): SearchData {
	const output = Array.isArray(parsed.output)
		? parsed.output.filter(isRecord)
		: [];
	const expectedCall =
		request.instance.type === "xai_x_search"
			? "custom_tool_call"
			: "web_search_call";
	if (!output.some((item) => item.type === expectedCall))
		throw new WebAccessError(
			"provider_error",
			`xAI ${request.instance.type} 未返回搜索工具调用`,
			{ provider: ref(request.instance), retryable: true, raw: parsed },
		);

	const items: Array<{ title?: string; url: string; snippet: string }> = [];
	for (const item of output) {
		if (item.type === "message" && Array.isArray(item.content)) {
			for (const block of item.content.filter(isRecord)) {
				const annotations = Array.isArray(block.annotations)
					? block.annotations.filter(isRecord)
					: [];
				for (const annotation of annotations) {
					if (
						annotation.type !== "url_citation" ||
						typeof annotation.url !== "string"
					)
						continue;
					items.push({
						url: annotation.url,
						...(typeof annotation.title === "string"
							? { title: annotation.title }
							: {}),
						snippet: snippet(
							typeof block.text === "string" ? block.text : "",
							annotation.start_index,
							annotation.end_index,
						),
					});
				}
			}
		}
	}
	for (const item of output) {
		if (
			request.instance.type === "xai_web_search" &&
			item.type === "web_search_call"
		) {
			const sources =
				isRecord(item.action) && Array.isArray(item.action.sources)
					? item.action.sources.filter(isRecord)
					: [];
			for (const source of sources) {
				if (typeof source.url !== "string") continue;
				items.push({
					url: source.url,
					...(typeof source.title === "string" ? { title: source.title } : {}),
					snippet: "",
				});
			}
		}
	}
	return {
		results: normalizeHits(
			items,
			request.limit,
			request.includeDomains,
			request.excludeDomains,
		),
	};
}

function requestHeaders(
	request: SearchAdapterRequest,
	token: string,
	model: string,
): Record<string, string> {
	const headers = Object.fromEntries(
		Object.entries(request.instance.headers).filter(
			([name]) => !PROTECTED_HEADERS.has(name.toLowerCase()),
		),
	);
	return {
		...headers,
		Authorization: `Bearer ${token}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-version": "1.0.60",
		"x-grok-client-identifier": "grok-shell",
		"x-grok-client-mode": "headless",
		"x-grok-model-override": model,
		"x-authenticateresponse": "authenticate-response",
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": `web-access-cli/${VERSION}`,
	};
}

function createAdapter(
	type: "xai_x_search" | "xai_web_search",
): ProviderAdapter {
	return {
		type,
		capabilities: ["search"],
		isConfigured: (instance) =>
			XAI_TYPES.has(instance.type) &&
			!!instance.baseUrl &&
			!!instance.authJson &&
			existsSync(resolve(instance.authJson)),
		async search(request): Promise<ProviderExecution<SearchData>> {
			if (
				type === "xai_web_search" &&
				request.includeDomains.length > 0 &&
				request.excludeDomains.length > 0
			)
				throw new WebAccessError(
					"provider_unavailable",
					"xAI web_search 不能同时设置 include-domain 和 exclude-domain",
					{ provider: ref(request.instance), retryable: true },
				);
			if (
				type === "xai_web_search" &&
				(request.includeDomains.length > 5 || request.excludeDomains.length > 5)
			)
				throw new WebAccessError(
					"provider_unavailable",
					"xAI web_search 每次最多支持 5 个域名",
					{ provider: ref(request.instance), retryable: true },
				);
			const token = readAccessToken(request);
			const model = request.instance.model ?? "grok-4.6";
			const tool =
				type === "xai_x_search"
					? {
							type: "x_search",
							...(request.freshness
								? { from_date: freshnessStartDate(request.freshness) }
								: {}),
						}
					: {
							type: "web_search",
							...(request.includeDomains.length > 0 ||
							request.excludeDomains.length > 0
								? {
										filters: {
											...(request.includeDomains.length > 0
												? {
														allowed_domains: request.includeDomains.slice(0, 5),
													}
												: {}),
											...(request.excludeDomains.length > 0
												? {
														excluded_domains: request.excludeDomains.slice(
															0,
															5,
														),
													}
												: {}),
										},
									}
								: {}),
						};
			const response = await request.transport.request(
				buildEndpoint(requireBaseUrl(request.instance), "responses"),
				{
					method: "POST",
					headers: requestHeaders(request, token, model),
					body: JSON.stringify({
						model,
						input: `Search the web for: ${request.query}`,
						tools: [tool],
					}),
					signal: request.signal,
					maxResponseBytes: request.maxResponseBytes,
					maxRedirects: 0,
				},
			);
			try {
				assertOk(response, request.instance);
				const parsed = parseJsonResponse(response, request.instance);
				return {
					data: mapResponse(parsed, request),
					raw: redact(parsed, [token]),
				};
			} catch (error) {
				if (!(error instanceof WebAccessError)) throw error;
				throw new WebAccessError(error.code, error.message, {
					retryable: error.retryable,
					provider: error.provider,
					httpStatus: error.httpStatus,
					details: redact(error.details, [token]),
					raw: redact(error.raw, [token]),
				});
			}
		},
	};
}

export const XAI_X_SEARCH_ADAPTER = createAdapter("xai_x_search");
export const XAI_WEB_SEARCH_ADAPTER = createAdapter("xai_web_search");
