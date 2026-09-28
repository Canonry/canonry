import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  projects,
  providerBatchRequests,
  providerBatches,
  querySnapshots,
  queries,
  runs,
  type DatabaseClient,
} from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v162 adds the storage for provider batch dispatch (#1201): the per-project
// preference, the per-run frozen modes and deferred sync errors, per-snapshot
// dispatch provenance and usage, and the two batch ledgers. Every change is a
// nullable or defaulted column or a new table, so rows written before it keep
// reading exactly as they did.

const BATCH_VERSION = 162
const NOW = '2026-09-24T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-batches-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, versions)
  return db
}

function columns(db: DatabaseClient, table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string; notnull: number; dflt_value: string | null }>
}

function seedRun(db: DatabaseClient): { projectId: string; runId: string } {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'running', trigger: 'scheduled', createdAt: NOW,
  }).run()
  return { projectId, runId }
}

function seedBatch(db: DatabaseClient, projectId: string, runId: string): string {
  const id = crypto.randomUUID()
  db.insert(providerBatches).values({
    id,
    projectId,
    runId,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    status: 'submitting',
    requestCount: 2,
    quotaScope: `${projectId}:claude`,
    quotaPeriod: '2026-09-24',
    quotaReserved: 2,
    deadlineAt: '2026-09-25T00:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return id
}

describe('provider batch storage (v162)', () => {
  it('is the newest migration version', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === BATCH_VERSION)?.name).toBe('provider-batch-dispatch')
  })

  it('adds the dispatch columns with the documented nullability and defaults', () => {
    const db = tempDb()

    const project = columns(db, 'projects').find(column => column.name === 'provider_dispatch_modes')
    expect(project).toMatchObject({ notnull: 1, dflt_value: "'{}'" })

    const runColumns = columns(db, 'runs')
    expect(runColumns.find(column => column.name === 'provider_dispatch_modes')).toMatchObject({ notnull: 0 })
    expect(runColumns.find(column => column.name === 'pending_provider_errors')).toMatchObject({ notnull: 0 })

    const snapshotColumns = columns(db, 'query_snapshots')
    for (const name of ['dispatch_mode', 'provider_batch_id', 'stop_reason', 'usage']) {
      expect(snapshotColumns.find(column => column.name === name), name).toMatchObject({ notnull: 0, dflt_value: null })
    }
  })

  it('upgrades a v161 database without touching existing rows', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < BATCH_VERSION))
    const projectId = 'legacy-project'
    const runId = 'legacy-run'
    insertLegacyProject(db, { id: projectId, createdAt: NOW })
    insertLegacyRow(db, 'runs', { id: runId, project_id: projectId, status: 'completed', created_at: NOW })
    insertLegacyRow(db, 'query_snapshots', {
      id: 'legacy-snapshot', run_id: runId, query_text: 'best widgets', provider: 'claude', citation_state: 'not-cited', created_at: NOW,
    })

    migrate(db)

    expect(db.select({ modes: projects.providerDispatchModes }).from(projects).where(eq(projects.id, projectId)).get())
      .toEqual({ modes: {} })
    expect(db.select({ modes: runs.providerDispatchModes, pending: runs.pendingProviderErrors }).from(runs).where(eq(runs.id, runId)).get())
      .toEqual({ modes: null, pending: null })
    expect(db.select({
      dispatchMode: querySnapshots.dispatchMode,
      providerBatchId: querySnapshots.providerBatchId,
      stopReason: querySnapshots.stopReason,
      usage: querySnapshots.usage,
    }).from(querySnapshots).where(eq(querySnapshots.id, 'legacy-snapshot')).get())
      .toEqual({ dispatchMode: null, providerBatchId: null, stopReason: null, usage: null })
  })

  it('round-trips the JSON columns through Drizzle', () => {
    const db = tempDb()
    const { projectId, runId } = seedRun(db)
    db.update(projects).set({ providerDispatchModes: { claude: 'batch', openai: 'sync' } }).where(eq(projects.id, projectId)).run()
    db.update(runs).set({
      providerDispatchModes: { claude: 'batch' },
      pendingProviderErrors: { openai: '[provider-openai] 429 rate limited' },
    }).where(eq(runs.id, runId)).run()
    const batchId = seedBatch(db, projectId, runId)
    const usage = {
      inputTokens: 1200, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 350, searchCount: 2,
      pricingTier: 'batch' as const, estimatedCostMicros: 21_500, priceSource: 'default' as const,
    }
    db.insert(querySnapshots).values({
      id: 'batch-snapshot', runId, queryText: 'best widgets', provider: 'claude', citationState: 'cited',
      dispatchMode: 'batch', providerBatchId: batchId, stopReason: 'end_turn', usage, createdAt: NOW,
    }).run()

    expect(db.select({ modes: projects.providerDispatchModes }).from(projects).where(eq(projects.id, projectId)).get())
      .toEqual({ modes: { claude: 'batch', openai: 'sync' } })
    expect(db.select({ modes: runs.providerDispatchModes, pending: runs.pendingProviderErrors }).from(runs).where(eq(runs.id, runId)).get())
      .toEqual({ modes: { claude: 'batch' }, pending: { openai: '[provider-openai] 429 rate limited' } })
    expect(db.select({ usage: querySnapshots.usage, mode: querySnapshots.dispatchMode }).from(querySnapshots)
      .where(eq(querySnapshots.id, 'batch-snapshot')).get())
      .toEqual({ usage, mode: 'batch' })
  })

  it('defaults the batch counters and reservation release to zero', () => {
    const db = tempDb()
    const { projectId, runId } = seedRun(db)
    const batchId = seedBatch(db, projectId, runId)
    expect(db.select().from(providerBatches).where(eq(providerBatches.id, batchId)).get()).toMatchObject({
      ingestedCount: 0,
      recordedCount: 0,
      quotaReleased: 0,
      providerBatchId: null,
      fillId: null,
      submittedAt: null,
      endedAt: null,
      ingestedAt: null,
      resultsExpireAt: null,
      cancelRequestedAt: null,
      error: null,
    })
  })

  it('refuses a batch whose run belongs to another project', () => {
    const db = tempDb()
    const { runId } = seedRun(db)
    const other = seedRun(db)
    expect(() => seedBatch(db, other.projectId, runId)).toThrow(/FOREIGN KEY/i)
  })

  it('keeps one request row per slot in a batch', () => {
    const db = tempDb()
    const { projectId, runId } = seedRun(db)
    const batchId = seedBatch(db, projectId, runId)
    const request = {
      batchId, executionId: 'execution-a', queryText: 'best widgets', requestedModel: 'claude-sonnet-4-6',
    }
    db.insert(providerBatchRequests).values({ id: crypto.randomUUID().replace(/-/g, ''), ...request }).run()
    expect(() => db.insert(providerBatchRequests).values({ id: crypto.randomUUID().replace(/-/g, ''), ...request }).run())
      .toThrow(/UNIQUE/i)
  })

  it('cascades a run delete to its batches and their requests, and detaches recorded snapshots', () => {
    const db = tempDb()
    const { projectId, runId } = seedRun(db)
    const batchId = seedBatch(db, projectId, runId)
    db.insert(providerBatchRequests).values({
      id: 'a'.repeat(32), batchId, executionId: 'execution-a', queryText: 'best widgets', requestedModel: 'claude-sonnet-4-6',
      requestedContext: { label: 'north', city: 'North', region: 'NC', country: 'US' },
    }).run()
    db.insert(querySnapshots).values({
      id: 'recorded', runId, queryText: 'best widgets', provider: 'claude', citationState: 'cited',
      dispatchMode: 'batch', providerBatchId: batchId, createdAt: NOW,
    }).run()

    // Deleting only the batch row keeps the answer it recorded.
    db.delete(providerBatches).where(eq(providerBatches.id, batchId)).run()
    expect(db.select({ providerBatchId: querySnapshots.providerBatchId }).from(querySnapshots).get()).toEqual({ providerBatchId: null })
    expect(db.select().from(providerBatchRequests).all()).toEqual([])

    const second = seedBatch(db, projectId, runId)
    db.insert(providerBatchRequests).values({
      id: 'b'.repeat(32), batchId: second, executionId: 'execution-b', queryText: 'widget repair', requestedModel: 'claude-sonnet-4-6',
    }).run()
    db.delete(runs).where(eq(runs.id, runId)).run()
    expect(db.select().from(providerBatches).all()).toEqual([])
    expect(db.select().from(providerBatchRequests).all()).toEqual([])
  })

  it('clears a request\'s query link when the tracked query is deleted, so ingest never writes a dangling id', () => {
    const db = tempDb()
    const { projectId, runId } = seedRun(db)
    db.insert(queries).values({ id: 'q-1', projectId, query: 'best widgets', createdAt: NOW }).run()
    const batchId = seedBatch(db, projectId, runId)
    db.insert(providerBatchRequests).values({
      id: 'c'.repeat(32), batchId, executionId: 'execution-a', queryId: 'q-1', queryText: 'best widgets', requestedModel: 'claude-sonnet-4-6',
    }).run()

    db.delete(queries).where(eq(queries.id, 'q-1')).run()

    expect(db.select({ queryId: providerBatchRequests.queryId, queryText: providerBatchRequests.queryText }).from(providerBatchRequests).get())
      .toEqual({ queryId: null, queryText: 'best widgets' })
  })

  it('indexes batches by status and by run for the poller and the run detail', () => {
    const db = tempDb()
    const indexes = (db.all(sql.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'provider_batches'")) as Array<{ name: string }>)
      .map(row => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_provider_batches_status', 'idx_provider_batches_run']))
  })

  // Both SET NULL foreign keys need an index on the child column: without one,
  // SQLite applies each parent delete (a query, or a batch cascading from its
  // run) by scanning the whole child table, and both tables only grow.
  it('indexes the child side of both SET NULL foreign keys', () => {
    const db = tempDb()
    const indexColumns = (name: string): string[] =>
      (db.all(sql.raw(`PRAGMA index_info('${name}')`)) as Array<{ name: string }>).map(row => row.name)

    expect(indexColumns('idx_provider_batch_requests_query')).toEqual(['query_id'])
    expect(indexColumns('idx_snapshots_provider_batch')).toEqual(['provider_batch_id'])

    const plan = (statement: string): string =>
      (db.all(sql.raw(`EXPLAIN QUERY PLAN ${statement}`)) as Array<{ detail: string }>).map(row => row.detail).join('\n')
    expect(plan("SELECT id FROM provider_batch_requests WHERE query_id = 'q-1'"))
      .toContain('USING INDEX idx_provider_batch_requests_query')
    expect(plan("SELECT id FROM query_snapshots WHERE provider_batch_id = 'b-1'"))
      .toContain('USING INDEX idx_snapshots_provider_batch')
  })
})
