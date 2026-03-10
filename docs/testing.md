# Testing Guide

## Workspace Checks

Run before opening a PR:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
```

## CI Mapping

- `ci.yml` validate job:
  - `typecheck`
  - `test`
  - `lint`

## Package Verification

After Phase 2 implementation, verify the publishable package:

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

All three providers (`packages/provider-gemini`, `packages/provider-openai`, `packages/provider-claude`) have unit tests that validate:

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

To test live API calls, use the CLI with real API keys:

```bash
canonry init                                    # provide API keys for one or more providers
canonry project create test --domain example.com --country US --language en
canonry keyword add test "best dentist brooklyn"
canonry run test                                # runs against all configured providers
canonry run test --provider gemini              # single-provider run
canonry status test                             # view citation results
```

## End-to-End Verification (Phase 2)

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `keyword add` / `run` workflow completes with results from all configured providers
4. Run results include per-provider grounding sources, search queries, and cited domains
5. `canonry export` produces valid `canonry.yaml`
6. `canonry apply` is idempotent and records audit log entries
7. Dashboard shows visibility data with readiness marked "Unavailable"
8. `GET /runs/:id` returns snapshots with `groundingSources`, `searchQueries`, and `model` fields
