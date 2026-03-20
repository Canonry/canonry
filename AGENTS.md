# AGENTS.md

This file provides guidance for AI coding agents (Codex, Copilot, etc.).
The canonical reference is **CLAUDE.md** — read it in full before making changes.

The rules below are the most critical ones to follow without exception.

---

## Database Schema Changes (Critical)

**Every new `sqliteTable(...)` in `packages/db/src/schema.ts` MUST have a corresponding migration in `packages/db/src/migrate.ts`.**

If you add a table to the schema without a migration, it will never be created in existing databases and every query will throw `no such table` at runtime.

### Rules

1. **New table** → add `CREATE TABLE IF NOT EXISTS ...` to the `MIGRATIONS` array in `migrate.ts`. Include all indexes from the schema definition.
2. **New column** → add `ALTER TABLE ... ADD COLUMN ...` to `MIGRATIONS`. SQLite ignores duplicate `ADD COLUMN` attempts, so these are safe to re-run.
3. **Never edit `MIGRATION_SQL`** (the initial block at the top). That block bootstraps brand-new installs. All incremental changes go in the `MIGRATIONS` array only.

### Pattern

```typescript
// In packages/db/src/migrate.ts — MIGRATIONS array:

// v12: My new feature — my_new_table
`CREATE TABLE IF NOT EXISTS my_new_table (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
```

### Checklist for any schema change

- [ ] Table/column added to `schema.ts`
- [ ] Matching migration added to `MIGRATIONS` in `migrate.ts`
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass before committing

---

## Surface Priority

API → CLI → Web UI. Never block a release waiting for UI work.

## Pre-commit

```bash
pnpm typecheck && pnpm lint && pnpm test
```

All three must pass. No exceptions.

## API Stability

Never change existing endpoint paths or HTTP methods. Additive changes only.

## Versioning

Every non-documentation change requires a semver bump in both `package.json` (root) and `packages/canonry/package.json`.
