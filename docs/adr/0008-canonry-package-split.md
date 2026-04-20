# ADR 0008: Split `@ainyc/canonry` into smaller publishable packages

## Status

Proposed. Not yet accepted — this ADR exists to align on seams before any code moves.

## Context

`packages/canonry/` is the single publishable npm artifact. Today it contains:

- CLI dispatch (`src/cli.ts`, `src/cli-commands.ts`, `src/commands/`, `src/cli-commands/`, `src/cli-error.ts`)
- HTTP server (`src/server.ts`)
- In-process job runner (`src/job-runner.ts`)
- Scheduler (`src/scheduler.ts`)
- Post-run coordinator + intelligence + notifier (`src/run-coordinator.ts`, `src/intelligence-service.ts`, `src/notifier.ts`)
- Provider registry (`src/provider-registry.ts`)
- Built-in Aero agent (`src/agent/*`)
- Snapshot + PDF rendering (`src/snapshot-service.ts`, `src/snapshot-pdf.ts`, `src/snapshot-format.ts`)
- Site-fetch + sitemap parsing (`src/site-fetch.ts`, `src/sitemap-parser.ts`)
- GSC / GA4 / WordPress / backlinks sync glue (`src/gsc-*.ts`, `src/ga4-config.ts`, `src/wordpress-config.ts`, `src/commoncrawl-sync.ts`, `src/backlink-extract.ts`)
- Web SPA assets bundled from `apps/web/` via `build-web.ts`

`tsup.config.ts` bundles 13 workspace packages into the artifact. `pnpm publish` triggers a Vite build of the SPA as a side effect.

## Problem

1. Publishing the CLI forces a full SPA rebuild.
2. An unrelated change (e.g., a new provider adapter) ships every other subsystem with it.
3. Testing any subsystem in isolation requires instantiating nearby plumbing; `packages/api-routes/` passes callbacks (`queueRunIfProjectIdle`, `resolveWebhookTarget`) into `canonry` which then registers them back into the mounted plugin, creating a hidden cycle.
4. New contributors face a 34-module flat `src/` tree with no obvious cohesion boundaries.
5. Bundle size: consumers who only need one entry point (e.g., `canonry serve`) still pull in PDF rendering, CDP bindings, and agent transcript compaction.

## Proposed Decision

Split `@ainyc/canonry` into focused packages, keep a thin `@ainyc/canonry` umbrella for the default install experience, and break the callback-inversion cycle with api-routes.

### Proposed seams

| Package | Contents |
|---------|----------|
| `@ainyc/canonry-cli` | `cli.ts`, `cli-commands*`, `commands/`, `client.ts`, `cli-error.ts`, `logger.ts`, `telemetry.ts` |
| `@ainyc/canonry-server` | `server.ts`, `config.ts`, provider-registry, scheduler, job-runner, run-coordinator, intelligence-service, notifier, snapshot service |
| `@ainyc/canonry-agent` | `agent/*` (Aero session, tools, skill-tools, compaction, memory store) |
| `@ainyc/canonry-integrations-glue` | `gsc-*.ts`, `ga4-config.ts`, `wordpress-config.ts`, `commoncrawl-sync.ts`, `backlink-extract.ts`, `site-fetch.ts`, `sitemap-parser.ts` |
| `@ainyc/canonry-reporting` | `snapshot-pdf.ts`, `snapshot-format.ts` |
| `@ainyc/canonry` (umbrella) | Re-exports + bin stub; installs the SPA assets as a peer artifact |
| `@ainyc/canonry-web-assets` | Built SPA (tarball of `apps/web` output); independent release cadence |

### Cycle fix

`packages/api-routes/` should expose an abstract job-queue interface it owns, not accept a `queueRunIfProjectIdle` callback from the consumer. `canonry-server` then implements the interface and passes it in — dependency flows one direction (server → api-routes), not through round-trip callbacks.

## Why

- Any subsystem can ship on its own cadence. An agent patch doesn't force a new `canonry` release.
- SPA changes don't trigger CLI/server rebuilds. Web assets become an independently versioned dependency.
- Smaller surfaces are testable in isolation — `canonry-server` can boot without the CLI, `canonry-agent` can be unit-tested without Fastify.
- The api-routes cycle disappears because the interface owner (routes) is also the interface definer.
- Users installing the umbrella package still get the same CLI experience; no UX regression.

## Tradeoffs / Costs

- **Refactor scope:** ~34 source files to move, ~15 import-path churn in `server.ts`, new `package.json` for each split, publishing pipeline changes.
- **Internal dep graph complexity:** 5+ new workspace packages to maintain.
- **Initial build time may increase slightly** from extra tsup invocations (mitigated by project references and caching).
- **Cross-package refactors become harder** because a change may now span 2-3 packages instead of one.
- **Release coordination:** umbrella package must pin compatible ranges of its children. Without lockstep versioning, users could resolve a broken combination.

## Explicitly Not Decided

- Whether to publish each split package to npm or keep them private workspace packages that only the umbrella re-exports.
- Final names — `-server` might become `-runtime`, `-cli` might stay inside umbrella. Names are a naming round, not this decision.
- Timing. This ADR proposes the shape; execution is a separate planning exercise.

## Open Questions

1. Does the SPA asset split warrant its own registry entry, or is an internal workspace package (consumed only by the umbrella at publish time) simpler?
2. Does the Aero agent move to a separate package if it stays tightly coupled to `canonry-server` tools? Or is the value purely conceptual?
3. What happens to `bin/canonry.mjs` — stay in the umbrella, or move with `-cli`?

## Next Step

Discuss, revise, then accept or reject. Nothing moves in code until this ADR reaches Accepted.
