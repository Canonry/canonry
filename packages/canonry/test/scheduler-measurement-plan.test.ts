import { expect, onTestFinished, test } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  parseMeasurementRunManifestV1,
  type LocationContext,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  runs,
  schedules,
} from '@ainyc/canonry-db'
import { Scheduler } from '../src/scheduler.js'

const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }

/**
 * A scheduled sweep is the one that runs without anybody watching. It has to
 * resolve providers the same way a hand-triggered one does, including the
 * "empty project list means every configured provider" rule.
 */
function harness(projectProviders: string[], runnable: string[]) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sched-plan-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = '2026-08-02T00:00:00.000Z'
  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const versionId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'planned',
    displayName: 'Planned Co',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: projectProviders,
    locations: [NORTH],
    defaultLocation: NORTH.label,
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(queries).values({ id: queryId, projectId, query: 'widget pricing', createdAt: now }).run()

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
    // The plan is published against whatever the project would run with.
    expectedSnapshots: (projectProviders.length > 0 ? projectProviders : runnable).length,
  })
  const canonicalJson = canonicalMeasurementPlanJson(plan)
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    createdAt: now,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()

  db.insert(schedules).values({
    id: 'sched_plan',
    projectId,
    cronExpr: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  return { db, projectId }
}

function trigger(db: ReturnType<typeof createClient>, projectId: string, runnable: string[]) {
  const created: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => created.push(runId),
    getRunnableProviderNames: () => runnable,
  })
  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility') => void
  }).triggerRun('sched_plan', projectId, 'answer-visibility')
  return created
}

test('a scheduled plan sweep overlaps a site audit but a second sweep is skipped', () => {
  const runnable = ['openai', 'gemini']
  const { db, projectId } = harness([], runnable)
  db.insert(runs).values({
    id: 'audit', projectId, kind: 'site-audit', status: 'running', createdAt: new Date().toISOString(),
  }).run()

  const created = trigger(db, projectId, runnable)
  expect(created).toHaveLength(1)
  expect(trigger(db, projectId, runnable)).toEqual([])
  expect(db.select().from(runs).all()).toHaveLength(2)
  expect(db.select().from(runs).where(eq(runs.id, 'audit')).get()?.status).toBe('running')
})

test('a scheduled plan sweep resolves an empty project provider list to every configured provider', () => {
  const runnable = ['openai', 'gemini']
  const { db, projectId } = harness([], runnable)

  const created = trigger(db, projectId, runnable)

  expect(created).toHaveLength(1)
  const row = db.select().from(runs).where(eq(runs.id, created[0]!)).get()!
  expect(row.measurementPlanVersionId).not.toBeNull()
  const manifest = parseMeasurementRunManifestV1(row.measurementManifest)
  expect([...new Set(manifest.expectedSlots.map(slot => slot.provider))].sort()).toEqual(['gemini', 'openai'])
})

test('a scheduled plan sweep still honours an explicit project provider list', () => {
  const { db, projectId } = harness(['openai'], ['openai', 'gemini'])

  const created = trigger(db, projectId, ['openai', 'gemini'])

  expect(created).toHaveLength(1)
  const manifest = parseMeasurementRunManifestV1(
    db.select().from(runs).where(eq(runs.id, created[0]!)).get()!.measurementManifest,
  )
  expect([...new Set(manifest.expectedSlots.map(slot => slot.provider))]).toEqual(['openai'])
})
