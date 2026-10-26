# web-access-cli

English | [简体中文](README_CN.md)

[![CI](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Two entry points over one core: a **CLI** for direct invocation and a **DeepSeek-compatible HTTP gateway** for long-running agent runtimes. Both expose the same two capabilities — search and content extraction — and normalize Tavily, Exa, Bocha, Yuanbao Search, Brave, SearXNG, AnySearch, XCrawl, DeepSeek, Firecrawl, Jina, and others behind one schema.

Neither entry point is tied to Pi, Claude Code, Codex, Cursor, OpenCode, or any other agent. Skills, MCP integrations, and agent plugins are adapters on top; they never enter the core. Requires Node.js 22.19+.

## Capabilities

| Capability | Provider types | Normalized output |
| --- | --- | --- |
| `search` | Tavily, Exa, Bocha, Yuanbao Search, Brave, SearXNG, AnySearch, XCrawl, DeepSeek, xAI x_search, xAI web_search | `rank`, `title`, `url`, `snippet` |
| `extract` | Firecrawl v2, Jina Reader, Exa Contents, AnySearch, XCrawl, DeepSeek Fetch, HTTP | Markdown `Document` |

A provider type is an implementation; a provider instance is a configured instance of that type, so `exa_team` and `exa_personal` can coexist. Each capability has a primary `providers` route and a `providers_fallback` route; both define the enabled instances and their `auto` order.

## Install

```sh
npm install --global web-access-cli    # or: pnpm add --global web-access-cli
web-access --help
```

From a checkout: `pnpm install --frozen-lockfile && pnpm check`. The gateway runs from the same checkout (`node --import tsx src/server.ts`) or built output (`pnpm start:gateway`); production deployment uses the GHCR image, whose Compose template and secret conventions are in [deploy/README.md](deploy/README.md).

Layout: `src/cli.ts` and `src/server.ts` are the two entries, `src/gateway/` holds the tool protocol, and `src/core/`, `src/providers/`, `src/transport/` are shared by both. Adapters map protocols only; fallback, deadlines, envelopes, and exit codes live in `src/core`.

## CLI

```sh
web-access search "TypeScript release" --provider exa --limit 10 --freshness month
web-access search "browser automation" --include-domain example.com --exclude-domain blocked.example.com
web-access extract https://example.com/article --provider http --timeout 30000
web-access extract https://example.com/article --json

web-access providers          # route, capability, credential and URL status
web-access doctor             # local configuration checks, no network
web-access config init        # scaffold from credential env vars
web-access config edit        # open in $VISUAL/$EDITOR
```

Global options: `--config <path>`, `--json`, `--help`, `--version`. Capability commands print human-readable Markdown, `config init` prints the created path, and every failure prints one JSON envelope. Exit codes: `0` success, `2` invalid input/config or a disabled provider, `1` runtime or doctor failure, `130` cancelled.

Not provided: batch/all, answer, a PDF-only path, a Node SDK, or generic MCP. An optional [Agent Skill](skills/web-access-cli/SKILL.md) exists for source checkouts and is not published to npm.

## HTTP gateway

A long-running process that serves the same providers, routing and transport over DeepSeek's [Search and Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search): same endpoints, auth header, request fields and error envelope, so a client written for the official service only changes its base URL. It changes nothing about the CLI contract.

Run it as a Docker image — `ghcr.io/juexe/web-access-cli`, multi-arch `linux/amd64` and `linux/arm64`, published on every GitHub Release with exact version tags plus `latest` for stable releases. Deployment needs Docker only, no Node.js or pnpm:

```sh
docker pull ghcr.io/juexe/web-access-cli:0.7.0
docker compose -f deploy/compose.yaml --env-file personal/deploy.env up -d --wait gateway
```

Or from source; it listens on `127.0.0.1:8080` by default:

```sh
# Source
WEB_ACCESS_CONFIG=~/.config/web-access-cli/config.json \
WEB_ACCESS_GATEWAY_API_KEY_FILE=/path/to/gateway-api-key \
node --import tsx src/server.ts
```

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/tools/search` | DeepSeek Search compatible |
| `POST` | `/v1/tools/fetch` | DeepSeek Fetch compatible |
| `GET` | `/healthz`, `/readyz` | Liveness and configuration readiness, no auth |
| `GET` | `/panel` | Admin UI shell, no auth and no data |
| `GET`/`DELETE` | `/admin/api/records` | Request records, Bearer key required |
| `GET` | `/admin/api/overview` | Runtime stats, route readiness, per-instance counters |
| `PUT` | `/admin/api/config` | Patch routes, budgets, instances; hot-applies and persists |
| `POST` | `/admin/api/config/reload` | Reload the config file from disk |

- The Bearer key is read from a file only, compared as a fixed-length digest, and duplicate `Authorization` headers are rejected. Requests are single-user private, so the gateway adds no local admission, body size limit, or body read deadline and never returns 413 or 408 itself. Responses use `Cache-Control: no-store`.
- Search fields: `query` (1–128 characters), `count` (1–50, default 10), `ori_question` (1–128 when set), `localization` (an IP address when non-empty), `need_content` (boolean, default `false`). Fetch takes one absolute HTTP(S) URL of at most 8192 characters. Unknown fields are ignored and cannot override provider, credentials, timeout, or configuration.
- Responses are protocol-compatible, not equal to the official engine: `summary` reuses `snippet`, `rerank_score` is always `0`, `authority` is always `-1`, and `site_name`/`site_icon`/`date` are `null`. Clients filtering on score or authority must change strategy, and no result count, ranking, or quality is promised.
- `ori_question` and `localization` are validated but have no core equivalent, so they never reach providers.
- `need_content=true` backfills by rank with two concurrent tasks, a 30-second window, 10 seconds per item, and a 3-second attempt cap; failures keep the result with empty content. Backfill and responses have no size cap, and **backfill spends extract quota**. Fetch and backfill derive their own config with a 1-character minimum so short pages succeed, while the source Markdown probe still requires 500 characters. Client disconnects cancel in-flight work.
- Errors are always `{ "error": { "message", "type": "…", "param": null, "code" } }`: 400 `invalid_request_error`, 401 `invalid_api_key`, 402 `insufficient_quota`, 404 `no_usable_content` or an unknown route, 405 wrong method, 503 while shutting down, 504 `upstream_timeout`, and 500 for provider, credential, or configuration failures. 429 only ever means the upstream provider rate-limited.
- Tool requests never rewrite provider order: concurrent traffic does not trigger config write-back. The panel's config workspace and `/admin/api/config*` are the only writers, and they hot-apply plus persist atomically (with a read-only fallback when the file is mounted as a secret).
- The panel keeps the last 500 requests in memory: status, duration, error, provider, query/URL, attempt chain, snippets, and truncated content previews (2 000 chars for search results, 4 000 for Fetch) — never full bodies, headers, or credentials. A `#apikey=<key>` fragment logs in, is stripped from the address bar, and stores the key in `sessionStorage`.

### Use it from DSH

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) ships `@deepseek-ai/dsh-web-deepseek-api`, a provider that speaks exactly this API, so pointing `web_search` and `web_fetch` here needs no extra plugin — only a base URL. In `~/.dsh/cordis.patch.yml`:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: deepseek-search-api
    fetchProvider: deepseek-fetch-api
- id: web-deepseek-api
  name: "@deepseek-ai/dsh-web-deepseek-api"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY       # must hold the gateway key, not a DeepSeek key
    baseURL: http://127.0.0.1:8080/v1/tools
```

`baseURL` is the full base including the path prefix and excluding `/search` or `/fetch`; the default `apiKeyEnv` is `DEEPSEEK_API_KEY`, so point it at a variable holding the gateway key. `web_search` and `web_fetch` then hit this gateway with no other change — only the placeholder score/authority fields differ, as noted above. Because the gateway is private, keep it on a trusted network rather than exposing it publicly.

Deployment, secrets, upgrades and rollback: [deploy/README.md](deploy/README.md). Decision record: [ADR 0019](docs/adr/0019-deepseek-tool-gateway.md).

## Configuration

Strict JSON; unknown fields are rejected. Resolution order is `--config`, then `WEB_ACCESS_CONFIG`, then `~/.config/web-access-cli/config.json`. A missing default file falls back to built-in defaults; a missing explicit file is a `config_error`. No parent directories are scanned.

`config edit` creates a full default file when absent and opens it with `VISUAL`, else `EDITOR`, without shell evaluation or reformatting; `config init` scaffolds from standard credential environment variables and refuses to overwrite. Environment variables override plaintext keys. The full schema is [schemas/config.schema.json](schemas/config.schema.json):

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.7.0/schemas/config.schema.json",
  "providers": [
    { "id": "exa_team", "type": "exa", "apiKeyEnv": "TEAM_EXA_API_KEY" },
    { "id": "firecrawl_local", "type": "firecrawl", "baseUrl": "http://127.0.0.1:3002" }
  ],
  "search": { "providers": ["exa_team"], "providers_fallback": ["brave"] },
  "extract": { "providers": ["firecrawl_local"], "providers_fallback": ["http"] }
}
```

Built-in instances: `tavily`, `exa`, `bocha`, `yuanbao`, `brave`, `searxng`, `anysearch`, `xcrawl`, `deepseek`, `firecrawl`, `jina`, `http`, `xai_x_search`, `xai_web_search`. Reusing a built-in ID overrides that instance; a new ID adds another of the same type. An instance is enabled only when listed in a route. Default routes:

- Search: `tavily -> exa -> bocha -> yuanbao -> brave -> searxng -> anysearch -> xcrawl -> deepseek`, fallback `xai_x_search -> xai_web_search`
- Extract: `firecrawl -> jina -> exa -> anysearch -> xcrawl -> deepseek`, fallback `http`

An explicit empty Search primary route is invalid; Extract can be disabled with an empty primary route. AnySearch and XCrawl take `searchFilterMode`: `strict` (skip on freshness) or `best_effort` (rewrite freshness into the query). Yuanbao posts `Query`/`Site`/`Freshness` to `/SearchPro` and keeps in-body errors fallback-eligible. DeepSeek uses `/v1/tools/search` and `/v1/tools/fetch`, rewriting freshness and domains into `after:`/`site:` hints that are re-applied locally. xAI reads an OAuth JSON from `XAI_AUTH_JSON` without refreshing it and needs a raised `attemptTimeoutMs`.

| Type | API key | Base URL |
| --- | --- | --- |
| Tavily / Exa / Brave / Firecrawl / XCrawl | `<NAME>_API_KEY` | `<NAME>_BASE_URL` |
| Bocha | `BOCHA_API_KEY` | `BOCHA_BASE_URL`, default `https://api.bocha.cn` |
| SearXNG | None | `SEARXNG_BASE_URL`, required |
| Jina / AnySearch | `JINA_API_KEY` / `ANYSEARCH_API_KEY`, optional | `<NAME>_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | fixed `https://api.deepseek.com` |
| xAI Search | `XAI_AUTH_JSON` (OAuth file) | default `https://cli-chat-proxy.grok.com/v1`, `grok-4.6` |

Custom instances name their variables with `apiKeyEnv`/`baseUrlEnv` and may set `baseUrl` and `headers`. Public Firecrawl Cloud needs a key; self-hosted Firecrawl v2 does not.

## Routing and limits

Both entry points call the same router and differ only in output shape, per-command options, and the gateway's fixed Fetch/backfill thresholds.

`auto` walks the primary route, then the fallback route once the primary group has failed in a way that is fallback-eligible. Incomplete instances are recorded and skipped; non-2xx provider responses and recoverable errors (network, timeout, oversized, no usable content) continue to the next instance; invalid input and unsupported content stop immediately; full exhaustion returns `provider_exhausted` with the best short body in `partial`. An explicit `--provider` runs once with no fallback and returns `provider_disabled` if not routed. `retryable` describes retrying the same provider, not the switch condition.

`extract --provider auto` first probes one Markdown variant when HTTP is enabled — `.md` for file-like paths, `index.md` for directories — accepting only sufficiently long non-HTML text. Misses fall through transparently; hits are attributed to the HTTP instance without reordering.

In the CLI, after each `auto` call the successful instance moves to the front of its group and fallback-eligible failures move to the back; nothing crosses groups. Search and Extract learn independently. Explicit instances, non-fallback failures, and cancellations never reorder, and writes are atomic with last-writer-wins. The gateway never rewrites routes.

Defaults: 120 s total and 60 s per attempt for Search; 120 s and 45 s for Extract; 5 MiB per response. `--timeout` overrides only the total timeout.

## Output

Capability commands emit schema version 2. With `--json`, output contains `schemaVersion`, `ok`, the final instance and `data`; failures add a compact `error`, `attempts` (instance, code, optional status), and possibly a `partial` document. A failed order write adds `warnings` without replacing the result. Human-readable output is Markdown: a `provider` front matter block plus either a numbered result list or the extracted document; diagnostics print a heading plus JSON. Scripts should pass `--json`.

```json
{ "schemaVersion": 2, "ok": true, "provider": "exa",
  "data": { "results": [{ "rank": 1, "title": "Example", "url": "https://example.com/", "snippet": "..." }] } }
```

`providers` reports each instance's type, capabilities, route status, and credential/URL sources together with the effective orders for the next call; `doctor` fails with `1` when an enabled route contains an unconfigured instance.

## Security boundaries

- Honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`; follows up to five redirects and strips authentication, Cookie, and token headers across origins.
- Enforces a streaming 5 MiB limit rather than buffering first. HTTP extraction uses LinkeDOM, Readability, and Turndown with an RSC fallback; binaries and media return `unsupported_content`.
- Neither entry point blocks localhost, private addresses, or cloud metadata URLs by design. Untrusted callers must add their own allowlist, isolation, or egress policy; the gateway targets a private single-user deployment behind its Bearer key.

## Scope

Provider and extraction implementations draw heavily on `pi-web-access`; Pi-specific registration, tool protocols, and UI are excluded. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under MIT with attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
