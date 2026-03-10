# Contributing to Canonry

Thanks for your interest in contributing! Canonry is AGPL-3.0 licensed and welcomes contributions.

## Setup

```bash
git clone https://github.com/ainyc/canonry.git
cd canonry
pnpm install
```

## Development

```bash
pnpm run typecheck          # Type-check all packages
pnpm run test               # Run test suite
pnpm run lint               # Lint all packages
pnpm run dev:web            # Run web dashboard in dev mode
```

To test the full stack locally:

```bash
pnpm --filter @ainyc/canonry run build
node packages/canonry/bin/canonry.mjs init
node packages/canonry/bin/canonry.mjs serve
```

## Project Structure

```
packages/canonry/         Single publishable npm package (CLI + server + bundled SPA)
packages/api-routes/      Shared Fastify route plugins
packages/contracts/       DTOs, enums, config schema
packages/db/              Drizzle ORM schema + migrations (SQLite)
packages/provider-*/      Provider adapters (Gemini, OpenAI, Claude, local)
apps/web/                 Vite SPA source (bundled into packages/canonry/assets/)
```

Only `@ainyc/canonry` is published to npm. All other packages are internal workspace dependencies bundled by tsup at build time.

## Guidelines

- **Surface parity**: every feature must work across CLI, API, and web dashboard.
- Keep shared types in `packages/contracts/`.
- Keep API route plugins in `packages/api-routes/` (no app-level concerns).
- Keep provider logic in `packages/provider-*/`.
- Keep API handlers thin.

## Before Submitting a PR

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

All three must pass.
