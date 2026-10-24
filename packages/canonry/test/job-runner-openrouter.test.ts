import crypto from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildMeasurementRunManifestV1, canonicalMeasurementPlanJson, canonicalMeasurementPlanV2Json, compileMeasurementPlan, measurementPlanV2ChecksumJson, parseMeasurementRunManifestV1, RunStatuses, type LocationContext, type MeasurementPlanV2, type ProviderAdapter } from '@canonry/canonry-contracts'
import { buildMeasurementRunManifest, queueRunIfProjectIdle } from '@canonry/canonry-api-routes'
import { createClient, migrate, projects, queries, runs, querySnapshots, measurementPlans, measurementPlanVersions, usageCounters } from '@canonry/canonry-db'
import { openrouterAdapter } from '@canonry/canonry-provider-openrouter'
import { ProviderRegistry } from '../src/provider-registry.js'
import { JobRunner } from '../src/job-runner.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

const engines = ['gemini', 'openrouter:google/gemini-3.1-flash-lite', 'openrouter:anthropic/claude-sonnet-4.6']
const location: LocationContext = { label: 'New York', city: 'New York', region: 'NY', country: 'US' }
const direct: ProviderAdapter = {
  name: 'gemini', supportsLocationContext: true,
  modelRegistry: { defaultModel: 'gemini-flash-latest', validationPattern: /./, knownModels: [] },
  validateConfig: () => ({ ok: true, provider: 'gemini', message: 'valid' }),
  healthcheck: async () => ({ ok: true, provider: 'gemini', message: 'valid' }),
  executeTrackedQuery: async () => ({ provider: 'gemini', model: 'gemini-flash-latest', servedModel: 'gemini-direct-served', rawResponse: {}, groundingSources: [], searchQueries: [], retrievalStatus: 'used' }),
  normalizeResult: raw => ({ provider: raw.provider, answerText: 'Northstar is recommended.', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: raw.retrievalStatus }),
  generateText: async () => 'unused',
}
afterEach(() => { vi.unstubAllGlobals(); resetSharedProviderExecutionGates() })

test.each(['Simple', 'Advanced'] as const)('%s sweeps persist direct and multiple routed models separately with shared quota', async kind => {
  resetSharedProviderExecutionGates()
  const requestedModels: string[] = []
  let active = 0; let maximumActive = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    requestedModels.push(body.model)
    expect(body.messages).toEqual([{ role: 'user', content: 'best widgets' }])
    active++; maximumActive = Math.max(maximumActive, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    const gemini = body.model.startsWith('google/')
    return new Response(JSON.stringify({ model: `${body.model}-served`, choices: [{ finish_reason: 'stop', message: {
      content: gemini ? 'Several widget options exist.' : 'Northstar sells widgets.',
      annotations: [{ type: 'url_citation', url_citation: { url: gemini ? 'https://example.com/widgets' : 'https://rival.example/widgets' } }],
    } }], usage: { prompt_tokens: 20, completion_tokens: 5, server_tool_use: { web_search_requests: 1 } } }), { status: 200 })
  }))
  const db = createClient(':memory:'); migrate(db)
  try {
    const projectId = crypto.randomUUID(); const runId = crypto.randomUUID(); const queryId = crypto.randomUUID(); const now = new Date().toISOString()
    db.insert(projects).values({ id: projectId, name: 'northstar', displayName: 'Northstar', aliases: ['Northstar'], canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: engines, locations: [location], defaultLocation: location.label, createdAt: now, updatedAt: now }).run()
    db.insert(queries).values({ id: queryId, projectId, query: 'best widgets', createdAt: now }).run()
    if (kind === 'Advanced') {
      const plan = compileMeasurementPlan({ schemaVersion: 1,
        targets: [{ stableKey: 'widgets', label: 'Widgets', aliases: ['Widgets'], urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive' }] }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['widgets'] }], targetQuerySelections: [{ targetKey: 'widgets', queryIds: [queryId] }],
      }, { canonicalDomain: 'example.com', ownedDomains: [], brandNames: ['Northstar'], defaultContext: location, locations: [location], trackedQueries: [{ id: queryId, query: 'best widgets' }], expectedSnapshots: engines.length })
      const canonicalJson = canonicalMeasurementPlanJson(plan); const versionId = crypto.randomUUID()
      db.insert(measurementPlanVersions).values({ id: versionId, projectId, revision: 1, canonicalJson, checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: now }).run()
      db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()
      db.insert(runs).values({ id: runId, projectId, status: 'queued', measurementPlanVersionId: versionId,
        measurementManifest: buildMeasurementRunManifestV1({ expectedSlots: buildMeasurementRunManifest(plan, engines).expectedSlots }), createdAt: now }).run()
    } else db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()
    const registry = new ProviderRegistry()
    const quotaPolicy = { maxConcurrency: 1, maxRequestsPerMinute: 1000, maxRequestsPerDay: 10 }
    registry.register(direct, { provider: 'gemini', apiKey: 'direct-key', quotaPolicy })
    registry.register(openrouterAdapter, { provider: 'openrouter', apiKey: 'router-key', quotaPolicy })
    await new JobRunner(db, registry).executeRun(runId, projectId)
    const outcome = db.select().from(runs).where(eq(runs.id, runId)).get()!
    expect(outcome.status, outcome.error ?? undefined).toBe(RunStatuses.completed)
    const rows = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
    expect(rows.map(row => row.provider).sort()).toEqual([...engines].sort())
    expect(requestedModels.sort()).toEqual(['anthropic/claude-sonnet-4.6', 'google/gemini-3.1-flash-lite'])
    expect(maximumActive).toBe(1)
    const byProvider = Object.fromEntries(rows.map(row => [row.provider, row]))
    expect(byProvider.gemini).toMatchObject({ model: 'gemini-flash-latest', servedModel: 'gemini-direct-served', answerMentioned: true, citationState: 'not-cited' })
    expect(byProvider[engines[1]!]).toMatchObject({ model: 'google/gemini-3.1-flash-lite', servedModel: 'google/gemini-3.1-flash-lite-served', answerMentioned: false, citationState: 'cited', citedUrls: ['https://example.com/widgets'], captureStatus: 'complete' })
    expect(byProvider[engines[2]!]).toMatchObject({ model: 'anthropic/claude-sonnet-4.6', answerMentioned: true, citationState: 'not-cited', citedUrls: ['https://rival.example/widgets'] })
    for (const provider of engines.slice(1)) {
      expect(byProvider[provider]).toMatchObject({ location: null, requestedContext: location, supportedContext: { status: 'ignored' } })
    }
    const routerQuota = db.select().from(usageCounters).where(eq(usageCounters.scope, `${projectId}:openrouter`)).all()
    expect(routerQuota.map(row => ({ metric: row.metric, count: row.count }))).toEqual([{ metric: 'queries', count: 2 }])
  } finally { db.$client.close() }
})

