# Product Plan

## Goal

Build a self-hosted AEO analysis and monitoring application on top of the published `@ainyc/aeo-audit` package.

## Phase 1 Scope

- Add a workspace skeleton for API, worker, web, and shared packages
- Add platform architecture and maintenance documentation
- Add workspace-level CI for the monitoring product
- Add Docker Compose for a placeholder local stack

## Product Direction

- OSS self-hosting first
- SaaS-ready architecture later
- Gemini is the first provider
- Technical readiness and answer visibility remain separate score families
- Manual keyword import and manual competitor setup in the first product release
- The monitoring app is the primary product surface
- The technical audit engine is consumed from the published `@ainyc/aeo-audit` package

## Planned Phases

### Phase 1

- Docs, architecture diagrams, workspace scaffolding, external audit-package adapter, and workspace CI

### Phase 2

- Postgres schema, API skeleton behavior, worker lifecycle, bootstrap flow

### Phase 3

- Gemini answer visibility execution, quotas, retries, persistence

### Phase 4

- Site audit orchestration, trend aggregation, partial-result handling

### Phase 5

- Minimal Vite dashboard wired to stable API contracts

### Phase 6

- Export flows, self-host polish, CI smoke coverage, release hardening
