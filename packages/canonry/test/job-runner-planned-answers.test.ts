import { afterEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  RunStatuses,
  type LocationContext,
  type ProviderAccountStreak,
  type ProviderAdapter,
} from '@canonry/canonry-contracts'
import { buildMeasurementRunManifest } from '@canonry/canonry-api-routes'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs } from '@canonry/canonry-db'
import { ProviderRegistry } from '../src/provider-registry.js'
import { JobRunner } from '../src/job-runner.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

const NOW = '2026-11-01T12:00:00.000Z'
const location: LocationContext = { label: 'New York', city: 'New York', region: 'NY', country: 'US' }
const engines = ['claude', 'gemini', 'openai']
/** Frozen on the run when it was queued: openai keeps failing on its account, so the sweep never calls it. */
const held: ProviderAccountStreak = { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: NOW, latestRunId: 'older-run', retryAfter: '2026-11-02T12:00:00.000Z' }

function stubEngine(name: string, onCall: () => void): ProviderAdapter {
  return {
    name, displayName: name, mode: 'api', supportsLocationContext: true,
    modelRegistry: { defaultModel: `${name}-model`, validationPattern: /./, knownModels: [] },
    validateConfig: () => ({ ok: true, provider: name, message: 'valid' }),
    healthcheck: async () => ({ ok: true, provider: name, message: 'valid' }),
    executeTrackedQuery: async () => {
      onCall()
      return { provider: name, model: `${name}-model`, rawResponse: {}, groundingSources: [], searchQueries: [], retrievalStatus: 'used' }
    },
    normalizeResult: raw => ({ provider: raw.provider, answerText: 'Northstar is recommended.', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: raw.retrievalStatus }),
    generateText: async () => 'unused',
  }
}

afterEach(() => { resetSharedProviderExecutionGates() })

test.each(['Simple', 'Advanced'] as const)('%s sweeps save the answers they plan before the first call, leaving out an engine they skip', async kind => {
  resetSharedProviderExecutionGates()
  const db = createClient(':memory:'); migrate(db)
  try {
    const projectId = 'northstar'; const runId = 'sweep'
    db.insert(projects).values({ id: projectId, name: 'northstar', displayName: 'Northstar', aliases: ['Northstar'], canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: engines, locations: [location], defaultLocation: location.label, createdAt: NOW, updatedAt: NOW }).run()
    const tracked = ['best widgets', 'widget pricing', 'widget reviews'].map((query, index) => ({ id: `q-${index + 1}`, projectId, query, createdAt: NOW }))
    for (const query of tracked) db.insert(queries).values(query).run()
    if (kind === 'Advanced') {
      const plan = compileMeasurementPlan({ schemaVersion: 1,
        targets: [{ stableKey: 'widgets', label: 'Widgets', aliases: ['Widgets'], urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive' }] }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['widgets'] }], targetQuerySelections: [{ targetKey: 'widgets', queryIds: tracked.map(query => query.id) }],
      }, { canonicalDomain: 'example.com', ownedDomains: [], brandNames: ['Northstar'], defaultContext: location, locations: [location], trackedQueries: tracked.map(({ id, query }) => ({ id, query })), expectedSnapshots: engines.length })
      const canonicalJson = canonicalMeasurementPlanJson(plan)
      db.insert(measurementPlanVersions).values({ id: 'v1', projectId, revision: 1, canonicalJson, checksum: 'c'.repeat(64), createdAt: NOW }).run()
      db.insert(measurementPlans).values({ projectId, activeVersionId: 'v1', createdAt: NOW, updatedAt: NOW }).run()
      // Nine slots: three queries for each of three engines.
      const manifest = buildMeasurementRunManifestV1({ expectedSlots: buildMeasurementRunManifest(plan, engines).expectedSlots })
      expect(manifest.expectedSlots).toHaveLength(9)
      db.insert(runs).values({ id: runId, projectId, status: RunStatuses.queued, measurementPlanVersionId: 'v1', measurementManifest: manifest, skippedProviders: { openai: held }, createdAt: NOW }).run()
    } else {
      db.insert(runs).values({ id: runId, projectId, status: RunStatuses.queued, skippedProviders: { openai: held }, createdAt: NOW }).run()
    }

    const plannedAtCall: Array<number | null> = []
    let skippedCalls = 0
    const readPlanned = () => { plannedAtCall.push(db.select({ planned: runs.plannedAnswers }).from(runs).where(eq(runs.id, runId)).get()?.planned ?? null) }
    const registry = new ProviderRegistry()
    const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 1000, maxRequestsPerDay: 100 }
    registry.register(stubEngine('claude', readPlanned), { provider: 'claude', apiKey: 'claude-key', quotaPolicy })
    registry.register(stubEngine('gemini', readPlanned), { provider: 'gemini', apiKey: 'gemini-key', quotaPolicy })
    registry.register(stubEngine('openai', () => { skippedCalls++ }), { provider: 'openai', apiKey: 'openai-key', quotaPolicy })
    expect(db.select({ planned: runs.plannedAnswers }).from(runs).where(eq(runs.id, runId)).get()?.planned).toBeNull()

    await new JobRunner(db, registry).executeRun(runId, projectId)

    // Three queries for each engine the sweep calls; the skipped engine's three are not planned.
    expect(skippedCalls).toBe(0)
    expect(plannedAtCall).toEqual([6, 6, 6, 6, 6, 6])
    const outcome = db.select().from(runs).where(eq(runs.id, runId)).get()!
    expect(outcome.plannedAnswers).toBe(6)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()).toHaveLength(6)
    // The skipped engine's slots stay missing, so the run is partial.
    expect(outcome.status).toBe(RunStatuses.partial)
  } finally { db.$client.close() }
})
