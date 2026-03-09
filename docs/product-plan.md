# Product Plan

## Goal

Build an open-source AEO monitoring tool that a technical analyst can install globally and use immediately. Future cloud-hosted version with usage-based tiers.

## Product Direction

- OSS self-hosting first, SaaS-ready architecture from day one
- Gemini is the first provider
- CLI for setup, UI for analysis
- Config-as-code (`canonry.yaml`) for agent/AI-first workflows
- API-complete: everything the CLI and UI can do goes through the API
- Single process locally (no Docker, no Postgres, no message queue)
- Technical readiness and answer visibility remain separate score families

## Phase 1 (Complete)

- Docs, architecture diagrams, workspace scaffolding
- External audit-package adapter
- Workspace CI (typecheck, test, lint)
- Mock web dashboard with design system

## Phase 2 (Current)

- Publishable `@ainyc/canonry` npm package with bundled SPA and CLI
- `canonry init` + `canonry serve` — one command to start
- SQLite database with Drizzle ORM and auto-migration
- Project CRUD, keyword/competitor management via CLI and API
- Answer visibility runs against Gemini (the core value)
- Raw observation snapshots with computed transitions
- Audit log for all config mutations
- Snapshot history, diff, and timeline endpoints
- Config-as-code apply/export
- Per-project scoped usage counters
- OpenAPI spec generation
- Same auth path for local and cloud

See [phase-2-design.md](./phase-2-design.md) for the full architecture plan.

## Phase 3

- Site audit runs + Technical Readiness scores
- Scheduling / cron
- MCP server for AI agents
- Webhooks and SSE events

## Phase 4+

- Cloud deployment, Postgres mode
- Multi-tenancy and workspaces
- Billing integration (Stripe)
