# Journeys validation

Validated on 2026-10-27 with Node 26.12.1. The PR body records the submitted
commit. Checks were run after each change was finalized; unchanged results
were reused. Phase counts overlap and must not be added together.

| Phase | Result |
| --- | --- |
| Agent capture, contracts, API, CLI/MCP and integration feature | 696 tests passed across 25 files |
| Dedicated visitor/agent page and telemetry | 193 tests passed across 15 files |
| Final UI simplification | 92 tests passed across 5 files |
| Private provider-ID fix | 403 tests passed across 12 files |
| Final CLI/MCP Simple + Advanced transport and UI/shell rerun | 189 tests passed across 7 files |

The privacy regression was run against the pre-fix writer and failed because a
Cloud Run fallback event ID retained a URL token. It passed after the writer
used a project/source-scoped HMAC for lookup and storage. Local HTTP tests first
hit sandbox `listen EPERM`; rerunning the affected files with loopback access
passed. Final selected runs had zero failed or skipped tests.

## Final rerun

```sh
pnpm exec vitest run \
  packages/canonry/test/traffic-commands.test.ts \
  packages/canonry/test/mcp-registry.test.ts \
  apps/web/test/agent-journeys.test.tsx \
  apps/web/test/router.test.tsx \
  apps/web/test/app.test.tsx \
  apps/web/test/app-embed.test.tsx \
  apps/web/test/app-embed-callgraph.test.tsx
```

The existing CLI and MCP HTTP cases now run in both Simple and Advanced modes.
An unmatched request makes a dropped Property selector observable. List/detail,
JSON/JSONL, human-readable attribution and project-scoped read-key denial are
covered through the real API client.

## Static, generated and build checks

Typecheck and type-aware lint passed for contracts, DB, traffic integration, API
routes, generated SDK, Canonry, web and Val kit. API and worker host checks also
passed after the capture fix. The final commands below passed; existing unrelated
lint and bundle-size warnings remain. This is an owner change; full-workspace
`pnpm verify` was not run.

```sh
pnpm check
pnpm -r --workspace-concurrency=2 --filter @canonry/canonry-api-routes --filter @canonry/canonry --filter @canonry/canonry-api --filter @canonry/canonry-worker run typecheck
pnpm -r --workspace-concurrency=2 --filter @canonry/canonry-api-routes --filter @canonry/canonry --filter @canonry/canonry-api --filter @canonry/canonry-worker run lint
pnpm --filter @canonry/canonry lint
pnpm --filter @canonry/canonry-web typecheck
pnpm gen:check
pnpm guide:check
pnpm plugin:check
pnpm val:skills:check
pnpm build
pnpm build:cli
pnpm build:web
git diff --cached --check
```

Built CLI help was smoke-tested with isolated configuration. Browser checks
used the real router/shell and synthetic fixtures at desktop/mobile sizes.
Keyboard smoke passed 22 checks at 1440×1100 and 24 at 390×900: Tab, Enter,
Space, native selectors, disclosure controls, Property focus restoration and
mobile navigation Escape/focus return. Combined filters reached list/detail
SDK requests; there were no page errors or document overflow.
The capture tests exercise a fresh database and an upgrade from migration 196
through 197. Existing endpoint paths and response contracts are unchanged;
the new agent reads have matching generated SDK, CLI and MCP surfaces.

## Earlier affected-test selections

### Feature validation

```sh
pnpm exec vitest run \
  packages/integration-traffic/test \
  packages/api-routes/test/agent-journeys.test.ts \
  packages/api-routes/test/agent-journey-capture.test.ts \
  packages/api-routes/test/journeys.test.ts \
  packages/api-routes/test/traffic-samples.test.ts \
  packages/api-routes/test/openapi-contract.test.ts \
  packages/api-routes/test/db-dto-coverage.test.ts \
  packages/api-routes/test/no-new-loose-routes.test.ts \
  packages/api-routes/test/probe-exclusion.test.ts \
  packages/canonry/test/traffic-commands.test.ts \
  packages/canonry/test/mcp-registry.test.ts \
  packages/canonry/test/mcp-stdio.test.ts \
  packages/canonry/test/journeys-commands.test.ts \
  apps/web/test/agent-journeys.test.tsx \
  packages/api-client-generated/test/smoke.test.ts \
  packages/contracts/test/operation-access.test.ts \
  packages/db/test/traffic-tables.test.ts \
  packages/db/test/migration-downgrade-safety.test.ts \
  packages/val-kit/test/resources.test.ts
```

