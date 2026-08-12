# web-access-cli

English | [简体中文](README_CN.md)

[![CI](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Juexe/web-access-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An agent-neutral CLI for web capabilities. It defines search and web content extraction as stable capabilities while normalizing differences among Tavily, Exa, Brave, SearXNG, AnySearch, Firecrawl, Jina, and other providers behind a unified internal schema.

The CLI is the primary product interface. It is not tied to Pi, Claude Code, Codex, Cursor, OpenCode, or any other agent. Skills, MCP integrations, and agent plugins may only integrate as adapters on top of the CLI; they must not leak into the core capabilities or provider implementations.

## Capabilities and providers

| Capability | Provider types | Normalized output |
| --- | --- | --- |
| `search` | Tavily, Exa, Brave, SearXNG, AnySearch | `rank`, `title`, `url`, `snippet` |
| `extract` | Firecrawl v2, Jina Reader, Exa Contents, AnySearch, HTTP | Markdown `Document` |

A provider type describes an implementation, while a provider instance is a configurable instance of that type. One type can have multiple instances, such as `exa_team` and `exa_personal`. A route is an ordered array of instance IDs that determines both which instances are enabled and the order in which `auto` tries them.

## Installation

Node.js 22.19 or later is required.

The npm package has not been published yet. Build and run the CLI from source:

```sh
git clone https://github.com/Juexe/web-access-cli.git
cd web-access-cli
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

After building, an optional global installation can point to the absolute repository path:

```sh
pnpm add --global <absolute-path-to-web-access-cli>
web-access --help
```

For development in this repository:

```sh
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

web-access providers --pretty
web-access doctor --pretty

web-access config edit
web-access --config "/path/to/config.json" config edit
```

The CLI provides the `search` and `extract` capability commands, the `providers` and `doctor` diagnostic commands, and the `config edit` configuration command. The current version does not provide batch/all, answer, a dedicated PDF path, a Node.js SDK, or a generic MCP integration. The repository includes an optional [web-access-cli Agent Skill](skills/web-access-cli/SKILL.md) for source-checkout use; it is not included in the npm package.

### Global options

- `--config <path>`: Explicitly select a configuration file.
- `--pretty`: Pretty-print JSON. By default, JSON is written on a single line.
- `--help`, `--version`: Print standard CLI help or version text.

Except for help and version output, stdout always contains exactly one JSON envelope. Diagnostic messages are never mixed into stdout.

## Configuration

Configuration files use strict JSON; unknown fields are rejected. The CLI reads only an explicit path or a user-level path and does not search parent project directories for configuration files.

The default path on every platform is `~/.config/web-access-cli/config.json`, where `~` is the current user's home directory. The `WEB_ACCESS_CONFIG` environment variable can select another path. The `--config` command-line option takes precedence.

`web-access config edit` creates parent directories and a complete default configuration when the file is missing, then opens it with the operating system's default application for JSON files. An existing file is opened byte-for-byte as-is, even when it is temporarily invalid JSON; it is never overwritten or reformatted. The command waits only for the operating system to accept the open request, not for the editor to close. On success, envelope `data` contains the absolute `path`, `created`, and `opened: true`. A default-application launch failure returns `open_failed`; a configuration file that was created successfully remains available for manual editing.

The complete JSON Schema is available at [schemas/config.schema.json](schemas/config.schema.json). Example:

```json
{
  "$schema": "https://unpkg.com/web-access-cli@0.1.0/schemas/config.schema.json",
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
    "limit": 5,
    "timeoutMs": 60000,
    "attemptTimeoutMs": 20000,
    "maxResponseBytes": 5242880
  },
  "extract": {
    "providers": ["firecrawl_local", "jina", "exa_team", "http"],
    "timeoutMs": 120000,
    "attemptTimeoutMs": 45000,
    "maxResponseBytes": 5242880,
    "minContentCharacters": 500
  }
}
```

The built-in instances are `tavily`, `exa`, `brave`, `searxng`, `firecrawl`, `jina`, `http`, and `anysearch`. A configuration entry with the same ID overrides fields on the built-in instance. A custom ID creates another instance of the selected type. An instance is enabled only when it appears in the corresponding `providers` route. AnySearch defaults to `https://api.anysearch.com` and supports anonymous calls.

Default routes:

- Search: `tavily -> exa -> brave -> searxng`
- Extract: `firecrawl -> jina -> exa -> http`

AnySearch supports both Search and Extract but is not in either default route. Set `searchFilterMode` to `strict` (default; freshness skips the provider) or `best_effort` (rewrites freshness into a query fragment). Domain constraints are rewritten into the query and strictly re-applied locally.

### Credentials and URLs

Environment variables take precedence over plaintext keys in JSON. Built-in instances support these standard variables:

| Type | API key | Base URL |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | `TAVILY_BASE_URL` |
| Exa | `EXA_API_KEY` | `EXA_BASE_URL` |
| Brave | `BRAVE_API_KEY` | `BRAVE_BASE_URL` |
| SearXNG | None | `SEARXNG_BASE_URL`, required |
| Firecrawl | `FIRECRAWL_API_KEY` | `FIRECRAWL_BASE_URL` |
| Jina | `JINA_API_KEY`, optional | `JINA_BASE_URL` |
| HTTP | None | None |
| AnySearch | `ANYSEARCH_API_KEY`, optional | `ANYSEARCH_BASE_URL`, default `https://api.anysearch.com` |

Custom instances use `apiKeyEnv` and `baseUrlEnv` to name their environment variables. Every remote provider can define a `baseUrl` and additional `headers`. The public `api.firecrawl.dev` service requires a key; a self-hosted Firecrawl v2 instance can run without one.

## Execution and fallback

`--provider auto` follows the configured route order:

1. An instance with incomplete configuration is recorded as a failed attempt and skipped.
2. Recoverable errors, including network errors, timeouts, rate limits, 5xx responses, oversized responses, and missing usable content, cause the router to try the next instance.
3. Non-recoverable errors, including authentication errors, invalid input, and unsupported content, stop execution immediately.
4. If every instance fails, the command returns `provider_exhausted`. The best short content produced during extraction is preserved in `partial`.

Selecting an instance explicitly executes it strictly without fallback. If the instance is not in the route, the command returns `provider_disabled`.

Default limits are a 60-second total timeout and a 20-second per-attempt timeout for Search, and 120 seconds and 45 seconds respectively for Extract. Each response has a hard limit of 5 MiB. `--timeout` overrides only the total timeout for the current command.

## Output contract

Successful response example:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "search",
  "durationMs": 183,
  "request": {
    "query": "Agent-neutral web CLI",
    "provider": "auto",
    "limit": 5,
    "includeDomains": [],
    "excludeDomains": []
  },
  "provider": { "id": "exa", "type": "exa" },
  "attempts": [
    {
      "provider": { "id": "tavily", "type": "tavily" },
      "status": "failed",
      "durationMs": 0,
      "error": {
        "code": "provider_unavailable",
        "message": "tavily 未完成 search 所需配置",
        "retryable": true
      }
    },
    {
      "provider": { "id": "exa", "type": "exa" },
      "status": "success",
      "durationMs": 183
    }
  ],
  "data": {
    "results": [
      {
        "rank": 1,
        "title": "Example",
        "url": "https://example.com/",
        "snippet": "Example snippet"
      }
    ]
  },
  "raw": {}
}
```

The Chinese `message` value above matches the CLI's current error output contract.

`raw` contains only the response body from the final success or best failure. It never contains requests, response headers, or every historical response. API keys are redacted from serializable `raw` data and error messages. Stable schemas are available in [schemas](schemas).

Exit codes:

- `0`: Success
- `2`: Invalid input or configuration, or an unknown or disabled provider
- `1`: Runtime, provider, doctor, or default-application launch failure
- `130`: User cancellation

`providers` lists each instance's type, capabilities, route status, credential source, and base URL source. `doctor` performs local configuration checks only and does not call remote APIs. If an enabled route contains an unconfigured instance, the command returns `doctor_failed` with exit code `1`.

## HTTP and security boundaries

- Honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` by default.
- Follows up to five redirects. Cross-origin redirects remove authentication, Cookie, and common token headers.
- Enforces a streaming byte limit on every response instead of buffering an unbounded response first.
- HTTP Extract uses LinkeDOM, Mozilla Readability, and Turndown, with fallback parsing for Next.js RSC payloads.
- Returns `unsupported_content` for PDF, image, audio, video, zip, and general binary content.
- By design, the CLI does not block localhost, private network addresses, or cloud metadata URLs. For untrusted input, callers must enforce their own URL allowlist, network isolation, or outbound proxy policy.

## Project scope

This project draws heavily from the provider and content extraction implementations in `pi-web-access`, but does not include Pi-specific registration, tool protocols, or UI code.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md).

Licensed under MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party and upstream attribution.
