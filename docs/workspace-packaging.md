# Workspace Structure

## Purpose

This repository is a pnpm monorepo for the Canonry AEO monitoring application. The shared technical audit engine is consumed from the published `@ainyc/aeo-audit` package.

## Boundary Rules

- Do not copy source files out of the audit package repo.
- Use the published npm package in application code.
- `packages/api-routes/` contains shared Fastify route plugins — no app-level concerns.
- `packages/canonry/` is the only publishable artifact. It bundles CLI, server, job runner, and pre-built SPA.
- `apps/*` are deployment entry points (cloud). They import from `packages/*` — never the reverse.

## Workspace Layout

- `apps/api/` — cloud API entry point (imports `packages/api-routes/`)
- `apps/worker/` — cloud worker entry point
- `apps/web/` — Vite SPA source (built and bundled into `packages/canonry/assets/`)
- `packages/canonry/` — publishable npm package (`@ainyc/canonry`)
- `packages/api-routes/` — shared Fastify route plugins
- `packages/contracts/` — DTOs, enums, config-schema, error codes
- `packages/config/` — typed environment parsing
- `packages/db/` — Drizzle ORM schema, migrations, client
- `packages/provider-gemini/` — Gemini adapter
- `packages/provider-openai/` — OpenAI adapter
- `packages/provider-claude/` — Claude/Anthropic adapter
- `docs/` — product and architecture documentation

## External Dependency

The worker imports technical audit functionality from `@ainyc/aeo-audit`.
