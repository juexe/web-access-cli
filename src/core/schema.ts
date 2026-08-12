import { type TSchema, Type } from "typebox";
import {
	CAPABILITIES,
	COMMANDS,
	FRESHNESS_VALUES,
	PROVIDER_TYPES,
	SEARCH_FILTER_MODES,
} from "./types.ts";

const literalUnion = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const ProviderTypeSchema = literalUnion(PROVIDER_TYPES);
const NonAnySearchProviderTypeSchema = literalUnion(
	PROVIDER_TYPES.filter((value) => value !== "anysearch"),
);
export const CapabilitySchema = literalUnion(CAPABILITIES);
export const CommandSchema = literalUnion(COMMANDS);
export const FreshnessSchema = literalUnion(FRESHNESS_VALUES);
export const SearchFilterModeSchema = literalUnion(SEARCH_FILTER_MODES);

const ProviderInstanceFields = {
	id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
	apiKey: Type.Optional(Type.String()),
	apiKeyEnv: Type.Optional(
		Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
	),
	baseUrl: Type.Optional(Type.String({ format: "uri" })),
	baseUrlEnv: Type.Optional(
		Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
	),
	headers: Type.Optional(
		Type.Record(
			Type.String({ pattern: "^[^\\r\\n]+$" }),
			Type.String({ pattern: "^[^\\r\\n]*$" }),
			{ additionalProperties: false },
		),
	),
};
export const ProviderInstanceConfigSchema = Type.Union([
	Type.Object(
		{
			...ProviderInstanceFields,
			type: NonAnySearchProviderTypeSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...ProviderInstanceFields,
			type: Type.Literal("anysearch"),
			searchFilterMode: Type.Optional(SearchFilterModeSchema),
		},
		{ additionalProperties: false },
	),
]);

export const SearchConfigSchema = Type.Object(
	{
		providers: Type.Optional(
			Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" })),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		attemptTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const ExtractConfigSchema = Type.Object(
	{
		providers: Type.Optional(
			Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" })),
		),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		attemptTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		minContentCharacters: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const AppConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ format: "uri-reference" })),
		providers: Type.Optional(Type.Array(ProviderInstanceConfigSchema)),
		search: Type.Optional(SearchConfigSchema),
		extract: Type.Optional(ExtractConfigSchema),
	},
	{ additionalProperties: false },
);

export const SearchRequestSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	limit: Type.Integer({ minimum: 1, maximum: 20 }),
	freshness: Type.Optional(FreshnessSchema),
	includeDomains: Type.Array(Type.String()),
	excludeDomains: Type.Array(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ExtractRequestSchema = Type.Object({
	url: Type.String({ format: "uri" }),
	provider: Type.String({ minLength: 1 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const ProviderRefSchema = Type.Object({
	id: Type.String(),
	type: ProviderTypeSchema,
});

export const SearchHitSchema = Type.Object({
	rank: Type.Integer({ minimum: 1 }),
	title: Type.String(),
	url: Type.String({ format: "uri" }),
	snippet: Type.String(),
});

export const DocumentSchema = Type.Object({
	sourceUrl: Type.String({ format: "uri" }),
	title: Type.String(),
	content: Type.String(),
	contentType: Type.Literal("text/markdown"),
});

export const ErrorInfoSchema = Type.Object({
	code: Type.String(),
	message: Type.String(),
	retryable: Type.Boolean(),
	provider: Type.Optional(ProviderRefSchema),
	httpStatus: Type.Optional(Type.Integer()),
	details: Type.Optional(Type.Unknown()),
});

export const AttemptSchema = Type.Object({
	provider: ProviderRefSchema,
	status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
	durationMs: Type.Integer({ minimum: 0 }),
	error: Type.Optional(ErrorInfoSchema),
});

export const OutputEnvelopeSchema: TSchema = Type.Object({
	schemaVersion: Type.Literal(1),
	ok: Type.Boolean(),
	command: Type.Union([CommandSchema, Type.Null()]),
	durationMs: Type.Integer({ minimum: 0 }),
	request: Type.Optional(Type.Unknown()),
	provider: Type.Optional(ProviderRefSchema),
	attempts: Type.Optional(Type.Array(AttemptSchema)),
	data: Type.Optional(Type.Unknown()),
	raw: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorInfoSchema),
	partial: Type.Optional(
		Type.Object({
			provider: ProviderRefSchema,
			data: Type.Object({ document: DocumentSchema }),
			raw: Type.Unknown(),
		}),
	),
});

export const SchemaDocuments = {
	config: AppConfigSchema,
	output: OutputEnvelopeSchema,
	searchRequest: SearchRequestSchema,
	extractRequest: ExtractRequestSchema,
} as const;
