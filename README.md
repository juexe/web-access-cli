# web-access-cli

English | [简体中文](README_CN.md)

[![CI](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An agent-neutral CLI for web capabilities. It defines search and web content extraction as stable capabilities while normalizing differences among Tavily, Exa, Bocha, Brave, SearXNG, AnySearch, XCrawl, DeepSeek, Firecrawl, Jina, and other providers behind a unified internal schema.

The CLI is the primary product interface. It is not tied to Pi, Claude Code, Codex, Cursor, OpenCode, or any other agent. Skills, MCP integrations, and agent plugins may only integrate as adapters on top of the CLI; they must not leak into the core capabilities or provider implementations.

## Capabilities and providers

| Capability | Provider types | Normalized output |
| --- | --- | --- |
| `search` | Tavily, Exa, Bocha, Brave, SearXNG, AnySearch, XCrawl, DeepSeek, xAI x_search, xAI web_search | `rank`, `title`, `url`, `snippet` |
| `extract` | Firecrawl v2, Jina Reader, Exa Contents, AnySearch, XCrawl, HTTP | Markdown `Document` |

A provider type describes an implementation, while a provider instance is a configurable instance of that type. One type can have multiple instances, such as `exa_team` and `exa_personal`. Each capability has a primary `providers` route and a `providers_fallback` route. Both arrays determine enabled instances and their current `auto` order; the CLI only reorders members within their existing group.

## Installation

Node.js 22.19 or later is required.

Install the CLI from npm:

```sh
npm install --global web-access-cli
web-access --help
```

Alternatively, install it with pnpm:

```sh
pnpm add --global web-access-cli
web-access --help
```

For development from source:

```sh
git clone https://github.com/juexe/web-access-cli.git
cd web-access-cli
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

## Project structure

```text
src/cli.ts                 Commander CLI and exit codes
src/config/                Configuration files, environment variables, and route merging
src/core/                  Public types, schemas, errors, routing, and diagnostics
src/providers/             Provider adapters, registry, and HTTP/RSC extraction
src/transport/             Proxies, timeouts, redirects, and response size limits
schemas/                   Generated JSON Schemas
test/                      node:test unit tests and local HTTP integration tests
```

Provider adapters should handle protocol mapping only. Fallback, deadlines, attempts, envelopes, and exit codes are managed centrally by `src/core`. Do not add lifecycle or tool registration code for Pi, Claude Code, Codex, or any other agent to an adapter.

## Development workflow

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

`pnpm check` runs linting, type checking, tests, and the build in that order. After changing `src/core/schema.ts`, run `pnpm build` again and commit the updated `schemas/*.schema.json` files. Provider tests should use the mock transport or local HTTP server from `test/helpers.ts`; they must not depend on real API keys or external network reliability.

## Commands

```sh
web-access search "Agent-neutral web CLI"
web-access search "TypeScript release" --provider exa --limit 10 --freshness month
web-access search "browser automation" --include-domain example.com --exclude-domain blocked.example.com

web-access extract https://example.com/article
web-access extract https://example.com/article --provider http --timeout 30000
web-access extract https://example.com/article --json

web-access providers
web-access doctor

web-access config edit
web-access --config "/path/to/config.json" config edit
web-access config init
web-access --config "/path/to/config.json" config init --json
```

The CLI provides the `search` and `extract` capability commands, the `providers` and `doctor` diagnostic commands, and the `config init` and `config edit` configuration commands. The current version does not provide batch/all, answer, a dedicated PDF path, a Node.js SDK, or a generic MCP integration. The repository includes an optional [web-access-cli Agent Skill](skills/web-access-cli/SKILL.md) for source-checkout use; it is not included in the npm package.

### Global options

- `--config <path>`: Explicitly select a configuration file.
- `--json`: Output a compact schema v2 JSON envelope. Without it, successful commands write human-readable Markdown; all failures always write JSON.
- `--help`, `--version`: Print standard CLI help or version text.

Successful commands default to Markdown for human readers. `search` writes a YAML front matter block followed by a numbered result list; `extract` writes YAML front matter followed by the normalized Markdown body; `providers`, `doctor`, and `config edit` write a heading followed by pretty-printed JSON data; `config init` writes the created absolute path on one line. Add `--json` when a schema v2 envelope is required. Extract `partial` results and all failures, including invalid input and runtime errors, always remain JSON envelopes. Diagnostic messages are never mixed into stdout.

## Configuration

Configuration files use strict JSON; unknown fields are rejected. The CLI reads only an explicit path or a user-level path and does not search parent project directories for configuration files.

The default path on every platform is `~/.config/web-access-cli/config.json`, where `~` is the current user's home directory. The `WEB_ACCESS_CONFIG` environment variable can select another path. The `--config` command-line option takes precedence.

`web-access config edit` creates parent directories and a complete default configuration when the file is missing, then opens it with the command in `VISUAL`, or `EDITOR` when `VISUAL` is empty. The value may contain a quoted executable path and arguments; it is parsed without shell evaluation and the configuration path is appended as a separate argument. An existing file is opened byte-for-byte as-is, even when it is temporarily invalid JSON; it is never overwritten or reformatted. The command waits only for the editor process to start, not for it to close. When neither variable is set, the command returns `open_failed`; a configuration file that was created successfully remains available for manual editing.

`config init` creates a new configuration from standard credential environment variables and refuses to overwrite an existing file. It keeps all built-in instance definitions, writes detected Search providers to the primary route, leaves Search fallback empty, writes detected remote Extract providers to the primary route, and places `http` in the Extract fallback route. After an `auto` capability call succeeds or encounters fallback-eligible failures, the CLI atomically reorders the matching `providers` or `providers_fallback` array in place. Members never move between groups. The legacy `_providers` and `_providers_fallback` fields are rejected as unknown configuration fields.

The complete JSON Schema is available at [schemas/config.schema.json](schemas/config.schema.json). Example:

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.5.0/schemas/config.schema.json",
  "providers": [
    {
      "id": "exa_team",
      "type": "exa",
      "apiKeyEnv": "TEAM_EXA_API_KEY",
      "headers": {
        "X-Team": "docs"
      }
    },
    {
      "id": "searx_local",
      "type": "searxng",
      "baseUrl": "http://127.0.0.1:8080"
    },
    {
      "id": "firecrawl_local",
      "type": "firecrawl",
      "baseUrl": "http://127.0.0.1:3002"
    }
  ],
  "search": {
    "providers": ["searx_local", "exa_team", "brave"],
    "providers_fallback": ["deepseek"],
    "limit": 5,
    "timeoutMs": 120000,
    "attemptTimeoutMs": 60000,
    "maxResponseBytes": 5242880
  },
  "extract": {
    "providers": ["firecrawl_local", "jina", "exa_team"],
    "providers_fallback": ["http"],
    "timeoutMs": 120000,
    "attemptTimeoutMs": 45000,
    "maxResponseBytes": 5242880,
    "minContentCharacters": 500
  }
}
```

The built-in instances are `tavily`, `exa`, `bocha`, `brave`, `searxng`, `firecrawl`, `jina`, `http`, `anysearch`, `xcrawl`, `deepseek`, `xai_x_search`, and `xai_web_search`. A configuration entry with the same ID overrides fields on the built-in instance. A custom ID creates another instance of the selected type. An instance is enabled when it appears in either corresponding route. Bocha defaults to `https://api.bocha.cn` and requires an API key; AnySearch defaults to `https://api.anysearch.com` and supports anonymous calls; XCrawl defaults to `https://run.xcrawl.com` and requires an API key; DeepSeek defaults to `https://api.deepseek.com/anthropic/v1` and requires an API key.

Default routes:

- Search primary: `tavily -> exa -> bocha -> brave -> searxng -> anysearch -> xcrawl`
- Search fallback: `deepseek -> xai_x_search -> xai_web_search`
- Extract primary: `firecrawl -> jina -> exa -> anysearch -> xcrawl`
- Extract fallback: `http`

The default routes split built-in providers into a primary group and a fallback group. Custom instance IDs are merged into the instance list but must still be added to a route explicitly. An omitted capability route uses the defaults above; an explicit Search primary empty array is invalid, while Extract may be explicitly disabled with an empty primary route. In `auto` mode, incompletely configured instances are skipped. AnySearch and XCrawl accept `searchFilterMode`: `strict` (default; freshness skips the provider) or `best_effort` (rewrites freshness into a query fragment). Domain constraints are rewritten into the query and strictly re-applied locally. XCrawl Extract always uses synchronous Scrape with Markdown output; Map, Crawl, and asynchronous jobs are outside the current CLI capabilities.

DeepSeek Search performs a full Anthropic-compatible Messages model turn with the native `web_search_20250305` server tool, so it can have higher latency and cost than a dedicated search endpoint. It is in the default Search fallback group and is reached only after every primary provider is unavailable, returns a final non-2xx HTTP response, or otherwise fails recoverably. The adapter accepts URLs only from structured `web_search_tool_result` blocks, joins citation excerpts by URL, and never extracts URLs from model prose. Domain constraints are rewritten into the query and strictly re-applied locally; `freshness` is unsupported and skips DeepSeek with a recoverable error. Redirects are rejected without contacting the `Location` target. Provider-private `encrypted_content` payloads are omitted from `raw` because they are opaque, cannot be displayed or decoded by the CLI, and add no diagnostic value.

XAI hosted Search reads an external OAuth JSON file from `XAI_AUTH_JSON` on every call and uses only its `access_token`; an external CLIProxyAPI process owns refresh and write-back. Instance fields `authJson`/`authJsonEnv` and `model`/`modelEnv` override the path and model. `xai_web_search` accepts at most five allow or exclude domains (mutually exclusive); `xai_x_search` rejects `freshness`. Model-backed search can take longer than ordinary API searches; Search defaults allow up to 60 seconds per attempt and 120 seconds total.

### Credentials and URLs

Environment variables take precedence over plaintext keys in JSON. Built-in instances support these standard variables:

| Type | API key | Base URL |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | `TAVILY_BASE_URL` |
| Exa | `EXA_API_KEY` | `EXA_BASE_URL` |
| Bocha | `BOCHA_API_KEY` | `BOCHA_BASE_URL`, default `https://api.bocha.cn` |
| Brave | `BRAVE_API_KEY` | `BRAVE_BASE_URL` |
| SearXNG | None | `SEARXNG_BASE_URL`, required |
| Firecrawl | `FIRECRAWL_API_KEY` | `FIRECRAWL_BASE_URL` |
| Jina | `JINA_API_KEY`, optional | `JINA_BASE_URL` |
| HTTP | None | None |
| AnySearch | `ANYSEARCH_API_KEY`, optional | `ANYSEARCH_BASE_URL`, default `https://api.anysearch.com` |
| XCrawl | `XCRAWL_API_KEY` | `XCRAWL_BASE_URL`, default `https://run.xcrawl.com` |
| DeepSeek | `DEEPSEEK_API_KEY` | No standard environment variable; default `https://api.deepseek.com/anthropic/v1` |
| xAI Search | `XAI_AUTH_JSON` | No standard API-key variable; default `https://cli-chat-proxy.grok.com/v1`, model `grok-4.6` |

Custom instances use `apiKeyEnv` and `baseUrlEnv` to name their environment variables. Every remote provider can define a `baseUrl` and additional `headers`. The public `api.firecrawl.dev` service requires a key; a self-hosted Firecrawl v2 instance can run without one.

## Execution and fallback

`--provider auto` follows the configured `providers` order first and enters `providers_fallback` only after the complete primary group fails with a fallback-eligible result:

1. An instance with incomplete configuration is recorded as a failed attempt and skipped.
2. A final provider HTTP response outside 2xx, including authentication, request, rate-limit, and server errors, causes the router to try the next instance.
3. Other recoverable errors, including network errors, timeouts, oversized responses, and missing usable content, also cause the router to continue.
4. Non-recoverable failures without a final non-2xx response, including invalid input and unsupported content detected in a successful response, stop execution immediately.
5. If every instance in both groups fails, the command returns `provider_exhausted`. The best short content produced during extraction is preserved in `partial`.

Before those routes run, `extract --provider auto` checks one Markdown variant when an HTTP instance is enabled in either group. It appends `.md` to file-like paths or uses `index.md` for directory paths, requests `text/markdown` and `text/plain`, and accepts only a sufficiently long non-HTML text response. A miss or request failure is transparent and falls through to the configured routes. A hit is reported as the enabled HTTP instance; it does not change provider order. Explicit non-HTTP selections are unchanged, while an explicit HTTP selection checks the Markdown variant before fetching the original URL.

After each `auto` call, a successful instance moves to the front of its group, untried instances remain in the middle, and instances with the fallback-eligible failures above move stably to the back. Relative order within each group is preserved; no provider crosses between primary and fallback. The order stays unchanged when every instance in a group fails. Search and Extract learn independently; explicit instances, non-fallback failures, and user cancellation never update the order. Writes use atomic replacement, and the last writer wins across concurrent processes.

An attempt keeps the provider's original error code, HTTP status, and `retryable` value. `retryable` describes whether the original operation can be retried against the same provider; it is not the sole condition for switching to the next provider in an automatic route.

Selecting an instance explicitly executes it strictly without fallback. If the instance is not in the route, the command returns `provider_disabled`.

Default limits are a 120-second total timeout and a 60-second per-attempt timeout for Search, and 120 seconds and 45 seconds respectively for Extract. Each response has a hard limit of 5 MiB. `--timeout` overrides only the total timeout for the current command.

## Output contract

Capability commands use output schema version 2. Their default envelope is intentionally small:

```json
{
  "schemaVersion": 2,
  "ok": true,
  "provider": "exa",
  "data": {
    "results": [
      {
        "rank": 1,
        "title": "Example",
        "url": "https://example.com/",
        "snippet": "Example snippet"
      }
    ]
  }
}
```

With `--json`, capability output contains only `schemaVersion`, `ok`, the final Instance ID and normalized `data`. Failures contain a compact `error` and, when providers were attempted, `attempts` entries with only Instance ID, error code and optional HTTP status. Extract quality failures may include a `partial` document without raw provider data. If the learned order cannot be written, either a success or failure envelope additionally contains `warnings: [{ "code": "provider_order_update_failed", "message": "..." }]` without replacing the primary result. Search and extract input errors use the same compact failure shape.

For human-readable output, extraction starts with YAML front matter and then the provider-normalized Markdown body. Search results use a numbered Markdown list; diagnostics and config edit use a heading plus pretty-printed JSON data. Metadata values use JSON double-quoted scalar encoding and the body is not modified. Existing scripts and other machine consumers should append `--json` explicitly.

Example default extract output:

```markdown
---
provider: "local_http"
url: "https://example.com/article"
title: "Example title"
---

# Article content
```

All success and failure envelopes use schema version 2. Stable schemas are available in [schemas](schemas).

Exit codes:

- `0`: Success
- `2`: Invalid input or configuration, or an unknown or disabled provider
- `1`: Runtime, provider, doctor, or editor launch failure
- `130`: User cancellation

`providers` lists each instance's type, capabilities, route status, credential source, and base URL source. Its `searchRoute`/`searchFallbackRoute` and `extractRoute`/`extractFallbackRoute` fields show the two effective orders for the next `auto` call. `doctor` performs local configuration checks only and does not call remote APIs. If an enabled route contains an unconfigured instance, the command returns `doctor_failed` with exit code `1`.

## HTTP and security boundaries

- Honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` by default.
- Follows up to five redirects. Cross-origin redirects remove authentication, Cookie, and common token headers.
- Enforces a streaming byte limit on every response instead of buffering an unbounded response first.
- HTTP Extract uses LinkeDOM, Mozilla Readability, and Turndown, with fallback parsing for Next.js RSC payloads.
- HTTP Extract prefers an enabled source Markdown variant (`.md` or directory `index.md`) before provider routes when that variant returns usable Markdown.
- Returns `unsupported_content` for PDF, image, audio, video, zip, and general binary content.
- By design, the CLI does not block localhost, private network addresses, or cloud metadata URLs. For untrusted input, callers must enforce their own URL allowlist, network isolation, or outbound proxy policy.

## Project scope

This project draws heavily from the provider and content extraction implementations in `pi-web-access`, but does not include Pi-specific registration, tool protocols, or UI code.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md).

Licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party and upstream attribution.
