# db

## Purpose

Drizzle ORM schema, migrations, and database client. SQLite locally (via better-sqlite3), Postgres for cloud. Auto-migrates on startup. Tables cover projects, runs, snapshots, integrations, and system tracking.

## Key Files

| File | Role |
|------|------|
| `src/schema.ts` | All table definitions (`sqliteTable`) with indexes and constraints |
| `src/migrate.ts` | Migration runner — `MIGRATION_SQL` (initial bootstrap) + `MIGRATION_VERSIONS` array (versioned, incremental) plus the `_migrations` tracking table |
| `src/client.ts` | `createClient()` factory — WAL journal, foreign keys, 5s busy timeout |
| `src/sentiment-repository.ts` | Transactional sentiment definitions, enablement epochs, completion receipts, job admission, leases, attempt and result storage |
| `src/json.ts` | `parseJsonColumn<T>(value, fallback)` — safe JSON deserialization for DB columns |
| `src/index.ts` | Re-exports all public API |
| `src/operational-logs.ts` | Bounded durable runtime diagnostics; sanitized, cursor-bound reads. Diagnostic writes/pruning use zero lock-wait and synchronously restore the application's busy timeout; failed capture falls back to an in-memory error counter. |

## Table Groups

- **Core domain**: projects, queries, competitors, runs, querySnapshots, auditLog
- **Simple measurement provenance**: `simpleMeasurementDefinitions` stores dispatch inputs for new official simple runs. Migration 150 leaves historical runs untouched. A composite project/run foreign key prevents cross-project captures. An UPDATE trigger protects the frozen definition. Run deletion cascades to its definition.
- **Scheduling**: schedules, notifications, webhooks
- **Integrations**: googleConnections (metadata only — credentials in config.yaml), gscData, gscDailyTotals (property-level daily totals — headline/trend source), gscQueryDailyTotals (per-query daily totals — the accurate per-query impressions/position source), urlInspections, gscCoverage, gscTraffic, bingConnections, bingUrlInspections, bingKeywordStats, ga4Connections (metadata only — credentials in config.yaml), ga4TrafficSnapshots, gaDailyTotals (property-level daily totals — deduplicated `users`, unlike the per-page snapshots), ga4AiReferrals, ga4Summaries, gaSocialReferrals
- **System**: apiKeys, usageCounters
- **Aero history**: migration 159 adds `agent_conversations` for inactive transcripts. The unique `agent_sessions.projectId` slot remains active; swaps are transactional. No existing transcript is rewritten.
- **Managed personal Aero**: migration 167 adds `managed_agent_sessions`, uniquely keyed by project, actor and connection, plus one-use `managed_agent_turn_grants`. Neither stores inference credentials. They do not change operator history or memory. See `docs/managed-chatgpt-aero.md`.
- **Aero ledgers**: `llm_usage_events.agent_session_id` and `agent_tool_events.agent_session_id` hold the Aero conversation id, which lives in `agent_sessions` while active and in `agent_conversations` once archived. Migration 165 rebuilt both tables without a foreign key on it (project and run keys unchanged), so rows stay attributed to their conversation. Deleting a conversation clears the id in `api-routes/agent-conversations.ts`.
- **Aero model upgrade**: migration 158 moved existing DeepInfra GLM-5.2 sessions to DeepSeek-V4-Flash once (the DeepInfra provider has since been removed; its rows resume on the current provider). Later explicit selections survive subsequent migrations and hydration; transcript, queue, and activity timestamps stay intact.
- **Provider batch dispatch**: migration 162 adds `provider_batches` and `provider_batch_requests`, plus nullable/defaulted dispatch columns on `projects`, `runs`, and `query_snapshots`. A batch row is written `submitting` before the submit call and is never resubmitted. Its composite project/run foreign key cascades with the run. `provider_batch_requests.query_id` is SET NULL so a deleted query cannot make ingest write a dangling id. Both SET NULL child columns (`provider_batch_requests.query_id`, `query_snapshots.provider_batch_id`) are indexed so a parent delete does not scan the child table. See `docs/batch-mode.md`.
- **Upgrade tests seed physical columns**: a test that migrates to an older version must seed with `test/legacy-rows.ts` (raw SQL), not Drizzle — Drizzle names every current column, so a later migration adding one breaks the seed.
- **Delegated MCP identity**: `apiKeys.delegatedUserId` is internal, nullable for historical/ordinary keys, and cascade-deleted with its user (migration 154). It retains the originating account across the MCP-to-REST hop; never derive this identity from a key name or expose it as client-settable input.

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
- A new table's entry creates the table plus every index from its schema definition; a new column uses `ALTER TABLE ... ADD COLUMN`.
- Removing a column or table: SQLite does not support `DROP COLUMN` on older versions; document the intent and leave the entry's `statements[]` as a comment-only no-op if needed.
- Duplicate or out-of-order `version` values break the skip-already-applied logic.
- A new `projects` column is safe once every upgrade test seeds through `test/legacy-rows.ts` (see "Upgrade tests seed physical columns"). A test that seeds an older schema through Drizzle breaks on it; fix that test rather than moving the setting to a side table.

