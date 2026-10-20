import { isIP } from "node:net";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const GATEWAY_SEARCH_MAX_COUNT = 50;
export const GATEWAY_SEARCH_DEFAULT_COUNT = 10;
export const GATEWAY_QUERY_MAX_CHARACTERS = 128;
export const GATEWAY_URL_MAX_CHARACTERS = 8192;

/**
 * Unknown request fields are ignored, matching the official API contract. Only
 * known fields are read below, so unknown keys cannot select a provider,
 * credential, timeout, or configuration override.
 */
export const GatewaySearchRequestSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: GATEWAY_QUERY_MAX_CHARACTERS,
		pattern: "\\S",
	}),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: GATEWAY_SEARCH_MAX_COUNT }),
	),
	ori_question: Type.Optional(
		Type.Union([
			Type.String({ minLength: 1, maxLength: GATEWAY_QUERY_MAX_CHARACTERS }),
			Type.Null(),
		]),
	),
	localization: Type.Optional(Type.String()),
	need_content: Type.Optional(Type.Boolean()),
});

export const GatewayFetchRequestSchema = Type.Object({
	url: Type.String({ minLength: 1, maxLength: GATEWAY_URL_MAX_CHARACTERS }),
});

const GatewaySearchResultSchema = Type.Object(
	{
		rerank_score: Type.Number(),
		title: Type.String(),
		url: Type.String(),
		snippet: Type.String(),
		summary: Type.String(),
		content: Type.String(),
		site_name: Type.Union([Type.String(), Type.Null()]),
		site_icon: Type.Union([Type.String(), Type.Null()]),
		date: Type.Union([Type.String(), Type.Null()]),
		authority: Type.Number(),
	},
	{ additionalProperties: false },
);

export const GatewaySearchResponseSchema = Type.Object(
	{ results: Type.Array(GatewaySearchResultSchema) },
	{ additionalProperties: false },
);

export const GatewayFetchResponseSchema = Type.Object(
	{ title: Type.String(), content: Type.String() },
	{ additionalProperties: false },
);

export const GatewayErrorSchema = Type.Object(
	{
		error: Type.Object(
			{
				message: Type.String(),
				type: Type.String(),
				param: Type.Null(),
				code: Type.String(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const GatewaySchemaDocuments = {
	gatewaySearchRequest: GatewaySearchRequestSchema,
	gatewaySearchResponse: GatewaySearchResponseSchema,
	gatewayFetchRequest: GatewayFetchRequestSchema,
	gatewayFetchResponse: GatewayFetchResponseSchema,
	gatewayError: GatewayErrorSchema,
} as const;

export type GatewaySearchRequest = {
	query: string;
	count: number;
	ori_question: string | null;
	localization: string;
	need_content: boolean;
};

export type GatewayFetchRequest = {
	url: string;
};

export type GatewaySearchResult = Static<typeof GatewaySearchResultSchema>;
export type GatewaySearchResponse = Static<typeof GatewaySearchResponseSchema>;
export type GatewayFetchResponse = Static<typeof GatewayFetchResponseSchema>;
export type GatewayErrorEnvelope = Static<typeof GatewayErrorSchema>;

/** A fixed, non-leaking validation failure. */
export class GatewayValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayValidationError";
	}
}

function invalid(message: string): never {
	throw new GatewayValidationError(message);
}

export function parseGatewaySearchRequest(
	value: unknown,
): GatewaySearchRequest {
	if (!Check(GatewaySearchRequestSchema, value))
		invalid(
			"请求体不符合 Search API：query 必须为 1–128 个非空白字符，count 必须为 1–50 的整数，ori_question 必须为 1–128 个字符或 null，localization 必须为字符串，need_content 必须为布尔值",
		);
	const request = value as {
		query: string;
		count?: number;
		ori_question?: string | null;
		localization?: string;
		need_content?: boolean;
	};
	const localization = request.localization ?? "";
	if (localization !== "" && isIP(localization) === 0)
		invalid("localization 必须为 IP 地址或空字符串");
	return {
		query: request.query,
		count: request.count ?? GATEWAY_SEARCH_DEFAULT_COUNT,
		ori_question: request.ori_question ?? null,
		localization,
		need_content: request.need_content ?? false,
	};
}

export function parseGatewayFetchRequest(value: unknown): GatewayFetchRequest {
	if (!Check(GatewayFetchRequestSchema, value))
		invalid("请求体不符合 Fetch API：url 必须为 1–8192 个字符的字符串");
	return { url: parseGatewayFetchUrl((value as { url: string }).url) };
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function parseGatewayFetchUrl(raw: string): string {
	if (hasControlCharacters(raw)) invalid("url 不能包含控制字符");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		invalid("url 必须是合法的绝对 URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		invalid("url 必须使用 http 或 https");
	if (!url.hostname) invalid("url 必须包含主机名");
	if (url.username || url.password) invalid("url 不能包含用户名或密码");
	return url.toString();
}
