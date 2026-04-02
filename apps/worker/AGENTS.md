# worker (cloud)

## Purpose

Cloud background worker. Processes jobs from a queue (pg-boss) — visibility sweeps, data syncs, and scheduled tasks. The cloud equivalent of the in-process job runner in `packages/canonry`.

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Entry point — connects to job queue and starts processing |
| `src/health-server.ts` | HTTP health check endpoint for container orchestration |
| `src/audit-client.ts` | Audit log client for cloud worker context |
| `src/jobs/` | Job handler implementations |

## Patterns

- Jobs are dispatched by the API (via `packages/api-routes`) and consumed by this worker.
- Each job type has a handler in `src/jobs/`.
- The health server exposes a `/health` endpoint for liveness probes.
- Local equivalent is `packages/canonry/src/job-runner.ts` (in-process, no queue).

## See Also

- `packages/api-routes/` — dispatches jobs that this worker consumes
- `docs/architecture.md` — local vs. cloud process model
