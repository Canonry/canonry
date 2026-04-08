# db

## Purpose

Drizzle ORM schema, migrations, and database client. SQLite locally (via better-sqlite3), Postgres for cloud. Auto-migrates on startup. Tables cover projects, runs, snapshots, integrations, and system tracking.

## Key Files

| File | Role |
|------|------|
| `src/schema.ts` | All table definitions (`sqliteTable`) with indexes and constraints |
| `src/migrate.ts` | Migration runner — `MIGRATION_SQL` (initial bootstrap) + `MIGRATIONS` array (incremental) |
| `src/client.ts` | `createClient()` factory — WAL journal, foreign keys, 5s busy timeout |
| `src/json.ts` | `parseJsonColumn<T>(value, fallback)` — safe JSON deserialization for DB columns |
| `src/index.ts` | Re-exports all public API |

## Table Groups

- **Core domain**: projects, keywords, competitors, runs, querySnapshots, auditLog
- **Scheduling**: schedules, notifications, webhooks
- **Integrations**: googleConnections, gscData, urlInspections, gscCoverage, gscTraffic, bingConnections, bingUrlInspections, bingKeywordStats, ga4Connections, ga4TrafficSnapshots, ga4AiReferrals, ga4Summaries, gaSocialReferrals
- **System**: apiKeys, usageCounters

## Patterns

### Schema changes (Critical)

Every new table/column in `schema.ts` **MUST** have a matching migration in `migrate.ts`:

```typescript
// In migrate.ts — MIGRATIONS array:
// v12: My new feature — my_new_table
`CREATE TABLE IF NOT EXISTS my_new_table (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
```

### JSON column parsing

Many text columns store JSON. Always use the typed helper:

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct — handles null, empty string, invalid JSON
const locations = parseJsonColumn<LocationContext[]>(project.locations, [])

// ❌ Wrong — fragile, no fallback
const locations = JSON.parse(project.locations || '[]') as LocationContext[]
```

### Transaction boundaries

```typescript
// 1. Do async I/O BEFORE the transaction
const urlCheck = await resolveWebhookTarget(url)
if (!urlCheck.ok) throw validationError(urlCheck.message)

// 2. All writes atomically
app.db.transaction((tx) => {
  tx.update(projects).set({ ... }).where(...).run()
  writeAuditLog(tx, { ... }) // audit log INSIDE transaction
})

// 3. Fire callbacks AFTER commit
opts.onScheduleUpdated?.('upsert', projectId)
```

### Atomic counters

```typescript
db.insert(usageCounters).values({
  id: crypto.randomUUID(), scope, period, metric, count: 1, updatedAt: now,
}).onConflictDoUpdate({
  target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
  set: { count: sql`${usageCounters.count} + 1`, updatedAt: now },
}).run()
```

## Common Mistakes

- **Adding a table to `schema.ts` without a migration in `migrate.ts`** — table will never be created, queries throw `no such table`.
- **Editing `MIGRATION_SQL`** (the initial block) — all incremental changes go in the `MIGRATIONS` array only.
- **Using raw `JSON.parse` on DB column values** — use `parseJsonColumn()` instead.
- **Doing async I/O inside SQLite transactions** — better-sqlite3 requires synchronous transactions.
- **Read-then-write for counters** — use INSERT ON CONFLICT UPDATE instead.

## See Also

- `docs/data-model.md` — ER diagram and table relationships
- `docs/architecture.md` — how the DB fits into the system
- `packages/contracts/` — DTOs that map to DB rows
