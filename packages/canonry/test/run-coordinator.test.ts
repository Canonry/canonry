import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, discoverySessions, migrate, projects, runs, queries, querySnapshots, healthSnapshots, insights, gbpLocations, gbpLodgingSnapshots } from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'
import { IntelligenceService } from '../src/intelligence-service.js'
import { RunCoordinator, type AeroEventContext } from '../src/run-coordinator.js'

function createTempDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function seedFixture(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'coord-test',
    displayName: 'Coord Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'test query',
    createdAt: now,
  }).run()

  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'completed',
    createdAt: now,
    finishedAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    provider: 'gemini',
    model: 'test-model',
    citationState: 'cited',
    citedDomains: ['example.com'],
    competitorOverlap: [],
    createdAt: now,
  }).run()

  return { projectId, runId }
}

function createMockNotifier(): Pick<Notifier, 'onRunCompleted'> {
  return {
    onRunCompleted: vi.fn().mockResolvedValue(undefined),
  }
}

describe('RunCoordinator', () => {
  it('calls both intelligence and notifier on run completion', async () => {
    const { db } = createTempDb('coord-both-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    const coordinator = new RunCoordinator(db, notifier as Notifier, service)

    await coordinator.onRunCompleted(runId, projectId)

    // Intelligence should have persisted results
    const healthRows = db.select().from(healthSnapshots).all()
    expect(healthRows).toHaveLength(1)

    // Notifier should have been called
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)
  })

  it('calls notifier even when intelligence fails', async () => {
    const { db } = createTempDb('coord-intel-fail-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    // Sabotage the service
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation(() => {
      throw new Error('analysis exploded')
    })

    const coordinator = new RunCoordinator(db, notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    // Notifier should still be called despite intelligence failure
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)
  })

  it('does not throw when notifier fails', async () => {
    const { db } = createTempDb('coord-notify-fail-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    notifier.onRunCompleted.mockRejectedValue(new Error('webhook down'))

    const service = new IntelligenceService(db)
    const coordinator = new RunCoordinator(db, notifier as Notifier, service)

    // Should not throw
    await expect(coordinator.onRunCompleted(runId, projectId)).resolves.toBeUndefined()

    // Intelligence should still have persisted
    const healthRows = db.select().from(healthSnapshots).all()
    expect(healthRows).toHaveLength(1)
  })

  it('awaits intelligence before calling notifier (regression: missing await)', async () => {
    const { db } = createTempDb('coord-await-')
    const { projectId, runId } = seedFixture(db)

    let intelligenceFinished = false
    const notifier = {
      onRunCompleted: vi.fn().mockImplementation(async () => {
        // At the point notifier runs, intelligence must have already completed
        expect(intelligenceFinished).toBe(true)
      }),
    }
    const service = new IntelligenceService(db)
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation(() => {
      // analyzeAndPersist is synchronous — mark completion before returning
      intelligenceFinished = true
      return null
    })

    const coordinator = new RunCoordinator(db, notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    expect(notifier.onRunCompleted).toHaveBeenCalled()
    expect(intelligenceFinished).toBe(true)
  })

  it('intelligence runs before notifier', async () => {
    const { db } = createTempDb('coord-order-')
    const { projectId, runId } = seedFixture(db)

    const callOrder: string[] = []
    const notifier = {
      onRunCompleted: vi.fn().mockImplementation(async () => {
        callOrder.push('notifier')
      }),
    }
    const service = new IntelligenceService(db)
    const origAnalyze = service.analyzeAndPersist.bind(service)
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation((...args) => {
      callOrder.push('intelligence')
      return origAnalyze(...args)
    })

    const coordinator = new RunCoordinator(db, notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    expect(callOrder).toEqual(['intelligence', 'notifier'])
  })

  describe("trigger='probe' runs skip downstream side-effects", () => {
    // A probe is an operator/agent test run — meant to verify wire-level
    // behavior (e.g. "did the OpenAI provider migration still work?")
    // without polluting the dashboard, generating insights, firing webhooks,
    // or waking Aero. The snapshot data is still written so the operator
    // can inspect what the provider returned. RunCoordinator is the chokepoint
    // for those side-effects, so the skip lives here.

    function seedProbeRun(db: ReturnType<typeof createTempDb>['db']) {
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId,
        name: 'probe-test',
        displayName: 'Probe Test',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        providers: '["gemini"]',
        createdAt: now,
        updatedAt: now,
      }).run()

      const queryId = crypto.randomUUID()
      db.insert(queries).values({
        id: queryId,
        projectId,
        query: 'probe query',
        createdAt: now,
      }).run()

      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'probe',
        createdAt: now,
        finishedAt: now,
      }).run()

      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId,
        queryId,
        provider: 'gemini',
        model: 'test-model',
        citationState: 'cited',
        citedDomains: ['example.com'],
        competitorOverlap: [],
        createdAt: now,
      }).run()

      return { projectId, runId }
    }

    it('does NOT run intelligence analysis (no health snapshots, no insights)', async () => {
      const { db } = createTempDb('coord-probe-intel-')
      const { projectId, runId } = seedProbeRun(db)

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const intelSpy = vi.spyOn(service, 'analyzeAndPersist')

      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      expect(intelSpy).not.toHaveBeenCalled()
      const healthRows = db.select().from(healthSnapshots).all()
      expect(healthRows).toHaveLength(0)
    })

    it('does NOT call the notifier (webhooks stay quiet)', async () => {
      const { db } = createTempDb('coord-probe-notify-')
      const { projectId, runId } = seedProbeRun(db)

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)

      await coordinator.onRunCompleted(runId, projectId)

      expect(notifier.onRunCompleted).not.toHaveBeenCalled()
    })

    it('does NOT wake Aero', async () => {
      const { db } = createTempDb('coord-probe-aero-')
      const { projectId, runId } = seedProbeRun(db)

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const aeroSpy = vi.fn(async () => {})

      const coordinator = new RunCoordinator(db, notifier as Notifier, service, undefined, aeroSpy)
      await coordinator.onRunCompleted(runId, projectId)

      expect(aeroSpy).not.toHaveBeenCalled()
    })

    it('still resolves cleanly (no thrown errors) — probes are silent successes', async () => {
      const { db } = createTempDb('coord-probe-clean-')
      const { projectId, runId } = seedProbeRun(db)

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)

      await expect(coordinator.onRunCompleted(runId, projectId)).resolves.toBeUndefined()
    })

    it("regression guard: non-probe runs (trigger='manual') still trigger intelligence + notifier", async () => {
      // Make sure the probe skip doesn't accidentally widen and silence
      // real runs. This is the symmetric "happy path" assertion.
      const { db } = createTempDb('coord-probe-regression-')
      const { projectId, runId } = seedFixture(db) // trigger defaults to 'manual'

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const intelSpy = vi.spyOn(service, 'analyzeAndPersist')

      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      expect(intelSpy).toHaveBeenCalled()
      expect(notifier.onRunCompleted).toHaveBeenCalled()
    })
  })

  it('runs GBP intelligence for a gbp-sync run and wakes Aero with the insight count', async () => {
    const { db } = createTempDb('coord-gbp-')
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'gbp-coord', displayName: 'GBP', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    // One selected location with an empty lodging profile → one high lodging-gap insight.
    db.insert(gbpLocations).values({
      id: 'l1', projectId, accountName: 'accounts/1', locationName: 'locations/1',
      displayName: 'Loc 1', selected: true, createdAt: now, updatedAt: now,
    }).run()
    db.insert(gbpLodgingSnapshots).values({
      id: 'lg1', projectId, locationName: 'locations/1', contentHash: 'h', attributes: {},
      populatedGroupCount: 0, syncedAt: now, syncRunId: null,
    }).run()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'gbp-sync', status: 'completed', trigger: 'scheduled',
      createdAt: now, finishedAt: now,
    }).run()

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    const gbpSpy = vi.spyOn(service, 'analyzeAndPersistGbp')
    const avSpy = vi.spyOn(service, 'analyzeAndPersist')
    let captured: AeroEventContext | undefined
    const coordinator = new RunCoordinator(db, notifier as Notifier, service, undefined, async (ctx) => { captured = ctx })

    await coordinator.onRunCompleted(runId, projectId)

    // GBP analyzer ran; the answer-visibility analyzer did NOT (no health snapshot).
    expect(gbpSpy).toHaveBeenCalledWith(runId, projectId)
    expect(avSpy).not.toHaveBeenCalled()
    expect(db.select().from(healthSnapshots).all()).toHaveLength(0)

    // The insight was persisted and the notifier fired.
    expect(db.select().from(insights).where(eq(insights.runId, runId)).all()).toHaveLength(1)
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)

    // Aero woke with the GBP insight count.
    expect(captured).toBeDefined()
    if (!captured || captured.kind === 'aeo-discover-probe') throw new Error('expected a gbp-sync aero context')
    expect(captured.kind).toBe('gbp-sync')
    expect(captured.insightCount).toBe(1)
    expect(captured.criticalOrHigh).toBe(1)
  })

  it('discovery aero context resolves the session by runId, not by "latest non-queued"', async () => {
    // Regression: two discovery sessions on the same project must be
    // disambiguated by runId. Picking the most recent non-queued session
    // would surface the WRONG session's bucket counts to Aero when the
    // older run completes.
    const { db } = createTempDb('coord-discovery-')
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId,
      name: 'disc-project',
      displayName: 'Disc',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const olderRunId = crypto.randomUUID()
    const newerRunId = crypto.randomUUID()
    for (const [runId, kindStatus] of [[olderRunId, 'completed'], [newerRunId, 'running']] as const) {
      db.insert(runs).values({
        id: runId,
        projectId,
        kind: 'aeo-discover-probe',
        status: kindStatus,
        trigger: 'manual',
        createdAt: now,
      }).run()
    }

    // Older session — the one whose run is completing now.
    db.insert(discoverySessions).values({
      id: 'sess_older',
      projectId,
      runId: olderRunId,
      status: 'completed',
      citedCount: 7,
      aspirationalCount: 1,
      wastedCount: 2,
      probeCount: 10,
      seedProvider: 'gemini-older',
      competitorMap: '[]',
      createdAt: '2026-05-10T00:00:00.000Z',
    }).run()
    // Newer session — would have been picked by "latest non-queued" heuristic.
    db.insert(discoverySessions).values({
      id: 'sess_newer',
      projectId,
      runId: newerRunId,
      status: 'probing',
      citedCount: 0,
      aspirationalCount: 0,
      wastedCount: 99,
      probeCount: 99,
      seedProvider: 'gemini-newer',
      competitorMap: '[]',
      createdAt: '2026-05-11T00:00:00.000Z',
    }).run()

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    let captured: AeroEventContext | undefined
    const coordinator = new RunCoordinator(db, notifier as Notifier, service, undefined, async (ctx) => {
      captured = ctx
    })
    await coordinator.onRunCompleted(olderRunId, projectId)

    expect(captured).toBeDefined()
    expect(captured!.kind).toBe('aeo-discover-probe')
    if (captured!.kind !== 'aeo-discover-probe') throw new Error('kind narrow failed')
    expect(captured!.sessionId).toBe('sess_older')
    expect(captured!.seedProvider).toBe('gemini-older')
    expect(captured!.buckets).toEqual({ cited: 7, aspirational: 1, 'wasted-surface': 2 })
    expect(captured!.probeCount).toBe(10)
  })
})
