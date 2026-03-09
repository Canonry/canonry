# Self-Hosting Guide

## Phase 1 Status

Phase 1 ships a placeholder local stack so the API, worker, web app, and Postgres services can boot together. Technical audits are intended to be executed through the published `@ainyc/aeo-audit` dependency inside the worker.

## Prerequisites

- Docker Desktop or Docker Engine with Compose
- Node.js 20+
- pnpm 9

## Local Boot

```bash
cp .env.example .env
pnpm run docker:up
```

If you only want the Dockerized platform skeleton, a local `pnpm install` is not required first.

Services:

- Web: `http://localhost:4173`
- API: `http://localhost:3000`
- Worker: `http://localhost:3001`
- Postgres: `localhost:5432`

## Environment Variables

Copy `.env.example` and adjust:

- `DATABASE_URL`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `API_PORT`
- `WORKER_PORT`
- `WEB_PORT`
- `BOOTSTRAP_SECRET`
- `GEMINI_API_KEY`
- `GEMINI_MAX_CONCURRENCY`
- `GEMINI_MAX_REQUESTS_PER_MINUTE`
- `GEMINI_MAX_REQUESTS_PER_DAY`

## First-Run Expectations

- Postgres becomes healthy first
- API, worker, and web each install workspace dependencies inside their own container-local `node_modules` volume
- API exposes `/health`
- Worker exposes `/health`
- Worker emits heartbeat logs
- Web renders the platform skeleton page

## Troubleshooting

### `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`

The Compose setup should avoid this by:

- setting `CI=true` in the app containers
- using a separate `node_modules` volume per service
- forcing non-interactive module purge behavior for `pnpm install`

If you still hit it after pulling the latest branch, recreate the stack and volumes:

```bash
pnpm run docker:reset
pnpm run docker:up
```

### Postgres `locale: not found`

This warning comes from the Alpine-based Postgres image during init and does not block the Phase 1 local stack.

## Helpful Commands

```bash
pnpm run docker:up
pnpm run docker:down
pnpm run docker:logs
pnpm run docker:reset
```

## Production Guidance

Production deployment is not part of Phase 1. When the platform becomes operational:

- run behind a reverse proxy
- keep bootstrap/admin secrets out of source control
- use managed Postgres or a persistent Docker volume
- pin image versions before public deployment
