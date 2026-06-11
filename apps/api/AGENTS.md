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

## Environment

Beyond the provider keys parsed by `@ainyc/canonry-config` (`getPlatformEnv`):

| Var | Default | Purpose |
|-----|---------|---------|
| `CANONRY_API_KEY` | — | Default `cnry_` bearer, seeded into `api_keys` on boot; password sessions bind to it. Also required to pass the `/session/setup` gate (always on here — Cloud Run is network-reachable) |
| `CANONRY_PUBLIC_URL` | — | Sets `Secure` on session cookies when `https://`. Boot warns when unset |
| `CANONRY_TRUST_PROXY_HOPS` | `1` | Trusted reverse-proxy hop count → `request.ip` is the rightmost X-Forwarded-For entry, so rate limiting keys per client (not per proxy). 0 = direct connections |
| `CANONRY_ENABLE_GUEST_REPORTS` | off | Enables the anonymous `/guest/report*` funnel (404s when unset) |
| `CANONRY_ENABLE_CLOUD_BOOTSTRAP` | off | Enables the `/cloud/*` bridge (404s when unset) |
| `CANONRY_ALLOW_PRIVATE_WEBHOOKS` | off | Allows webhook targets resolving to private ranges (Docker-internal control-plane callbacks) |

All boolean flags parse through `parseBooleanFlag` (`1/true/yes/on`).

## Patterns

- This app is intentionally thin. All shared route logic lives in `packages/api-routes`.
- Cloud-specific concerns (managed Postgres, pg-boss job queue, CDN) are wired here.
- Local equivalent is `packages/canonry/src/server.ts`.

## See Also

- `packages/api-routes/` — the shared route plugins this app mounts
- `docs/architecture.md` — local vs. cloud architecture comparison
