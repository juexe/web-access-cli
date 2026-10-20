# ADR 0019: DeepSeek-Compatible Tool Gateway

- Status: Accepted
- Date: 2026-10-20

## Context

The CLI already owns provider adapters, ordered routes, fallback, deadlines, transport policy and output normalization. Some clients speak the DeepSeek hosted Search/Fetch tool protocol (`POST /v1/tools/search` and `POST /v1/tools/fetch`) and cannot execute a CLI subprocess. The CLI envelope (`schemaVersion`, `provider`, `attempts`, `debug`, `raw`) is also the wrong contract for that protocol.

The gateway must reuse the existing provider, router and transport implementations, keep the CLI contract untouched, and stay deployable as a single trusted-LAN container.

## Decision

**Layering.** `src/gateway/schema.ts` owns an independent TypeBox protocol schema and its types. `src/gateway/service.ts` maps the protocol onto `executeSearch` and `executeExtract` from `src/core/router.ts`. `src/gateway/server.ts` owns HTTP concerns only: authentication, health endpoints and error envelopes. `src/server.ts` is the process entry that loads the configuration snapshot, key file and transport, and owns SIGINT/SIGTERM. The core never imports gateway code, so generated core schemas cannot depend on HTTP.

**Protocol compatibility, not parity.** Request fields, defaults, the success shape and the `{error:{message,type,param,code}}` envelope follow the official contract. `count` accepts 1–50 while the CLI and configuration keep their limit of 20; the shared `SearchRequest.limit` is capped only per adapter outbound value so an early provider's limit never truncates a later fallback. `ori_question` and `localization` are validated and accepted but do not affect provider requests because the neutral core has no equivalent capability. Unknown request fields are ignored, and only known fields are read, so they cannot select a provider, credential, timeout or configuration override.

**Response placeholders.** `summary` reuses `snippet`, `rerank_score` is `0`, `authority` is `-1` and missing site metadata is `null`. The placeholder score is not a DeepSeek quality score; clients filtering on `rerank_score >= 1.5` must change strategy. Result count, ordering, summary quality and content parity with the official engine are explicitly not promised.

**Read-only routing.** The gateway passes a startup configuration snapshot and never provides `persistProviderOrder`, so concurrent requests cannot rewrite shared configuration. Response envelopes from the core are read for `data` and compact failure `attempts` only; `details.lastError` does not exist.

**Content semantics.** `need_content=false` performs no extraction. `need_content=true` schedules every ranked hit with at most two concurrent backfills, a 30-second total window, 10 seconds per item, and a 3-second per-provider attempt cap so fallback still has a turn. Backfilled `content` and complete responses have no size cap: long pages are returned as-is rather than truncated or cleared. Failures, timeouts and unscheduled items leave `content` empty without dropping results.

**Extract preflight.** The gateway derives its own loaded config with `minContentCharacters: 1` so short real pages succeed. The source Markdown preflight stays bounded at one second and keeps a `max(500, original)` threshold, so a short HTTP 200 soft-404 page cannot win. `ExecutionContext.extractPreflight` is an internal, optional, extract-only override; it adds no request field or configuration JSON field, and the CLI without it is unchanged.

**Deadlines and cancellation.** The search and fetch stages use the configured total timeout, and a monotonic per-stage deadline is re-checked after awaits and before write-back because the core success path does not re-check cancellation. The search timer is destroyed once search succeeds and is never the backfill parent signal. Client disconnects cancel the stage and the backfill without scheduling further items.

**Network boundary.** The service binds `127.0.0.1:8080` by default and the LAN deployment binds `192.168.3.3:18180`. It serves trusted-LAN clients only, behind an independent gateway Bearer key stored in a file, compared with a fixed-length digest through `timingSafeEqual`. Private-network URLs are intentionally allowed. No public ingress, CORS, cookie or query-string authentication is added.

**Admission and limits.** Node `http` is used directly. The gateway is a private single-user deployment, so it applies no admission control and no inbound body limits: any number of tool requests may be processed concurrently, request bodies have no byte cap and no read deadline, and the gateway therefore never returns 429 for its own capacity, nor 413/408 for a request body. A JSON object with `application/json` (optionally UTF-8 charset) is still required, compressed request bodies are still rejected, and a 429 now only originates from an upstream provider rate limit. Response JSON is `Cache-Control: no-store`.

**Health.** `GET /healthz` reports process liveness and `GET /readyz` reports configuration/lifecycle readiness. Readiness requires each capability route (primary plus fallback) to contain at least one configured adapter. It does not call paid APIs and cannot be reused as the doctor policy.

**Request records panel.** `GET /` and `GET /panel` serve one self-contained HTML document with a per-response nonce-based CSP and no build assets or third-party scripts. `GET /admin/api/records` returns the most recent authenticated tool requests from an in-memory 500-entry ring buffer, guarded by the same Bearer digest comparison as the tool endpoints. A record stores the search `query` or Fetch URL (truncated), status, duration, error code, final provider, `count`/`need_content`, result count and the first five result titles/URLs, but never response bodies, headers or credentials. Unauthenticated probes are excluded so they cannot flush the buffer; they remain in stderr logs. The panel page itself contains no data, the key stays in the browser's `sessionStorage`, and the buffer is lost on restart. No volume, database, new secret or new configuration key is introduced.

**Panel key bootstrap.** An `#apikey=<key>` fragment logs the panel in directly for bookmark use. Only the fragment is accepted: it is never sent to the server and never appears in `Referer`, and the script removes exactly that parameter from the address bar and history via `history.replaceState` before the first request. Remaining unrelated anchor parameters survive, and query-string authentication is deliberately not supported. A wrong key returns to the login form without persisting anything.

**Lifecycle.** `DefaultHttpTransport` gains `close`/`destroy`; the `HttpTransport` interface still requires only `request`. The entry stops readiness first, waits up to 10 seconds for active responses to drain, then cancels work, closes connections and the dispatcher.

## Consequences

Clients speaking the DeepSeek tool protocol can use the configured providers through one authenticated LAN endpoint, with deterministic error mapping and bounded content backfill cost. The gateway is not a search-quality or ranking substitute: placeholder scores and snippet-reused summaries are protocol compatibility only. Backfill spends extract provider quota, is best-effort, and is capped by several independent time budgets, but not by response size or concurrency. The trusted-LAN assumption is load-bearing; exposing the gateway to untrusted clients requires a separate allowlist/SSRF decision, and would also require reintroducing admission and body limits. The records panel is an operator convenience rather than an audit log: entries are volatile and inherit the sensitivity of queries and target URLs, so anyone holding the gateway key can read them.

## Related

- ADR 0004: transport and network boundary
- ADR 0002: ordered routes and fallback
- ADR 0010: fallback on non-2xx HTTP (its `details.lastError` text is stale)
- ADR 0018: extract source Markdown preflight
