# api (cloud)

## Purpose

Cloud API entry point. A thin Fastify server that imports and mounts `packages/api-routes` with cloud-specific middleware (auth, CORS, rate limiting). Deployed separately from the local `canonry serve` server.

## Deployment Posture (Critical)

**`apps/api` is a single-tenant deployment.** One Cloud Run service per team — never share an instance across unrelated tenants. The schema has no `owner_id` on any domain table and `resolveProject` is a global lookup, so any valid `cnry_…` bearer reads and writes every project on the instance. The full rationale (and what would be required to lift this restriction) is in the root `AGENTS.md` → "Deployment Posture" section. Do not deploy as a SaaS without doing that migration first.

## Key Files

| File | Role |
|------|------|
| `src/app.ts` | Fastify app factory — registers plugins, mounts api-routes |
| `src/index.ts` | Entry point — starts the server |
| `src/plugins/` | Cloud-specific Fastify plugins (auth, CORS, etc.) |
| `src/routes/` | Cloud-only routes (if any) |

## Patterns

- This app is intentionally thin. All shared route logic lives in `packages/api-routes`.
- Cloud-specific concerns (managed Postgres, pg-boss job queue, CDN) are wired here.
- Local equivalent is `packages/canonry/src/server.ts`.

## See Also

- `packages/api-routes/` — the shared route plugins this app mounts
- `docs/architecture.md` — local vs. cloud architecture comparison
