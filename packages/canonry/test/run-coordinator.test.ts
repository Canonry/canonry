import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, discoverySessions, migrate, projects, runs, queries, querySnapshots, healthSnapshots, insights, gbpLocations, gbpLodgingSnapshots, providerTokenUsage } from '@ainyc/canonry-db'
import type { AnalysisResult } from '@ainyc/canonry-intelligence'
import { Notifier } from '../src/notifier.js'
import { IntelligenceService } from '../src/intelligence-service.js'
import { RunCoordinator, stableEventId, type AeroEventContext } from '../src/run-coordinator.js'

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
      displayName: 'Loc 1', selected: true, syncedAt: now, createdAt: now, updatedAt: now,
    }).run()
    db.insert(gbpLodgingSnapshots).values({
      id: 'lg1', projectId, locationName: 'locations/1', contentHash: 'h', attributes: {},
      populatedGroupCount: 0, syncedAt: now, syncRunId: null,
    }).run()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'gbp-sync', status: 'completed', trigger: 'scheduled',
      createdAt: now, startedAt: now, finishedAt: now,
    }).run()

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    const gbpSpy = vi.spyOn(service, 'analyzeAndPersistGbp')
    const avSpy = vi.spyOn(service, 'analyzeAndPersist')
    const insightSpy = vi.fn(async (_runId: string, _projectId: string, _result: AnalysisResult) => {})
    let captured: AeroEventContext | undefined
    const coordinator = new RunCoordinator(db, notifier as Notifier, service, insightSpy, async (ctx) => { captured = ctx })

    await coordinator.onRunCompleted(runId, projectId)

    // GBP analyzer ran; the answer-visibility analyzer did NOT (no health snapshot).
    expect(gbpSpy).toHaveBeenCalledWith(runId, projectId)
    expect(avSpy).not.toHaveBeenCalled()
    expect(db.select().from(healthSnapshots).all()).toHaveLength(0)

    // The insight was persisted and the notifier fired.
    expect(db.select().from(insights).where(eq(insights.runId, runId)).all()).toHaveLength(1)
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)
    expect(insightSpy).toHaveBeenCalledTimes(1)
    expect(insightSpy.mock.calls[0]![0]).toBe(runId)
    expect(insightSpy.mock.calls[0]![1]).toBe(projectId)
    expect(insightSpy.mock.calls[0]![2].insights).toMatchObject([
      { type: 'gbp-lodging-gap', severity: 'high', provider: 'gbp' },
    ])

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

  describe('token-cost telemetry (Track 1)', () => {
    // RunCoordinator persists a row into `provider_token_usage` for every
    // (provider, model) combination present in the run's snapshots that
    // carries a recognized usage block. Verified by inspecting the table
    // after onRunCompleted resolves.

    function seedRunWithUsage(
      db: ReturnType<typeof createClient>,
      snapshots: Array<{ provider: string; model: string | null; usage: Record<string, unknown> }>,
    ) {
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId, name: `tok-${projectId.slice(0, 6)}`,
        displayName: 'Tok', canonicalDomain: 'example.com',
        country: 'US', language: 'en', createdAt: now, updatedAt: now,
      }).run()
      const queryId = crypto.randomUUID()
      db.insert(queries).values({ id: queryId, projectId, query: 'q', createdAt: now }).run()
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId, projectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'manual', createdAt: now, finishedAt: now,
      }).run()
      for (const snap of snapshots) {
        // Mirror the JobRunner storage envelope:
        // {model, groundingSources, searchQueries, apiResponse: <native>}
        const rawResponse = JSON.stringify({
          model: snap.model,
          groundingSources: [],
          searchQueries: [],
          apiResponse: snap.usage,
        })
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(), runId, queryId,
          provider: snap.provider, model: snap.model,
          citationState: 'cited', citedDomains: ['example.com'],
          competitorOverlap: [], rawResponse, createdAt: now,
        }).run()
      }
      return { projectId, runId }
    }

    it('persists one row per (provider, model) for a fan-out run', async () => {
      const { db } = createTempDb('coord-tokens-')
      const { projectId, runId } = seedRunWithUsage(db, [
        {
          provider: 'openai',
          model: 'gpt-5.4',
          usage: { usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 20 } } },
        },
        {
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          usage: { usage: { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 30 } },
        },
        {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          usage: { usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25, cachedContentTokenCount: 5 } },
        },
      ])

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      const rows = db.select().from(providerTokenUsage).where(eq(providerTokenUsage.runId, runId)).all()
      expect(rows).toHaveLength(3)
      const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]))
      expect(byProvider.openai).toMatchObject({
        provider: 'openai', model: 'gpt-5.4', inputTokens: 100, outputTokens: 50, cachedInputTokens: 20,
      })
      expect(byProvider.claude).toMatchObject({
        provider: 'claude', model: 'claude-sonnet-4-6', inputTokens: 200, outputTokens: 75, cachedInputTokens: 30,
      })
      expect(byProvider.gemini).toMatchObject({
        provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 80, outputTokens: 25, cachedInputTokens: 5,
      })
    })

    it('aggregates multiple snapshots from the same (provider, model) into one row', async () => {
      const { db } = createTempDb('coord-tokens-agg-')
      const { projectId, runId } = seedRunWithUsage(db, [
        { provider: 'claude', model: 'claude-sonnet-4-6', usage: { usage: { input_tokens: 100, output_tokens: 25 } } },
        { provider: 'claude', model: 'claude-sonnet-4-6', usage: { usage: { input_tokens: 200, output_tokens: 50 } } },
        { provider: 'claude', model: 'claude-sonnet-4-6', usage: { usage: { input_tokens: 300, output_tokens: 75, cache_read_input_tokens: 10 } } },
      ])

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      const rows = db.select().from(providerTokenUsage).where(eq(providerTokenUsage.runId, runId)).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        inputTokens: 600,
        outputTokens: 150,
        cachedInputTokens: 10,
      })
    })

    it('skips snapshots without a recognized usage block (no zero-counter rows)', async () => {
      const { db } = createTempDb('coord-tokens-skip-')
      const { projectId, runId } = seedRunWithUsage(db, [
        // Browser provider — no documented usage shape, should be skipped.
        { provider: 'cdp:chatgpt', model: null, usage: {} },
        // Real provider but no usage block — also skipped.
        { provider: 'openai', model: 'gpt-5.4', usage: { output: [] } },
      ])

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      expect(db.select().from(providerTokenUsage).where(eq(providerTokenUsage.runId, runId)).all()).toEqual([])
    })

    it('does NOT block notifier when token persistence fails', async () => {
      const { db } = createTempDb('coord-tokens-fail-')
      const { projectId, runId } = seedRunWithUsage(db, [
        { provider: 'claude', model: 'claude-sonnet-4-6', usage: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])

      // Sabotage the snapshot read so persistTokenUsage throws — we wrap
      // the table reads in try/catch precisely so persistence errors don't
      // starve downstream subscribers.
      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const dbProxy = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'select') {
            return (...args: unknown[]) => {
              const builder = Reflect.get(target, prop, receiver).apply(target, args) as {
                from: (table: unknown) => unknown
              }
              return {
                from(table: unknown) {
                  // Throw only on the snapshot read inside persistTokenUsage.
                  // Other selects (run row, project row, baseline detection)
                  // must still work.
                  if (table === querySnapshots) {
                    throw new Error('boom')
                  }
                  return builder.from(table)
                },
              }
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const coordinator = new RunCoordinator(dbProxy as typeof db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)
      expect(notifier.onRunCompleted).toHaveBeenCalled()
    })

    it('meters probe-trigger runs but skips the rest of the post-run pipeline', async () => {
      // Probe runs short-circuit intelligence / notifier / aero — but token
      // telemetry is the one exception: probes burn real provider tokens,
      // and the probe-exclusion rule protects dashboards/analytics, not
      // cost accounting. Unmetered probes would undercount hosted billing.
      const { db } = createTempDb('coord-tokens-probe-')
      const now = new Date().toISOString()
      const projectId = crypto.randomUUID()
      db.insert(projects).values({
        id: projectId, name: 'tok-probe', displayName: 'tp',
        canonicalDomain: 'example.com', country: 'US', language: 'en',
        createdAt: now, updatedAt: now,
      }).run()
      const queryId = crypto.randomUUID()
      db.insert(queries).values({ id: queryId, projectId, query: 'q', createdAt: now }).run()
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId, projectId, kind: 'answer-visibility', status: 'completed',
        trigger: 'probe', createdAt: now, finishedAt: now,
      }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId,
        provider: 'claude', model: 'claude-sonnet-4-6',
        citationState: 'cited', citedDomains: ['example.com'], competitorOverlap: [],
        rawResponse: JSON.stringify({ apiResponse: { usage: { input_tokens: 50, output_tokens: 5 } } }),
        createdAt: now,
      }).run()

      const notifier = createMockNotifier()
      const service = new IntelligenceService(db)
      const coordinator = new RunCoordinator(db, notifier as Notifier, service)
      await coordinator.onRunCompleted(runId, projectId)

      // Metered: the usage row exists with the snapshot's token counts.
      const usage = db.select().from(providerTokenUsage).where(eq(providerTokenUsage.runId, runId)).all()
      expect(usage).toHaveLength(1)
      expect(usage[0]).toMatchObject({ provider: 'claude', inputTokens: 50, outputTokens: 5 })
      // Pipeline still short-circuited: no notifier dispatch for probes.
      expect(notifier.onRunCompleted).not.toHaveBeenCalled()
    })
  })

  describe('stableEventId (Track 3 baseline dedup)', () => {
    // The `(eventType, projectId)` -> UUID derivation is the only line of
    // defense against the concurrent-run race where two answer-visibility
    // sweeps both decide they're the "first" baseline. The control plane
    // dedupes its `event_idempotency` table on `event_id`, so identical
    // inputs MUST produce identical UUIDs across processes / restarts.

    it('returns the same UUID for the same (eventType, projectId)', () => {
      const a = stableEventId('baseline.completed', 'proj-xyz')
      const b = stableEventId('baseline.completed', 'proj-xyz')
      expect(a).toBe(b)
    })

    it('returns a different UUID for a different projectId', () => {
      const a = stableEventId('baseline.completed', 'proj-a')
      const b = stableEventId('baseline.completed', 'proj-b')
      expect(a).not.toBe(b)
    })

    it('returns a different UUID for a different eventType', () => {
      const a = stableEventId('baseline.completed', 'proj-x')
      const b = stableEventId('connection.created', 'proj-x')
      expect(a).not.toBe(b)
    })

    it('returns a valid RFC 4122 v5 UUID', () => {
      const id = stableEventId('baseline.completed', 'proj-x')
      // 8-4-4-4-12 hex with version 5 in the 13th hex char and variant
      // 10xx (8/9/a/b) in the 17th.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
  })
})
