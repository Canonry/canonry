import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { canonicalMeasurementPlanJson, compileMeasurementPlan, type LocationContext } from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  providerBatches,
  queries,
  runs,
  schedules,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { addLogListener, type LogEntry } from '../src/logger.js'
import { Scheduler } from '../src/scheduler.js'

// A scheduled sweep is where a project's `providerDispatchModes` takes effect.
// The scheduler hands the queue the providers this host can batch, logs the
// preferences that fall back to sync, and says when a sweep is skipped because
// the previous one is still waiting on a provider batch.

const NOW = '2026-09-24T06:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const PROVIDERS = ['claude', 'openai']

let removeListener: (() => void) | null = null
afterEach(() => {
  removeListener?.()
  removeListener = null
})

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = []
  removeListener = addLogListener(entry => { if (entry.module === 'Scheduler') entries.push(entry) })
  return entries
}

function harness(options: { planned: boolean }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sched-batch-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'planned', displayName: 'Planned Co', canonicalDomain: 'example.com', country: 'US', language: 'en',
    providers: PROVIDERS, providerDispatchModes: { claude: 'batch', openai: 'batch' },
    locations: [NORTH], defaultLocation: NORTH.label, createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: queryId, projectId, query: 'widget pricing', createdAt: NOW }).run()

  if (options.planned) {
    const plan = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'north-branch',
        label: 'North branch',
        urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/north', pathCase: 'insensitive' }],
        aliases: ['North branch'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'north-branch', queryIds: [queryId] }],
    }, {
      canonicalDomain: 'example.com',
      ownedDomains: [],
      defaultContext: NORTH,
      locations: [NORTH],
      trackedQueries: [{ id: queryId, query: 'widget pricing' }],
      expectedSnapshots: PROVIDERS.length,
    })
    const canonicalJson = canonicalMeasurementPlanJson(plan)
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: NOW,
    }).run()
    db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  }

  db.insert(schedules).values({
    id: 'sched_batch', projectId, cronExpr: '0 6 * * *', timezone: 'UTC', enabled: true, providers: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  return { db, projectId }
}

function trigger(db: DatabaseClient, projectId: string, batchEligible: string[]): string[] {
  const created: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => created.push(runId),
    getRunnableProviderNames: () => PROVIDERS,
    getEffectiveProviderModels: () => ({ claude: 'claude-sonnet-4-6', openai: 'gpt-5.4' }),
    getBatchEligibleProviderNames: () => batchEligible,
  })
  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility') => void
  }).triggerRun('sched_batch', projectId, 'answer-visibility')
  return created
}

describe('scheduled sweeps and batch dispatch', () => {
  it('freezes the preferred providers the host can batch, and warns about the one it cannot', () => {
    const { db, projectId } = harness({ planned: true })
    const logs = captureLogs()

    const [runId] = trigger(db, projectId, ['claude'])

    expect(db.select().from(runs).where(eq(runs.id, runId!)).get()?.providerDispatchModes).toEqual({ claude: 'batch' })
    const fallback = logs.filter(entry => entry.action === 'run.dispatch-sync-fallback')
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatchObject({ level: 'warn', runId, providerName: 'openai', reason: 'batch_unavailable' })
  })

  it('runs a planless project\'s preference sync, with the reason', () => {
    const { db, projectId } = harness({ planned: false })
    const logs = captureLogs()

    const [runId] = trigger(db, projectId, ['claude', 'openai'])

    expect(db.select().from(runs).where(eq(runs.id, runId!)).get()?.providerDispatchModes).toBeNull()
    expect(logs.filter(entry => entry.action === 'run.dispatch-sync-fallback').map(entry => [entry.providerName, entry.reason]))
      .toEqual([['claude', 'not_plan_run'], ['openai', 'not_plan_run']])
  })

  it('skips a sweep while the previous one waits on a provider batch, and says so', () => {
    const { db, projectId } = harness({ planned: true })
    db.insert(runs).values({ id: 'waiting', projectId, kind: 'answer-visibility', status: 'running', trigger: 'scheduled', createdAt: NOW }).run()
    db.insert(providerBatches).values({
      id: 'batch-1', projectId, runId: 'waiting', provider: 'claude', model: 'claude-sonnet-4-6', status: 'submitted',
      requestCount: 1, quotaScope: `${projectId}:claude`, quotaPeriod: '2026-09-24', quotaReserved: 1,
      deadlineAt: '2026-09-25T06:00:00.000Z', createdAt: NOW, updatedAt: NOW,
    }).run()
    const logs = captureLogs()

    expect(trigger(db, projectId, ['claude'])).toEqual([])

    expect(logs.find(entry => entry.action === 'run.skipped-active')).toMatchObject({ activeRunId: 'waiting', reason: 'batch-pending' })
  })

  it('gives no batch reason when the active run is not waiting on a batch', () => {
    const { db, projectId } = harness({ planned: true })
    db.insert(runs).values({ id: 'busy', projectId, kind: 'answer-visibility', status: 'running', trigger: 'manual', createdAt: NOW }).run()
    // An ingested batch is no longer outstanding.
    db.insert(providerBatches).values({
      id: 'batch-done', projectId, runId: 'busy', provider: 'claude', model: 'claude-sonnet-4-6', status: 'ingested',
      requestCount: 1, quotaScope: `${projectId}:claude`, quotaPeriod: '2026-09-24', quotaReserved: 1,
      deadlineAt: '2026-09-25T06:00:00.000Z', createdAt: NOW, updatedAt: NOW,
    }).run()
    const logs = captureLogs()

    expect(trigger(db, projectId, ['claude'])).toEqual([])

    const skipped = logs.find(entry => entry.action === 'run.skipped-active')
    expect(skipped).toMatchObject({ activeRunId: 'busy' })
    expect(skipped).not.toHaveProperty('reason')
  })
})
