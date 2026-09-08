# Contributing to Canonry

Thanks for your interest in contributing! Canonry is FSL-1.1-ALv2 licensed and welcomes contributions.

## Setup

```bash
git clone https://github.com/Canonry/canonry.git
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
pnpm check                  # Fast lint of changed JS/TS files
pnpm lint:staged            # Fast lint of staged JS/TS content
pnpm --filter @ainyc/canonry-contracts typecheck  # Type-check one affected package
pnpm exec vitest run --project contracts        # Run one affected test project
pnpm verify                 # Optional full workspace check
pnpm build:cli              # CLI/server bundle only
pnpm build:web              # Cached dashboard build and asset copy
pnpm build                  # Complete publishable package
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

`@canonry/canonry` is the primary npm package. `@ainyc/canonry` is also published at the same versions for compatibility. All other packages are internal workspace dependencies bundled by tsup at build time.

## Guidelines

- **API first**: every feature starts as an API capability in `packages/api-routes/`.
- **CLI required**: operator and agent workflows must be exposed through the CLI.
- **Web UI secondary**: UI support is important, but it must not block API/CLI delivery.
- Keep shared types in `packages/contracts/`.
- Keep API route plugins in `packages/api-routes/` (no app-level concerns).
- Keep provider logic in `packages/provider-*/`.
- Keep API handlers thin.

Use [`docs/README.md`](docs/README.md) as the entrypoint for the current reference docs.

## Before Submitting a PR

```bash
pnpm check
```

Run relevant tests and package typechecks for behavior changes. After another edit or rebase, rerun only the affected checks.
CI runs full typechecks, lint, tests, generated-file checks, builds, and release guards.
`pnpm verify` remains available for a full local check. It is not required before each commit or push.

`pnpm install` installs the Git hooks. Ordinary code commits lint staged JS/TS content, including partially staged files.
It runs syntax rules and repository guards without loading TypeScript projects. It never changes files or the index.
Staged checks and `pnpm check` share cached clean results across Git worktrees. Use `--no-cache` to force a fresh check.
Documentation-only commits skip ESLint. The commit-message hook checks Conventional Commits. Pushes run the three drift gates below.

See [the testing guide](docs/testing.md) for the local and CI commands.

API changes need `pnpm gen`. Review and stage the generated files before `pnpm gen:check`.
The check compares temporary output and the Git index without changing either.
Pre-push runs the three drift gates and requires their inputs and output to match the pushed commit.
ESLint configuration or local rule changes trigger full typed lint. Ordinary commits keep the cached staged-file check.
Codegen and dashboard builds reuse cached results only when their inputs and output contents match.
