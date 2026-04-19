# Testing Guide

## Test Runner

Canonry uses **Vitest**. Configured via `vitest.workspace.ts` at the repo root with per-package `vitest.config.ts` files.

```typescript
import { test, expect, describe, it, beforeEach, afterEach } from 'vitest'
```

Tests live in `test/` directories colocated with each package (e.g. `packages/canonry/test/`).

## Workspace Checks

Run before opening a PR:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
```

## CI Mapping

The validation job in `ci.yml` runs:

- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run lint`

across the full workspace on every PR.

## Package Verification

To verify the publishable package:

```bash
cd packages/canonry && npm pack
npm install -g ./ainyc-canonry-*.tgz
canonry init
canonry serve
```

## Dependency Verification Checklist

1. Run workspace checks.
2. Confirm `apps/worker/src/audit-client.ts` still imports from `@ainyc/aeo-audit`.
3. Confirm worker adapter tests still pass against the published package.
4. Confirm `packages/api-routes/` has no direct dependency on `apps/*`.
5. Confirm `packages/canonry/` bundles SPA assets correctly (`build-web.ts`).

## Provider Tests

The provider packages (`packages/provider-gemini`, `provider-openai`, `provider-claude`, `provider-perplexity`, `provider-local`, `provider-cdp`) have unit tests that validate:

- Config validation (accepts valid keys, rejects empty)
- Custom model passthrough
- Answer text extraction from provider-specific response structures
- Domain extraction from grounding source URIs (www. stripping, deduplication)
- Graceful handling of empty responses and invalid URIs

These tests do **not** make real API calls. They test `normalizeResult` against synthetic raw result objects to verify the parsing and extraction logic.

### Provider-specific response formats

- **Gemini**: `candidates[].content.parts[].text` + `groundingMetadata.groundingChunks`
- **OpenAI**: `output[].content[].text` + `output[].content[].annotations[]` (URL citations)
- **Claude**: `content[].text` + `web_search_tool_result` blocks with `search_results`
- **Perplexity**: `search_results` array (preferred) or `citations` array fallback
- **Local**: heuristic URL/domain scan over the raw answer text (no native web search)

To test live API calls, use the CLI with real API keys:

```bash
canonry init                                    # provide API keys for one or more providers
canonry project create test --domain example.com --country US --language en
canonry keyword add test "best dentist brooklyn"
canonry run test                                # runs against all configured providers
canonry run test --provider gemini              # single-provider run
canonry status test                             # view citation results
```

## End-to-End Verification

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `keyword add` / `run` workflow completes with results from all configured providers
4. Run results include per-provider grounding sources, search queries, and cited domains
5. `canonry export` produces valid `canonry.yaml`
6. `canonry apply` is idempotent and records audit log entries
7. Dashboard shows visibility data
8. `GET /runs/:id` returns snapshots with `groundingSources`, `searchQueries`, and `model` fields

## Conventions

- Test the public API of each module, not internal implementation details.
- Cover both the happy path and meaningful edge cases (invalid input, env var overrides, error handling).
- When testing CLI commands, capture stdout/stderr and assert on output rather than only checking side effects.
- Use temp directories (`os.tmpdir()`) for file-system tests; clean up in `afterEach`.
- **Test default-value propagation end-to-end.** When a feature stores a default that another feature consumes, write a test that exercises the full path with no explicit override.
