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

The Gemini provider (`packages/provider-gemini`) has unit tests that validate:

- Config validation (accepts valid keys, rejects empty)
- Custom model passthrough
- Answer text extraction from Gemini candidate response structure
- Domain extraction from grounding source URIs (www. stripping, deduplication)
- Graceful handling of empty responses and invalid URIs

These tests do **not** make real API calls. They test `normalizeResult` against synthetic `GeminiRawResult` objects to verify the parsing and extraction logic.

To test a live Gemini API call, use the CLI with a real API key:

```bash
canonry init                                    # provide your Gemini API key
canonry project create test --domain example.com --country US --language en
canonry keyword add test "best dentist brooklyn"
canonry run test                                # makes a live Gemini API call
canonry status test                             # view citation results
```

## End-to-End Verification (Phase 2)

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `keyword add` / `run` workflow completes with real Gemini results
4. Run results include grounding sources, search queries, and cited domains
5. `canonry export` produces valid `canonry.yaml`
6. `canonry apply` is idempotent and records audit log entries
7. Dashboard shows visibility data with readiness marked "Unavailable"
8. `GET /runs/:id` returns snapshots with `groundingSources`, `searchQueries`, and `model` fields