Checklist: table/column added to `schema.ts`; matching `MIGRATION_VERSIONS` entry in `migrate.ts`; relevant schema and migration tests pass locally (full workspace checks run in CI).

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

The longer-term direction is to migrate the remaining JSON columns to `mode: 'json'` (and boolean columns to `mode: 'boolean'`) table by table. New tables/columns should use the native modes from day one. Boolean columns on those legacy tables still coerce by hand (`row.x === 1` on read, `x ? 1 : 0` on write).

#### Migrating a table to native modes

1. Update `packages/db/src/schema.ts`: switch JSON columns to `text(col, { mode: 'json' }).$type<T>().notNull().default([])` (or `{}`), boolean columns to `integer(col, { mode: 'boolean' }).notNull().default(false)`.
2. No DB migration is needed — the storage format is unchanged. Drizzle parses/stringifies in TS.
3. Update every read site that called `parseJsonColumn<T>(row.X, ...)` to direct access `row.X`.
4. Update every write site that wrapped values in `JSON.stringify(...)` to pass the raw typed value.
5. Update every boolean read site (`row.X === 1`) and write site (`x ? 1 : 0`) to use the boolean directly.
6. Add tests that round-trip a write → read to confirm the type flows end-to-end. (`packages/api-routes/test/db-dto-coverage.test.ts` catches schema drift; round-trip tests catch coercion bugs.)
7. `JSON.parse` is still fine for HTTP request bodies, config files, and other non-DB sources.

### Traffic event receipts

Traffic delivery adapters use `traffic_event_receipts` for durable idempotency.
Claim `(source_id, event_id)` in the same transaction as rollup writes and
acknowledge an upstream buffer only after commit. Set `expires_at` to cover the
transport's complete replay or redelivery horizon; do not reuse the bounded
`traffic_sources.last_event_ids` pull-overlap ring for pushed or buffered events.

### Transaction boundaries

Multi-table writes must be wrapped in a single `db.transaction()` call. `writeAuditLog()` takes the transaction (`Pick<DatabaseClient, 'insert'>`), so the audit write commits with the change.

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
- **Treating runtime logs as audit history** — `OperationalLogStore` is bounded,
  sanitizes every projection, and retention loss is explicit in its DTO.

## See Also

- `docs/data-model.md` — ER diagram and table relationships
- `docs/architecture.md` — how the DB fits into the system
- `packages/contracts/` — DTOs that map to DB rows

## Sentiment storage

Migration 164 adds immutable evaluator definitions, off-by-default project settings,
monotonic completion receipts, jobs and selection membership, unique assessment work,
results, and per-attempt receipts. Persist `recordSentimentCompletion` in the same
transaction as the winning status write of every run finalizer: `finalizeRun`,
`finalizeBatchRun` and `finalizeRunFill`. Enablement uses the
receipt sequence high-water mark, never the source run start time.

`SentimentRepository` owns immediate transactions for admission, leases, retries,
cancellation, and per-install request/token reservations. Use a unique owner token
for each claim. The outbound caller must check install readiness again before
`startAttempt`; repository checks project enablement and epoch. Call
`suspendInstall` on an observed install disablement and `resumeInstall` before
reconciliation after reenablement; the persisted observation survives restart and
advances the admission boundary past the disabled interval. Attempt reservations
are conservative across crashes; unknown usage stays on the receipt, while reported
usage is written once into `llm_usage_events` under provider `typesafe`.

Assessments are unique by project, snapshot, source hash, subject hash and evaluation
definition. Job membership retains its cancellation epoch when an explicit backfill
reuses or retries the assessment; reenabling alone never restarts canceled work.
Source/project composite foreign keys prevent cross-project evidence and cascade
source deletion. JSON columns retain frozen inputs and exact usage edges; reads must
validate them through sentiment contracts before returning public DTOs. Credentials
and raw provider failures never belong in these records.

`sentiment_jobs` keeps per-bucket member counts (`pending_items`, `running_items`,
`completed_items`, `failed_items`, `canceled_items`). Each status transition shifts
one bucket in the jobs that still follow the assessment, and admission and
cancellation recount once, so a claim costs the number of jobs sharing an
assessment, not their size. `sentiment_settings.reconciled_sequence` is the
reconcile cursor (each receipt is reconciled once per epoch), and `dispatch_turn`
rotates claims across projects. `sentiment_work_items.dispatch_priority`
(0 automatic, 1 backfill) puts new sweeps ahead of backfills.
`sentiment_dispatch_state` is the single install-wide pause row after a provider
429 or 401/403: reason, next dispatch time, rate-limit streak and a one-way
credential fingerprint, never the key. A refused attempt is requeued outside the
retry budget by advancing `attempt_budget_start`. Partial index
`idx_sentiment_work_lease` serves the concurrency count, and
`idx_sentiment_work_source(run_id, snapshot_id)` serves the snapshot cascade.
