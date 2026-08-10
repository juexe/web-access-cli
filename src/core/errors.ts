import type { ErrorCode, ErrorInfo, ProviderRef } from "./types.ts";

export class WebAccessError extends Error {
	readonly code: ErrorCode;
	readonly retryable: boolean;
	readonly provider?: ProviderRef;
	readonly httpStatus?: number;
	readonly details?: unknown;
	readonly raw?: unknown;

	constructor(
		code: ErrorCode,
		message: string,
		options: {
			retryable?: boolean;
			provider?: ProviderRef;
			httpStatus?: number;
			details?: unknown;
			raw?: unknown;
		} = {},
	) {
		super(message);
		this.name = "WebAccessError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.provider = options.provider;
		this.httpStatus = options.httpStatus;
		this.details = options.details;
		this.raw = options.raw;
	}

	toInfo(): ErrorInfo {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.provider ? { provider: this.provider } : {}),
			...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
			...(this.details !== undefined ? { details: this.details } : {}),
		};
	}
}

export function asWebAccessError(
	error: unknown,
	fallbackCode: ErrorCode = "internal_error",
): WebAccessError {
	if (error instanceof WebAccessError) return error;
	if (error instanceof DOMException && error.name === "AbortError") {
		return new WebAccessError("aborted", "请求已取消");
	}
	const message = error instanceof Error ? error.message : String(error);
	return new WebAccessError(fallbackCode, message);
}

export function redactText(
	text: string,
	secrets: Iterable<string | null | undefined>,
): string {
	let result = text;
	for (const secret of secrets) {
		if (!secret || secret.length < 4) continue;
		result = result.split(secret).join("[REDACTED]");
	}
	return result;
}
