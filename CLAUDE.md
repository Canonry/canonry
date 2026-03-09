# CLAUDE.md

## Project Overview

`canonry` is the monitoring application that sits on top of the published `@ainyc/aeo-audit` npm package. This repo owns the product surface, not the audit package itself.

## Workspace Map

```text
apps/api/             Fastify API
apps/worker/          Background worker and audit/provider adapters
apps/web/             Vite dashboard
packages/contracts/   Shared DTOs and enums
packages/config/      Typed environment parsing
packages/db/          Database placeholder
packages/provider-gemini/ Gemini adapter placeholder
docs/                 Architecture, testing, self-hosting, ADRs
```

## Commands

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run dev:api
pnpm run dev:worker
pnpm run dev:web
pnpm run docker:up
```

## Dependency Boundary

- Use `@ainyc/aeo-audit` as an external dependency.
- Do not copy source files out of the audit package repo into this repo.
- Any use of the audit engine should go through explicit adapters in `apps/worker`.

## Maintenance Guidance

- Keep shared shapes in `packages/contracts`.
- Keep environment parsing in `packages/config`.
- Keep provider logic in `packages/provider-gemini`.
- Keep API handlers thin.
- Keep the monitoring app independent from the audit package repo except for the published npm dependency.

## Improvement Order

1. Shared contracts and docs
2. Backend services and worker logic
3. Provider execution and persistence
4. UI expansion

## CI Guidance

- This repo has validation CI only; there is no publish workflow here.
- Keep explicit job permissions.
- Run `typecheck`, `test`, and `lint` across the full workspace on PRs.
