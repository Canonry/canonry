# api (cloud)

## Purpose

Cloud API entry point. This Fastify server mounts `packages/api-routes` and configures trusted proxies, operational logging, and telemetry collection. It runs separately from `canonry serve`.

## Deployment Posture (Critical)

**`apps/api` is a single-tenant deployment.** Use one Cloud Run service per trust boundary. A full-instance wildcard key can read and write every project. See the root `AGENTS.md` and the key authority rules in `packages/api-routes/AGENTS.md`.

## Key Files

| File | Role |
|------|------|
| `src/app.ts` | Fastify app factory — registers plugins, mounts api-routes |
| `src/index.ts` | Entry point — starts the server |
| `src/plugins/env.ts` | Loads the shared platform configuration |
| `src/routes/` | Health and telemetry collection routes |

## Patterns

- This app is intentionally thin. All shared route logic lives in `packages/api-routes`.
- Set `DATABASE_URL` to a writable SQLite file path. The app passes this value to `packages/db/src/client.ts`.
- The in-process job runner and scheduler live in `canonry serve` (`packages/canonry/src/server.ts`).
- Alias hooks run inline, inside the request rather than after the response, because Cloud Run may throttle an instance once the response is sent: `onAliasesChanged` runs the full `backfillProjectAnswerMentions(db, projectId)` and `onCompetitorAliasesChanged` the competitor-fields-only pass. A failed refresh is logged and never fails the committed write.
- Boot applies the shared additive SQLite migrations (`migrate()`) before constructing the durable runtime log store, then api-routes' onReady housekeeping runs (raw-sample and journey retention, the ads-activation watchdog). Two `canonry serve` jobs never run here: the stored-traffic reclassification after a rules change (`packages/canonry/src/traffic-reclassify.ts`), so stored traffic is not reclassified under new rules and crawler hours an older version misfiled after a rollback stay where they are, and the `traffic.agent.discovered` alert loop. Application and Fastify logs use `api-routes/runtime-logger`; close unsubscribes capture and closes this host's database handle. HTTP request IDs are server-issued UUIDs.

## See Also

- `packages/api-routes/` — the shared route plugins this app mounts
- `docs/architecture.md` — local vs. cloud architecture comparison
