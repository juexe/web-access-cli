# ADR 0018: Extract Source Markdown Preflight

- Status: Accepted
- Date: 2026-09-23

## Context

Some documentation sites publish Markdown at a predictable URL variant. Using that source representation can avoid HTML parsing and preserve publisher-authored content. The CLI already centralizes provider selection, deadlines, attempts, and output envelopes in the router, while HTTP extraction owns HTTP-specific response handling.

## Decision

When Extract runs with `auto`, the router may preflight the first enabled HTTP instance in configured primary-then-fallback order. An explicitly selected HTTP instance receives the same preflight; an explicitly selected non-HTTP instance does not. This does not implicitly enable HTTP or alter route membership.

The HTTP adapter requests one URL variant: paths ending in `.md` are left unchanged, directory paths ending in `/` receive `index.md`, and other paths receive `.md`. Query strings are preserved. The request prefers `text/markdown` and `text/plain`. A response is a hit only when it is 2xx, has one of those media types, is not visibly HTML, and meets `minContentCharacters` after normalization.

The Markdown document retains the original requested URL as `sourceUrl`. A miss, non-cancellation request error, or response-size/timeout error falls through to the existing provider routes within the remaining total deadline. Parent cancellation remains terminal. A hit is reported as the enabled HTTP instance and one successful debug attempt; a miss is not represented as a failed attempt. Preflight does not update adaptive provider order. Explicit HTTP falls back to its ordinary request for the original URL after a miss.

No CLI option, configuration field, provider type, output schema field, or schema version is added.

## Consequences

Sites with source Markdown can return it before remote extraction providers are called. When the variant is unavailable, existing route and fallback behavior remains in control. The preflight adds one bounded request when HTTP is enabled and consumes the existing response-size, per-attempt, and total timeout limits.
