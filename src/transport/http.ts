import {
	EnvHttpProxyAgent,
	type Headers as UndiciHeaders,
	fetch as undiciFetch,
} from "undici";
import { WebAccessError } from "../core/errors.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"x-subscription-token",
	"x-auth-token",
	"x-access-token",
]);

export interface HttpResponse {
	status: number;
	statusText: string;
	url: string;
	headers: UndiciHeaders;
	body: string;
}

export interface HttpRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal: AbortSignal;
	maxResponseBytes: number;
	maxRedirects?: number;
}

export interface HttpTransport {
	request(
		url: string | URL,
		options: HttpRequestOptions,
	): Promise<HttpResponse>;
}

function isAbortLike(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) return true;
	if (!(error instanceof Error)) return false;
	return (
		error.name === "AbortError" ||
		error.name === "TimeoutError" ||
		/aborted|timed out|timeout/i.test(error.message)
	);
}

function stripSensitiveHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()),
		),
	);
}

function decodeBody(buffer: Uint8Array, headers: UndiciHeaders): string {
	const contentType = headers.get("content-type") ?? "";
	const charset =
		contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

async function readBody(
	response: {
		body: unknown;
		arrayBuffer(): Promise<ArrayBuffer>;
		headers: UndiciHeaders;
	},
	maxBytes: number,
	signal: AbortSignal,
): Promise<string> {
	const reader = (
		response.body as {
			getReader(): {
				read(): Promise<{ done: boolean; value?: Uint8Array }>;
				cancel(): Promise<void>;
				releaseLock(): void;
			};
		} | null
	)?.getReader();
	if (!reader) {
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > maxBytes)
			throw new WebAccessError(
				"response_too_large",
				`响应超过 ${maxBytes} 字节`,
				{ retryable: true },
			);
		return decodeBody(buffer, response.headers);
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			if (signal.aborted) throw new WebAccessError("aborted", "请求已取消");
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new WebAccessError(
					"response_too_large",
					`响应超过 ${maxBytes} 字节`,
					{ retryable: true },
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decodeBody(buffer, response.headers);
}

export function jsonBody(
	text: string,
	provider: string,
): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("响应 JSON 根节点不是对象");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw new WebAccessError(
			"invalid_response",
			`${provider} 返回了无效 JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function buildEndpoint(baseUrl: string, path: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(path.replace(/^\//, ""), base).toString();
}

export class DefaultHttpTransport implements HttpTransport {
	private readonly dispatcher = new EnvHttpProxyAgent();

	async request(
		rawUrl: string | URL,
		options: HttpRequestOptions,
	): Promise<HttpResponse> {
		let current =
			typeof rawUrl === "string" ? new URL(rawUrl) : new URL(rawUrl.toString());
		if (current.protocol !== "http:" && current.protocol !== "https:")
			throw new WebAccessError("invalid_input", "只能请求 HTTP(S) URL");
		let method = (options.method ?? "GET").toUpperCase();
		let body = options.body;
		let headers = { ...(options.headers ?? {}) };
		const maxRedirects = options.maxRedirects ?? 5;

		for (
			let redirectCount = 0;
			redirectCount <= maxRedirects;
			redirectCount++
		) {
			let response: Awaited<ReturnType<typeof undiciFetch>>;
			try {
				response = await undiciFetch(current, {
					method,
					...(body !== undefined ? { body } : {}),
					headers,
					signal: options.signal,
					dispatcher: this.dispatcher,
				} as never);
			} catch (error) {
				if (isAbortLike(error, options.signal)) {
					throw new WebAccessError(
						options.signal.aborted ? "aborted" : "timeout",
						"HTTP 请求超时或已取消",
						{ retryable: options.signal.aborted === false },
					);
				}
				throw new WebAccessError(
					"network_error",
					error instanceof Error ? error.message : String(error),
					{ retryable: true },
				);
			}

			if (!REDIRECT_STATUSES.has(response.status)) {
				const text = await readBody(
					response,
					options.maxResponseBytes,
					options.signal,
				);
				return {
					status: response.status,
					statusText: response.statusText,
					url: response.url || current.toString(),
					headers: response.headers,
					body: text,
				};
			}

			const location = response.headers.get("location");
			if (!location) {
				const text = await readBody(
					response,
					options.maxResponseBytes,
					options.signal,
				);
				return {
					status: response.status,
					statusText: response.statusText,
					url: response.url || current.toString(),
					headers: response.headers,
					body: text,
				};
			}
			await response.body?.cancel();
			if (redirectCount === maxRedirects) {
				throw new WebAccessError(
					"provider_error",
					`重定向次数超过 ${maxRedirects}`,
					{ retryable: true, httpStatus: response.status },
				);
			}
			const next = new URL(location, current);
			if (next.protocol !== "http:" && next.protocol !== "https:")
				throw new WebAccessError(
					"provider_error",
					"重定向目标不是 HTTP(S) URL",
					{ retryable: false },
				);
			if (next.origin !== current.origin)
				headers = stripSensitiveHeaders(headers);
			if (
				response.status === 303 ||
				((response.status === 301 || response.status === 302) &&
					method === "POST")
			) {
				method = "GET";
				body = undefined;
				delete headers["Content-Type"];
				delete headers["content-type"];
			}
			current = next;
		}
		throw new WebAccessError("provider_error", "HTTP 重定向失败", {
			retryable: true,
		});
	}
}

export function createAbortSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export function mergeHeaders(
	...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) result[name] = value;
	}
	return result;
}
