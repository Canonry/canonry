# Contributing to Canonry

## Setup

```bash
git clone <repo-url>
cd canonry
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
```

## Repo Rules

- Keep this repo focused on the monitoring product.
- Do not vendor code from `@ainyc/aeo-audit`; use the published npm package.
- Put cross-service DTOs in `packages/contracts`.
- Keep API handlers thin and push orchestration into shared services as the backend grows.

## Validation

Before opening a PR:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
```

For Docker/local stack changes:

```bash
cp .env.example .env
pnpm run docker:up
```
