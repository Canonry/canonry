import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { parseRunError, type ProviderAccountStreak } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, querySnapshots, runs, simpleMeasurementDefinitions, usageCounters } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { fakeAdapter, type RecordedCall } from './fake-measurement-provider.js'

// A provider that keeps failing on its account is skipped when the run is
// queued (`runs.skipped_providers`). The runner never calls it, records the
// skip as its error so the run explains itself, and still counts it in the
// run's roster: the frozen definition keeps the same engines, so a skip day
// reads as missing answers, not as a new series.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

beforeEach(() => {
  telemetry.trackEvent.mockReset()
  resetSharedProviderExecutionGates()
})

const OPENAI: ProviderAccountStreak = {
  code: 'PROVIDER_BILLING',
  consecutiveRuns: 10,
  since: '2026-10-01T00:00:00.000Z',
  latestRunId: 'run-9',
  retryAfter: '2026-10-08T09:00:00.000Z',
}

test('a planless run never calls a skipped provider and records why it has no answers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skipped-providers-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'skips', displayName: 'Skips Co', canonicalDomain: 'example.com', country: 'US', language: 'en',
    providers: ['openai', 'gemini'], createdAt: now, updatedAt: now,
  }).run()
  for (const query of ['widget pricing', 'widget repair']) {
    db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: now }).run()
  }
  db.insert(runs).values({ id: runId, projectId, status: 'queued', trigger: 'scheduled', skippedProviders: { openai: OPENAI }, createdAt: now }).run()
  const calls: RecordedCall[] = []
  const registry = new ProviderRegistry()
  for (const name of ['openai', 'gemini']) {
    registry.register(fakeAdapter({ name, calls }), {
      provider: name,
      apiKey: 'test-key',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 },
    })
  }

  await new JobRunner(db, registry).executeRun(runId, projectId)

  expect(calls.map(call => `${call.provider} ${call.query}`).sort()).toEqual(['gemini widget pricing', 'gemini widget repair'])
  expect(db.select({ provider: querySnapshots.provider }).from(querySnapshots).where(eq(querySnapshots.runId, runId)).all())
    .toEqual([{ provider: 'gemini' }, { provider: 'gemini' }])
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!
  expect(run.status).toBe('partial')
  expect(parseRunError(run.error)).toEqual({
    providers: {
      openai: {
        message: 'Not called: openai failed on its account (PROVIDER_BILLING) in each of its last 10 runs. '
          + 'It is called again after 2026-10-08T09:00:00.000Z, or as soon as a new key, model or endpoint is saved for it '
          + '(canonry settings provider openai). Pass force (canonry run --force) to call it now.',
        code: 'PROVIDER_BILLING',
        skipped: true,
      },
    },
  })
  // Nothing was reserved against the skipped provider's daily quota.
  expect(db.select().from(usageCounters).where(eq(usageCounters.scope, `${projectId}:openai`)).all()).toEqual([])
  // Its engine stays in the frozen definition: the series does not break.
  const definition = db.select({ definition: simpleMeasurementDefinitions.definition }).from(simpleMeasurementDefinitions)
    .where(eq(simpleMeasurementDefinitions.runId, runId)).get()!.definition
  expect(definition.engines.map(engine => engine.provider).sort()).toEqual(['gemini', 'openai'])

  const completed = telemetry.trackEvent.mock.calls.filter(([event]) => event === 'run.completed')
  expect(completed).toHaveLength(1)
  expect(completed[0]![1]).toMatchObject({
    status: 'partial',
    providerCount: 2,
    providerOutcomes: { openai: 'skipped', gemini: 'ok' },
  })
  expect((completed[0]![1] as { providers: string[] }).providers.sort()).toEqual(['gemini', 'openai'])
  // The account code that skipped it is why the run is partial.
  expect(completed[0]![2]).toEqual({ errorCode: 'PROVIDER_BILLING' })
})
