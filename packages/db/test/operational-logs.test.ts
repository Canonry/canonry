import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, OperationalLogStore } from '../src/index.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-11T00:00:03.000Z'))
})
afterEach(() => vi.useRealTimers())

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-operational-logs-'))
  const dbPath = path.join(dir, 'runtime.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, dbPath }
}

function append(store: OperationalLogStore, n: number, extra: Record<string, unknown> = {}) {
  store.append({
    ts: '2026-09-11T00:00:00.000Z', level: 'info', module: 'Runner', action: `run.${n}`,
    projectId: 'project_1', runId: 'run_1', requestId: `request_${n}`, actor: 'scheduler', ...extra,
  })
}

test('persists entries, cursor namespace, and eviction state across a SQLite restart', () => {
  const { db, dbPath } = fixture()
  const first = new OperationalLogStore(db, { maxEntries: 2 })
  append(first, 1)
  append(first, 2)
  const page = first.list({ limit: 1 })
  append(first, 3)
  db.$client.close()

  const reopened = createClient(dbPath)
  migrate(reopened)
  const second = new OperationalLogStore(reopened, { maxEntries: 2 })
  expect(second.list({ limit: 10 })).toMatchObject({ retention: 'durable', dropped: 1 })
  expect(() => second.list({ limit: 1, cursor: page.nextCursor! })).toThrow(/stale/)
  reopened.$client.close()
})

test('migration 155 upgrades an already-migrated database and fresh databases carry audit identities', () => {
  const { db } = fixture()
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-operational-logs-legacy-'))
  const legacyPath = path.join(legacyDir, 'legacy.db')
  const legacy = createClient(legacyPath)
  migrate(legacy, MIGRATION_VERSIONS.filter(migration => migration.version < 155))
  migrate(legacy)
  const runtimeTable = legacy.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_logs'`)
  const auditColumns = legacy.all<{ name: string }>(sql`PRAGMA table_info(audit_log)`).map(column => column.name)
  expect(runtimeTable).toHaveLength(1)
  expect(auditColumns).toEqual(expect.arrayContaining(['credential_id', 'request_id']))
  expect(db.all<{ name: string }>(sql`PRAGMA table_info(audit_log)`).map(column => column.name))
    .toEqual(expect.arrayContaining(['credential_id', 'request_id']))
  legacy.$client.close()
  fs.rmSync(legacyDir, { recursive: true, force: true })
})

test('evicts by bounded count and age, including while idle until the next read', () => {
  const { db } = fixture()
  let now = new Date('2026-09-11T00:00:00.000Z')
  const store = new OperationalLogStore(db, { maxEntries: 2, maxAgeMs: 1_000, now: () => now })
  append(store, 1)
  append(store, 2)
  append(store, 3)
  expect(store.list({ limit: 10 }).entries.map(entry => entry.action)).toEqual(['run.2', 'run.3'])
  now = new Date('2026-09-11T00:00:02.000Z')
  expect(store.list({ limit: 10 })).toMatchObject({ entries: [], dropped: 3 })
})

test('paginates stable same-timestamp filters and rejects foreign or changed-filter cursors', () => {
  const { db } = fixture()
  const store = new OperationalLogStore(db)
  append(store, 1)
  append(store, 2)
  append(store, 3, { actor: 'cli' })
  const first = store.list({ limit: 1, actor: 'scheduler', projectId: 'project_1' })
  expect(first.entries.map(entry => entry.action)).toEqual(['run.1'])
  expect(store.list({ limit: 10, actor: 'scheduler', projectId: 'project_1', cursor: first.nextCursor! }).entries.map(entry => entry.action)).toEqual(['run.2'])
  expect(() => store.list({ limit: 10, actor: 'cli', projectId: 'project_1', cursor: first.nextCursor! })).toThrow(/filters/)
  const foreignFixture = fixture()
  const other = new OperationalLogStore(foreignFixture.db)
  other.append({ ts: '2026-09-11T00:00:01.000Z', level: 'info', module: 'x', action: 'x' })
  const foreignCursor = other.list({ limit: 1 }).entries[0]!.cursor
  expect(() => store.list({ limit: 10, cursor: foreignCursor })).toThrow(/different database/)
})

test('persists redacted bytes, validates filters, and exposes nonrecursive write capture failures', () => {
  const { db } = fixture()
  const store = new OperationalLogStore(db)
  store.append({
    ts: '2026-09-11T00:00:00.000Z', level: 'error', module: 'http', action: 'request.failed',
    msg: 'token=secret-value', requestId: 'request_1', credentialId: 'key_123', authorization: 'Bearer secret-value',
  })
  const entries = store.list({ requestId: 'request_1' }).entries
  expect(entries[0]!.context.credentialId).toBe('key_123')
  expect(JSON.stringify(entries)).not.toContain('secret-value')
  expect(JSON.stringify(db.all(sql.raw('SELECT msg, context FROM runtime_logs')))).not.toContain('secret-value')
  expect(() => store.list({ since: 'not-an-iso-time' })).toThrow()
  db.run(sql.raw(`
    CREATE TRIGGER runtime_logs_reject_insert
    BEFORE INSERT ON runtime_logs
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END
  `))
  store.append({ ts: '2026-09-11T00:00:00.000Z', level: 'info', module: 'x', action: 'x' })
  expect(store.list({ limit: 10 }).captureErrors).toBe(1)
  db.run(sql.raw('DROP TABLE runtime_logs'))
  expect(() => store.list({})).toThrow()
})
