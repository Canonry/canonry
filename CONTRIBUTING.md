# Contributing to Canonry

Thanks for your interest in contributing! Canonry is FSL-1.1-ALv2 licensed and welcomes contributions.

## Setup

```bash
git clone https://github.com/ainyc/canonry.git
cd canonry
pnpm install
```

## Development

To build everything and install the `canonry` CLI globally in one step:

```bash
./canonry-install.sh
```

This runs `pnpm install`, builds all packages, and installs `canonry` globally via npm. After that, `canonry --version` should work from any directory.

Individual commands:

```bash
pnpm run typecheck          # Type-check all packages
pnpm run test               # Run test suite
pnpm run lint               # Lint all packages
pnpm run dev:web            # Run web dashboard in dev mode
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

- **API first**: every feature starts as an API capability in `packages/api-routes/`.
- **CLI required**: operator and agent workflows must be exposed through the CLI.
- **Web UI secondary**: UI support is important, but it must not block API/CLI delivery.
- Keep shared types in `packages/contracts/`.
- Keep API route plugins in `packages/api-routes/` (no app-level concerns).
- Keep provider logic in `packages/provider-*/`.
- Keep API handlers thin.

Use [`docs/README.md`](docs/README.md) as the entrypoint for roadmap, ADRs, active plans, and current reference docs.

## Before Submitting a PR

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```

All three must pass.
