export const PROVIDER_TYPES = [
	"tavily",
	"exa",
	"brave",
	"searxng",
	"firecrawl",
	"jina",
	"http",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const CAPABILITIES = ["search", "extract"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const COMMANDS = ["search", "extract", "providers", "doctor"] as const;
export type Command = (typeof COMMANDS)[number];

export const FRESHNESS_VALUES = ["day", "month", "year"] as const;
export type SearchFreshness = (typeof FRESHNESS_VALUES)[number];

export interface ProviderInstanceConfig {
	id: string;
	type: ProviderType;
	apiKey?: string;
	apiKeyEnv?: string;
	baseUrl?: string;
	baseUrlEnv?: string;
	headers?: Record<string, string>;
}

export interface RouteConfig {
	providers: string[];
}

export interface SearchConfig {
	providers: string[];
	limit: number;
	timeoutMs: number;
	attemptTimeoutMs: number;
	maxResponseBytes: number;
}

export interface ExtractConfig {
	providers: string[];
	timeoutMs: number;
	attemptTimeoutMs: number;
	maxResponseBytes: number;
	minContentCharacters: number;
}

export interface AppConfig {
	providers: ProviderInstanceConfig[];
	search: SearchConfig;
	extract: ExtractConfig;
}

export type CredentialSource =
	| "standard_env"
	| "custom_env"
	| "config"
	| "missing";

export interface ProviderInstance {
	id: string;
	type: ProviderType;
	apiKey: string | null;
	credentialSource: CredentialSource;
	baseUrl: string | null;
	baseUrlSource:
		| "standard_env"
		| "custom_env"
		| "config"
		| "default"
		| "missing";
	headers: Record<string, string>;
}

export interface ProviderRef {
	id: string;
	type: ProviderType;
}

export interface SearchRequest {
	query: string;
	provider: string;
	limit: number;
	freshness?: SearchFreshness;
	includeDomains: string[];
	excludeDomains: string[];
	timeoutMs?: number;
}

export interface ExtractRequest {
	url: string;
	provider: string;
	timeoutMs?: number;
}

export interface SearchHit {
	rank: number;
	title: string;
	url: string;
	snippet: string;
}

export interface SearchData {
	results: SearchHit[];
}

export interface Document {
	sourceUrl: string;
	title: string;
	content: string;
	contentType: "text/markdown";
}

export interface ExtractData {
	document: Document;
}

export type ErrorCode =
	| "invalid_input"
	| "config_error"
	| "provider_unknown"
	| "provider_disabled"
	| "provider_unavailable"
	| "auth_error"
	| "rate_limited"
	| "quota_exceeded"
	| "timeout"
	| "network_error"
	| "provider_error"
	| "invalid_response"
	| "response_too_large"
	| "unsupported_content"
	| "no_usable_content"
	| "provider_exhausted"
	| "aborted"
	| "doctor_failed"
	| "internal_error";

export interface ErrorInfo {
	code: ErrorCode;
	message: string;
	retryable: boolean;
	provider?: ProviderRef;
	httpStatus?: number;
	details?: unknown;
}

export type AttemptStatus = "success" | "failed";

export interface ProviderAttempt {
	provider: ProviderRef;
	status: AttemptStatus;
	durationMs: number;
	error?: ErrorInfo;
}

export interface BaseEnvelope {
	schemaVersion: 1;
	ok: boolean;
	command: Command | null;
	durationMs: number;
	request?: unknown;
	attempts?: ProviderAttempt[];
	error?: ErrorInfo;
	partial?: {
		provider: ProviderRef;
		data: ExtractData;
		raw: unknown;
	};
}

export interface SearchSuccessEnvelope extends BaseEnvelope {
	ok: true;
	command: "search";
	request: SearchRequest;
	provider: ProviderRef;
	attempts: ProviderAttempt[];
	data: SearchData;
	raw: unknown;
}

export interface ExtractSuccessEnvelope extends BaseEnvelope {
	ok: true;
	command: "extract";
	request: ExtractRequest;
	provider: ProviderRef;
	attempts: ProviderAttempt[];
	data: ExtractData;
	raw: unknown;
}

export interface FailureEnvelope extends BaseEnvelope {
	ok: false;
	error: ErrorInfo;
	attempts?: ProviderAttempt[];
	raw?: unknown;
}

export interface DiagnosticSuccessEnvelope extends BaseEnvelope {
	ok: true;
	command: "providers" | "doctor";
	data: unknown;
}

export type OutputEnvelope =
	| SearchSuccessEnvelope
	| ExtractSuccessEnvelope
	| DiagnosticSuccessEnvelope
	| FailureEnvelope;

export interface ProviderExecution<T> {
	data: T;
	raw: unknown;
}

export interface SearchAdapterRequest {
	query: string;
	limit: number;
	freshness?: SearchFreshness;
	includeDomains: string[];
	excludeDomains: string[];
	signal: AbortSignal;
	maxResponseBytes: number;
	instance: ProviderInstance;
	transport: import("../transport/http.ts").HttpTransport;
}

export interface ExtractAdapterRequest {
	url: string;
	signal: AbortSignal;
	maxResponseBytes: number;
	minContentCharacters: number;
	instance: ProviderInstance;
	transport: import("../transport/http.ts").HttpTransport;
}

export interface ProviderAdapter {
	type: ProviderType;
	capabilities: Capability[];
	isConfigured(instance: ProviderInstance): boolean;
	search?(
		request: SearchAdapterRequest,
	): Promise<ProviderExecution<SearchData>>;
	extract?(
		request: ExtractAdapterRequest,
	): Promise<ProviderExecution<ExtractData>>;
}
