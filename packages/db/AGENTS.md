# db

## Purpose

Drizzle ORM schema, migrations, and database client. SQLite locally (via better-sqlite3), Postgres for cloud. Auto-migrates on startup. Tables cover projects, runs, snapshots, integrations, and system tracking.

## Key Files

| File | Role |
|------|------|
| `src/schema.ts` | All table definitions (`sqliteTable`) with indexes and constraints |
| `src/migrate.ts` | Migration runner — `MIGRATION_SQL` (initial bootstrap) + `MIGRATION_VERSIONS` array (versioned, incremental) plus the `_migrations` tracking table |
| `src/client.ts` | `createClient()` factory — WAL journal, foreign keys, 5s busy timeout |
| `src/json.ts` | `parseJsonColumn<T>(value, fallback)` — safe JSON deserialization for DB columns |
| `src/index.ts` | Re-exports all public API |

## Table Groups

- **Core domain**: projects, queries, competitors, runs, querySnapshots, auditLog
- **Scheduling**: schedules, notifications, webhooks
- **Integrations**: googleConnections (metadata only — credentials in config.yaml), gscData, gscDailyTotals (property-level daily totals — headline/trend source), urlInspections, gscCoverage, gscTraffic, bingConnections, bingUrlInspections, bingKeywordStats, ga4Connections (metadata only — credentials in config.yaml), ga4TrafficSnapshots, ga4AiReferrals, ga4Summaries, gaSocialReferrals
- **System**: apiKeys, usageCounters

## Patterns

### Schema changes (Critical)

Every new table/column in `schema.ts` **MUST** have a matching migration in `migrate.ts`. Migrations live in the `MIGRATION_VERSIONS` array as `{ version, name, statements[] }` entries — find the highest existing `version` and add the next integer:

```typescript
// In migrate.ts — append to MIGRATION_VERSIONS:
{
  version: 47,
  name: 'my-new-feature',
  statements: [
    `CREATE TABLE IF NOT EXISTS my_new_table (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      value       TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_my_new_table_project ON my_new_table(project_id)`,
  ],
},
```

How the runner uses it:

- `_migrations` records each successfully applied `version`. On boot the runner reads `MAX(version)` and skips anything already recorded — migrations do not replay.
- Each version's statements + the `_migrations` row commit in a single SQLite transaction. A non-recoverable failure rolls the whole version back so the next boot retries cleanly. **Make every statement idempotent** (`IF NOT EXISTS`, `IF EXISTS`, `UPDATE … WHERE` guards, or `ALTER TABLE ADD COLUMN` whose duplicate-column error the runner swallows) so a retry is safe.
- Never edit a previously-shipped version's `statements[]`. Old DBs already have it recorded as applied and won't run it again — write a new version that fixes things up forward.
- Mirror the table in `schema.ts` for grep-ability (the runner doesn't query Drizzle, but other code paths might).

### JSON column reads

The `projects` table uses Drizzle's native `text({ mode: 'json' }).$type<T>()` — column values are auto-parsed by Drizzle on read and auto-stringified on write. Direct property access returns the typed value; no helper needed:

```typescript
// ✅ Correct — Drizzle auto-parses; type comes from $type<>
const locations = project.locations   // LocationContext[]
const labels = project.labels         // Record<string, string>
const enabled = project.autoExtractBacklinks // boolean (integer mode: 'boolean')
```

Other tables (`runs`, `querySnapshots`, `schedules`, `notifications`, GA/GSC/Bing rollups, agent sessions, traffic sources, etc.) still store JSON as raw `text(...)` for the moment. Reads from those columns use the typed helper:

```typescript
import { parseJsonColumn } from '@ainyc/canonry-db'

// ✅ Correct — handles null, empty string, invalid JSON for the legacy raw-text columns
const breakdown = parseJsonColumn<HealthSnapshotDto['providerBreakdown']>(row.providerBreakdown, {})
const overlap = parseJsonColumn<string[]>(snap.competitorOverlap, [])

// ❌ Wrong — fragile, no fallback
const overlap = JSON.parse(snap.competitorOverlap || '[]') as string[]
```

The longer-term direction is to migrate the remaining JSON columns to `mode: 'json'` (and boolean columns to `mode: 'boolean'`) table by table. New tables/columns should use the native modes from day one.

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
- **Editing `MIGRATION_SQL`** (the initial block) — all incremental changes go in `MIGRATION_VERSIONS` only.
- **Reusing or editing a shipped `version`** — old DBs have it recorded as applied; the runner will skip it. Always add a new version.
- **Non-idempotent statements inside a version** — partial failure mid-version rolls back, but if you've split work across versions, an earlier version's data write may have already committed. Keep each statement re-runnable.
- **Using raw `JSON.parse` on DB column values** — use `parseJsonColumn()` instead.
- **Doing async I/O inside SQLite transactions** — better-sqlite3 requires synchronous transactions.
- **Read-then-write for counters** — use INSERT ON CONFLICT UPDATE instead.

## See Also

- `docs/data-model.md` — ER diagram and table relationships
- `docs/architecture.md` — how the DB fits into the system
- `packages/contracts/` — DTOs that map to DB rows
