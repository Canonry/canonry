# Deployment Parity Plan

**Status:** Planned
**Created:** 2026-03-11

## Context

Canonry has three deployment modes (local npm, Docker/PaaS, future cloud split) but no mechanism to ensure they stay consistent. Non-technical users will one-click deploy on Railway/Render; technical users run locally. Today, env vars are documented only in README, no platform config files exist, and CI doesn't build Docker images. This plan adds the infrastructure to keep all deployment paths tested and documented.

## Deliverables

### 1. `docker-compose.yml` (root)
Local Docker testing that mirrors exactly what Railway/Render do: single container, persistent volume at `/data`, env vars passed through. Lets developers verify Docker deploys before pushing.

```yaml
services:
  canonry:
    build: .
    ports:
      - "${CANONRY_PORT:-4100}:${CANONRY_PORT:-4100}"
    environment:
      - PORT=${CANONRY_PORT:-4100}
      - CANONRY_CONFIG_DIR=/data/canonry
      - CANONRY_API_KEY=${CANONRY_API_KEY:-}
      - GEMINI_API_KEY=${GEMINI_API_KEY:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - LOCAL_BASE_URL=${LOCAL_BASE_URL:-}
    volumes:
      - canonry-data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4100') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 10s
    restart: unless-stopped

volumes:
  canonry-data:
```

Also add `.env.example` with all supported env vars (commented out) and add `docker-compose.yml` to `.dockerignore`.

### 2. `railway.toml` (root)
Pins Railway to the correct Dockerfile (avoids guessing among four), sets health check path. Volume mount remains a manual step (Railway doesn't support it in config).

```toml
[build]
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 10
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

### 3. `render.yaml` (root)
Render Blueprint spec for one-click deploy. Includes persistent disk at `/data` and `maxInstances: 1` (SQLite single-writer constraint).

### 4. `docs/env-vars.md`
Single source of truth for all environment variables, organized by deployment mode. Derived from the Zod schemas in `packages/config/src/index.ts` and the bootstrap logic in `packages/canonry/src/commands/bootstrap.ts`. README updated to link here instead of duplicating.

### 5. `scripts/smoke-test.sh`
Bash script using only `curl` that validates a running Canonry instance:
- Health check (`/health` returns `{ status: "ok" }`)
- Auth rejection (unauthenticated request returns 401)
- If API key provided: project CRUD cycle (create, get, list, delete)

Runs against any URL -- local, Docker, Railway, Render.

### 6. CI: Docker build + smoke test job
Add to `.github/workflows/ci.yml`:
- **Path triggers**: Add `Dockerfile*`, `docker/**`, `docker-compose.yml`, `scripts/smoke-test.sh`
- **`docker-smoke` job**: Build image, start container with pinned API key, wait for healthy, run smoke test, cleanup
- **`docker-build-matrix` job** (optional): Build-only check for `Dockerfile.api`, `Dockerfile.web`, `Dockerfile.worker` to prevent rot

### 7. No code changes required
The existing `entrypoint.sh` already handles `$PORT` (Railway), `$CANONRY_CONFIG_DIR`, and provider key env vars correctly. No changes to application code, just deployment infrastructure around it.

## Files to create/modify

| File | Action |
|------|--------|
| `docker-compose.yml` | Create |
| `.env.example` | Create |
| `railway.toml` | Create |
| `render.yaml` | Create |
| `docs/env-vars.md` | Create |
| `scripts/smoke-test.sh` | Create |
| `.github/workflows/ci.yml` | Modify (add docker-smoke job + path triggers) |
| `.dockerignore` | Modify (add docker-compose.yml) |
| `README.md` | Modify (link to docs/env-vars.md, mention docker-compose) |

## Implementation order

1. `docker-compose.yml` + `.env.example` + `.dockerignore` update
2. `railway.toml` + `render.yaml`
3. `docs/env-vars.md` + README link
4. `scripts/smoke-test.sh`
5. CI workflow updates

## Verification

1. `docker compose up --build` starts and serves on :4100
2. `bash scripts/smoke-test.sh http://localhost:4100` passes without API key
3. `bash scripts/smoke-test.sh http://localhost:4100 <key>` passes with full CRUD
4. `docker compose down -v` cleans up
5. CI workflow validates via `act` or manual push to a test branch

## Future SaaS notes

The same `Dockerfile` + env var interface works for a managed service: orchestrator provisions a container, sets env vars (`CANONRY_API_KEY`, provider keys, `CANONRY_CONFIG_DIR`), starts it, polls `/health` for readiness. No code changes needed -- env vars are the control plane interface. `docs/env-vars.md` becomes the orchestrator's contract.