test('unequal Advanced route slots fit their exact shared daily budget', async () => {
  const routeA = engines[1]!
  const routeB = engines[2]!
  const calls: Array<{ model: string; query: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> }
    calls.push({ model: body.model, query: body.messages[0]!.content })
    return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop', message: {
      content: 'Northstar sells widgets.', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/widgets' } }],
    } }] }), { status: 200 })
  }))
  const db = createClient(':memory:'); migrate(db)
  try {
    const projectId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const now = new Date().toISOString()
    const queryTexts = ['best widgets', 'widget pricing', 'widget reliability']
    db.insert(projects).values({ id: projectId, name: 'unequal', displayName: 'Northstar', aliases: ['Northstar'], canonicalDomain: 'example.com',
      country: 'US', language: 'en', providers: [routeA, routeB], createdAt: now, updatedAt: now }).run()
    const tracked = queryTexts.map((query, index) => ({ id: `q-${index + 1}`, projectId, query, createdAt: now }))
    for (const query of tracked) db.insert(queries).values(query).run()
    const draft: MeasurementPlanV2 = {
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Northstar'] } },
      targets: [{ stableKey: 'widgets', label: 'Widgets', aliases: ['Widgets'], mentionNotApplicable: false, discoveryIdentity: null,
        urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive' }] }],
      groups: [],
      querySnapshots: tracked.map(query => ({ queryId: query.id, queryText: query.query, provenance: { source: 'manual', sourceId: null, capturedAt: now } })),
      assignments: tracked.map((query, index) => ({ targetKey: 'widgets', queryId: query.id, queryClass: 'non-brand', executionNodeKey: `exec-${index + 1}` })),
      executionNodes: tracked.map((query, index) => ({
        stableKey: `exec-${index + 1}`, queryId: query.id, queryText: query.query,
        context: { providers: index === 0 ? [routeA, routeB] : [routeA], location: null,
          models: index === 0 ? { [routeA]: 'google/gemini-3.1-flash-lite', [routeB]: 'anthropic/claude-sonnet-4.6' } : { [routeA]: 'google/gemini-3.1-flash-lite' } },
        expectedSnapshots: index === 0 ? 2 : 1,
      })),
      usageEdges: tracked.map((query, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'widgets', queryId: query.id })),
      compiledChecksum: '0'.repeat(64),
    }
    const plan = { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
    const canonicalJson = canonicalMeasurementPlanV2Json(plan)
    db.insert(measurementPlanVersions).values({ id: versionId, projectId, revision: 1, schemaVersion: 2, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
    db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()
    const queued = queueRunIfProjectIdle(db, { projectId, runnableProviders: ['openrouter'] })
    if (queued.conflict || queued.refused) throw new Error('unequal route run should queue')
    const manifest = parseMeasurementRunManifestV1(db.select().from(runs).where(eq(runs.id, queued.runId)).get()!.measurementManifest)
    expect([manifest.expectedSlots.filter(slot => slot.provider === routeA).length, manifest.expectedSlots.filter(slot => slot.provider === routeB).length]).toEqual([3, 1])
    const registry = new ProviderRegistry()
    registry.register(openrouterAdapter, { provider: 'openrouter', apiKey: 'shared-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 1000, maxRequestsPerDay: 4 } })
    await new JobRunner(db, registry).executeRun(queued.runId, projectId)
    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()!.status).toBe(RunStatuses.completed)
    expect(calls.sort((a, b) => a.model.localeCompare(b.model) || a.query.localeCompare(b.query))).toEqual([
      { model: 'anthropic/claude-sonnet-4.6', query: 'best widgets' },
      { model: 'google/gemini-3.1-flash-lite', query: 'best widgets' },
      { model: 'google/gemini-3.1-flash-lite', query: 'widget pricing' },
      { model: 'google/gemini-3.1-flash-lite', query: 'widget reliability' },
    ])
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).all()).toHaveLength(4)
    expect(db.select({ metric: usageCounters.metric, count: usageCounters.count }).from(usageCounters)
      .where(eq(usageCounters.scope, `${projectId}:openrouter`)).all()).toEqual([{ metric: 'queries', count: 4 }])
  } finally { db.$client.close() }
})
