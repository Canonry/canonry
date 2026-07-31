# Testing Guide

## Test Runners

Canonry uses **Vitest** for the TypeScript workspace. The root
[`vitest.config.ts`](../vitest.config.ts) defines the package and app projects;
[`vitest.package.config.ts`](../vitest.package.config.ts) supports focused
package runs. The web project uses jsdom.

The native WordPress traffic-logger plugin has a separate framework-free PHP
harness. It is syntax-checked and tested with
`bash scripts/check-wordpress-plugin.sh`.

```typescript
import { test, expect, describe, it, beforeEach, afterEach } from 'vitest'
```

Tests live in `test/` directories colocated with each package (e.g. `packages/canonry/test/`).

## Workspace Checks

Run the complete local preflight before opening a PR:

```bash
pnpm run verify
# or: make verify
```

`verify` runs type checking, docs and lint checks, PHP syntax/tests, Vitest,
generated-client drift, plugin drift, all package builds, a packed npm install
smoke, and the existing Docker health smoke.

For a quick TypeScript-only loop, run:

```bash
pnpm run test
```

Local Vitest keeps its default file parallelism. `pnpm run test:ci` is for
GitHub CI: one worker with file-level and in-file concurrency disabled.

## CI Mapping

CI runs these independent checks on every matching PR or main push:

- `pnpm run typecheck`
- One fully serial Vitest run (one worker, no file-level or in-file concurrency)
- WordPress PHP syntax + harness tests sequentially on PHP 7.4 and 8.3
- Documentation and lint checks
- Generated API-client and native-plugin drift checks
- All package builds, packed npm-install smoke, and Docker health smoke

GitHub-hosted runners have one vCPU, so CI deliberately does not shard or
parallelize test execution.
The `validate` aggregate gates the reusable publish workflow, so npm and Docker
publishing cannot start until every check above has succeeded for the same SHA.

## Package Verification

The package smoke used by CI is intentionally narrow: it builds Canonry, packs
the tarball, installs it into a scratch npm project, and runs `canonry
--version`.

```bash
pnpm run package:smoke
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
canonry query add test "best dentist brooklyn"
canonry run test                                # runs against all configured providers
canonry run test --provider gemini              # single-provider run
canonry status test                             # view citation results
```

## End-to-End Verification

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `query add` / `run` workflow completes with results from all configured providers
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
