import { type TSchema, Type } from "typebox";
import {
	CAPABILITIES,
	COMMANDS,
	FRESHNESS_VALUES,
	OUTPUT_SCHEMA_VERSION,
	PROVIDER_TYPES,
	SEARCH_FILTER_MODES,
} from "./types.ts";

const literalUnion = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const ProviderTypeSchema = literalUnion(PROVIDER_TYPES);
const NonSearchFilterProviderTypeSchema = literalUnion(
	PROVIDER_TYPES.filter((value) => value !== "anysearch" && value !== "xcrawl"),
);
const SearchFilterProviderTypeSchema = Type.Union([
	Type.Literal("anysearch"),
	Type.Literal("xcrawl"),
]);
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
			type: NonSearchFilterProviderTypeSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...ProviderInstanceFields,
			type: SearchFilterProviderTypeSchema,
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

const CompactErrorInfoSchema = Type.Object({
	code: Type.String(),
	message: Type.String(),
	retryable: Type.Boolean(),
});

const CapabilityAttemptSummarySchema = Type.Object({
	provider: Type.String(),
	code: Type.String(),
	httpStatus: Type.Optional(Type.Integer()),
});

const CapabilityDebugSchema = Type.Object({
	request: Type.Unknown(),
	durationMs: Type.Integer({ minimum: 0 }),
	provider: Type.Optional(ProviderRefSchema),
	attempts: Type.Array(AttemptSchema),
	raw: Type.Optional(Type.Unknown()),
	partial: Type.Optional(
		Type.Object({
			provider: ProviderRefSchema,
			raw: Type.Unknown(),
		}),
	),
});

const SearchSuccessEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(true),
	provider: Type.String(),
	data: Type.Object({ results: Type.Array(SearchHitSchema) }),
	debug: Type.Optional(CapabilityDebugSchema),
});

const ExtractSuccessEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(true),
	provider: Type.String(),
	data: Type.Object({ document: DocumentSchema }),
	debug: Type.Optional(CapabilityDebugSchema),
});

const CapabilityFailureEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(false),
	error: CompactErrorInfoSchema,
	attempts: Type.Optional(Type.Array(CapabilityAttemptSummarySchema)),
	partial: Type.Optional(
		Type.Object({
			provider: Type.String(),
			data: Type.Object({ document: DocumentSchema }),
		}),
	),
	debug: Type.Optional(CapabilityDebugSchema),
});

const DiagnosticSuccessEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(true),
	command: Type.Union([Type.Literal("providers"), Type.Literal("doctor")]),
	durationMs: Type.Integer({ minimum: 0 }),
	data: Type.Unknown(),
});

const ConfigEditSuccessEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(true),
	command: Type.Literal("config.edit"),
	durationMs: Type.Integer({ minimum: 0 }),
	data: Type.Object({
		path: Type.String(),
		created: Type.Boolean(),
		opened: Type.Literal(true),
	}),
});

const FailureEnvelopeSchema = Type.Object({
	schemaVersion: Type.Literal(OUTPUT_SCHEMA_VERSION),
	ok: Type.Literal(false),
	command: Type.Union([
		Type.Literal("providers"),
		Type.Literal("doctor"),
		Type.Literal("config.edit"),
		Type.Null(),
	]),
	durationMs: Type.Integer({ minimum: 0 }),
	error: ErrorInfoSchema,
});

export const OutputEnvelopeSchema: TSchema = Type.Union([
	SearchSuccessEnvelopeSchema,
	ExtractSuccessEnvelopeSchema,
	CapabilityFailureEnvelopeSchema,
	DiagnosticSuccessEnvelopeSchema,
	ConfigEditSuccessEnvelopeSchema,
	FailureEnvelopeSchema,
]);

export const SchemaDocuments = {
	config: AppConfigSchema,
	output: OutputEnvelopeSchema,
	searchRequest: SearchRequestSchema,
	extractRequest: ExtractRequestSchema,
} as const;
