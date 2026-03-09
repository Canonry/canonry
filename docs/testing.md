# Testing Guide

## Workspace Checks

Run these before opening a PR:

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

## Docker Smoke Test

```bash
cp .env.example .env
pnpm run docker:up
curl http://localhost:3000/health
curl http://localhost:3001/health
```

The web app should render a placeholder landing page at `http://localhost:4173`.

## Dependency Verification Checklist

1. Run workspace checks.
2. Confirm `apps/worker/src/audit-client.ts` still imports from `@ainyc/aeo-audit`.
3. Confirm worker adapter tests still pass against the published package.
