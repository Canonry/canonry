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

## End-to-End Verification (Phase 2)

1. `canonry init` creates `~/.canonry/` with SQLite DB and auto-generated API key
2. `canonry serve` starts server, dashboard loads
3. `canonry project create` / `keyword add` / `run` workflow completes
4. `canonry export` produces valid `canonry.yaml`
5. `canonry apply` is idempotent and records audit log entries
6. Dashboard shows visibility data with readiness marked "Unavailable"
