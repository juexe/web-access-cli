import { Headers } from "undici";
import type { ProviderInstance } from "../src/core/types.ts";
import type {
	HttpRequestOptions,
	HttpResponse,
	HttpTransport,
} from "../src/transport/http.ts";

export interface RecordedRequest {
	url: string;
	options: HttpRequestOptions;
}

export class MockTransport implements HttpTransport {
	readonly calls: RecordedRequest[] = [];

	constructor(
		private readonly handler: (
			url: string,
			options: HttpRequestOptions,
		) => HttpResponse | Promise<HttpResponse>,
	) {}

	request(
		url: string | URL,
		options: HttpRequestOptions,
	): Promise<HttpResponse> {
		const normalized = url.toString();
		this.calls.push({ url: normalized, options });
		return Promise.resolve(this.handler(normalized, options));
	}
}

export function response(
	body: unknown,
	options: { status?: number; contentType?: string; url?: string } = {},
): HttpResponse {
	return {
		status: options.status ?? 200,
		statusText: options.status && options.status >= 400 ? "Error" : "OK",
		url: options.url ?? "https://provider.test/result",
		headers: new Headers({
			"content-type": options.contentType ?? "application/json; charset=utf-8",
		}),
		body: typeof body === "string" ? body : JSON.stringify(body),
	};
}

export function instance(
	type: ProviderInstance["type"],
	overrides: Partial<ProviderInstance> = {},
): ProviderInstance {
	return {
		id: type,
		type,
		apiKey: "test-key",
		credentialSource: "config",
		baseUrl: `https://${type}.test`,
		baseUrlSource: "config",
		headers: {},
		...overrides,
	};
}