### Visitor dashboard validation

```sh
pnpm exec vitest run \
  apps/web/test/agent-journeys.test.tsx \
  apps/web/test/router.test.tsx \
  apps/web/test/app.test.tsx \
  apps/web/test/app-embed.test.tsx \
  apps/web/test/app-embed-callgraph.test.tsx \
  apps/web/test/dashboard-class-baseline.test.tsx \
  apps/web/test/ui-telemetry.test.ts \
  apps/web/test/ui-telemetry-filters.test.tsx \
  packages/contracts/test/ui-telemetry.test.ts \
  packages/api-routes/test/journeys.test.ts \
  packages/api-routes/test/agent-journeys.test.ts \
  packages/api-routes/test/openapi-contract.test.ts \
  packages/api-routes/test/ui-telemetry-route-templates.test.ts \
  packages/api-client-generated/test/smoke.test.ts \
  packages/val-kit/test/resources.test.ts
```

### Final UI validation

```sh
pnpm check
pnpm --filter @canonry/canonry-web typecheck
pnpm --filter @canonry/canonry-web lint
pnpm exec vitest run apps/web/test/agent-journeys.test.tsx apps/web/test/router.test.tsx apps/web/test/app.test.tsx apps/web/test/app-embed.test.tsx apps/web/test/app-embed-callgraph.test.tsx
pnpm build:web
git diff --check
```

### Privacy fix validation

```sh
pnpm exec vitest run \
 packages/api-routes/test/agent-journey-capture.test.ts \
 packages/api-routes/test/agent-journeys.test.ts \
 packages/api-routes/test/journeys.test.ts \
 packages/api-routes/test/traffic.test.ts \
 packages/api-routes/test/traffic-cloudflare.test.ts \
 packages/api-routes/test/traffic-cloudflare-queue.test.ts \
 packages/api-routes/test/traffic-backfill-outcomes.test.ts \
 packages/api-routes/test/traffic-samples.test.ts \
 packages/integration-traffic/test/agent-journeys.test.ts \
 packages/integration-cloud-run/test/cloud-run-client.test.ts \
 packages/canonry/test/traffic-commands.test.ts \
 packages/canonry/test/mcp-registry.test.ts

pnpm exec vitest run packages/canonry/test/traffic-commands.test.ts packages/canonry/test/mcp-registry.test.ts

pnpm -r --workspace-concurrency=2 --filter @canonry/canonry-api-routes --filter @canonry/canonry --filter @canonry/canonry-api --filter @canonry/canonry-worker run typecheck
pnpm -r --workspace-concurrency=2 --filter @canonry/canonry-api-routes --filter @canonry/canonry --filter @canonry/canonry-api --filter @canonry/canonry-worker run lint
```

## Carrick limit

`CARRICK_NO_UPDATE_CHECK=1 carrick check --changed --all --json` selected 39
changed source files and attempted to refresh the service index. It exited 2
after 300,794 ms while re-reading the first service: `the re-scan ran past the
budget`. It judged zero routes/calls, so this is not a compatibility pass.

The hosted review covered existing callsites and found no confirmed wire
mismatch. New uncommitted functions were outside its index. Targeted reuse
review found no confirmed duplicate; the final capture-writer query returned
zero matches across 8,583 compared intents, with 1,873 functions lacking intents.
Local source review and real API/CLI/MCP transport tests supplement this limited
coverage.

## Security and measurement limits

Agent request IDs and IP/UA correlations are keyed; raw URLs in provider IDs
and raw IP/UA do not enter the agent tables or DTOs. Paths are redacted by the
existing sanitizer. Administrator sessions and equivalent scoped read keys
are supported; viewer/embed access is denied. Reads do not contact providers.
Retention is 30 days, capture is capped at 10,000 events per source UTC day,
and oversized reads are rejected rather than silently truncated.

Request sequences are inferred, not proof of one user or task. Operator
verification is independent. No prompt, off-site browsing, browser-only action,
or business completion is inferred. Advanced attribution uses the current
measurement plan and does not invent market, provider, or query-class scope.
