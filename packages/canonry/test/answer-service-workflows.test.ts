import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  canonicalMeasurementPlanV2Json,
  IncompleteAnswerError,
  measurementPlanV2ChecksumJson,
  parseMeasurementRunManifestV1,
  queryTrackingResultsResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  routeFamiliesOf,
  RunStatuses,
  type MeasurementPlanV2,
  type ProviderAdapter,
} from '@canonry/canonry-contracts'
import { apiRoutes, queueRunIfProjectIdle } from '@canonry/canonry-api-routes'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, researchRunQueries, researchRuns, runs, usageCounters } from '@canonry/canonry-db'
import { createAnswerServiceAdapter } from '@canonry/canonry-provider-answer-services'
import { createFakeAnswerServiceAdapter, fakeCompleteBody, fakeFetch, FAKE_SERVICE_ID, fakeServiceDefinition, fakeServiceDescriptor } from '@canonry/canonry-provider-answer-services/testing'
import { ProviderRegistry } from '../src/provider-registry.js'
import { JobRunner } from '../src/job-runner.js'
import { executeResearchRun } from '../src/research-runner.js'
import { SnapshotService } from '../src/snapshot-service.js'
import { formatSnapshotMarkdown, formatSnapshotText } from '../src/commands/snapshot.js'
import { getSharedProviderExecutionGate, resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

const { fetchSiteTextMock, runAeoAuditMock } = vi.hoisted(() => ({ fetchSiteTextMock: vi.fn(), runAeoAuditMock: vi.fn() }))
vi.mock('../src/site-fetch.js', () => ({ fetchSiteText: fetchSiteTextMock }))
vi.mock('@canonry/aeo-audit', () => ({ runAeoAudit: runAeoAuditMock }))
vi.mock('../src/telemetry.js', () => ({ trackEvent: vi.fn() }))

const CITED = `${FAKE_SERVICE_ID}:cited`
const RESULTS = `${FAKE_SERVICE_ID}:results`
const STREAM = `${FAKE_SERVICE_ID}:stream`
const QUOTA = { maxConcurrency: 1, maxRequestsPerMinute: 1000, maxRequestsPerDay: 50 }

/** A direct answer engine that counts its calls and can generate text. */
function directEngine(calls: string[]): ProviderAdapter {
  return {
    name: 'gemini', displayName: 'Gemini', mode: 'api', supportsLocationContext: true,
    modelRegistry: { defaultModel: 'gemini-flash-latest', validationPattern: /./, validationHint: 'any', knownModels: [] },
    validateConfig: () => ({ ok: true, provider: 'gemini', message: 'valid' }),
    healthcheck: async () => ({ ok: true, provider: 'gemini', message: 'valid' }),
    executeTrackedQuery: async (input) => {
      calls.push(input.query)
      return { provider: 'gemini', model: 'gemini-flash-latest', rawResponse: {}, groundingSources: [], searchQueries: [], retrievalStatus: 'used', retrievalContract: 'search-required-v1' }
    },
    normalizeResult: raw => ({ provider: raw.provider, answerText: 'Several roofers exist.', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: raw.retrievalStatus }),
    generateText: async () => { throw new Error('generation is not part of these tests') },
  }
}

function registryWith(fetchImpl: typeof fetch, directCalls: string[]) {
  const registry = new ProviderRegistry()
  registry.register(directEngine(directCalls), { provider: 'gemini', apiKey: 'direct-key', quotaPolicy: QUOTA })
  registry.register(createFakeAnswerServiceAdapter({ fetchImpl, sleep: async () => undefined }), { provider: FAKE_SERVICE_ID, apiKey: 'service-key', quotaPolicy: QUOTA })
  return registry
}

function seedProject(db: ReturnType<typeof createClient>, providers: string[]) {
  const projectId = crypto.randomUUID()
  const queryId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({ id: projectId, name: `p-${projectId.slice(0, 6)}`, displayName: 'Acme Roofing', aliases: ['Acme Roofing'], canonicalDomain: 'acme-roofing.example',
    country: 'US', language: 'en', providers, createdAt: now, updatedAt: now }).run()
  db.insert(queries).values({ id: queryId, projectId, query: 'best roofer', createdAt: now }).run()
  return { projectId, queryId, now }
}

afterEach(() => resetSharedProviderExecutionGates())

describe('provider registry with an answer service connected', () => {
  it('never adds the service to "all configured" and resolves each profile to its own adapter', () => {
    const registry = registryWith(fakeFetch([{ json: fakeCompleteBody() }]).impl, [])
    expect(registry.getForProject([]).map(provider => provider.adapter.name)).toEqual(['gemini'])
    expect(registry.getApiProviders().map(provider => provider.adapter.name)).toEqual(['gemini'])
    // Explicitly named: only a sweep-eligible profile runs; the bare connection and a research-only profile do not.
    expect(registry.getForProject(['gemini', CITED, RESULTS, FAKE_SERVICE_ID]).map(provider => provider.adapter.name)).toEqual(['gemini', CITED])
    const route = registry.get(CITED)!
    expect(route.config).toMatchObject({ provider: CITED, model: 'cited', apiKey: 'service-key' })
    expect(route.adapter.displayName).toBe('Cited · Fake Answers')
    expect([registry.connectionOf(CITED), registry.connectionOf(RESULTS), registry.connectionOf('gemini')]).toEqual([FAKE_SERVICE_ID, FAKE_SERVICE_ID, 'gemini'])
    expect(registry.get(`${FAKE_SERVICE_ID}:unknown`)).toBeUndefined()
  })
})

test.each(['Simple', 'Advanced'] as const)('%s sweeps run an explicitly chosen profile, store its evidence and share the connection quota', async kind => {
  const stub = fakeFetch([{ json: fakeCompleteBody() }])
  const directCalls: string[] = []
  const db = createClient(':memory:'); migrate(db)
  const registry = registryWith(stub.impl, directCalls)
  const app = Fastify()
  app.register(apiRoutes, {
    db, skipAuth: true,
    getRunnableProviderNames: () => registry.getAll().map(({ adapter }) => adapter.name),
    providerSummary: registry.getAll().map(({ adapter, config }) => ({ name: adapter.name, model: config.model, configured: true })),
    providerAdapters: registry.getAll().map(({ adapter }) => ({
      name: adapter.name, displayName: adapter.displayName, mode: adapter.mode, routes: adapter.routes,
      modelConfigurable: false, defaultModel: adapter.modelRegistry.defaultModel,
      knownModels: adapter.modelRegistry.knownModels, modelValidationPattern: adapter.modelRegistry.validationPattern,
      modelValidationHint: adapter.modelRegistry.validationHint,
    })),
  })
  try {
    const engines = ['gemini', CITED]
    const { projectId, queryId, now } = seedProject(db, engines)
    let runId: string
    if (kind === 'Advanced') {
      const draft: MeasurementPlanV2 = {
        schemaVersion: 2,
        identities: { projectBrand: { canonicalHost: 'acme-roofing.example', ownedHosts: ['acme-roofing.example'], names: ['Acme Roofing'] } },
        targets: [{ stableKey: 'roofing', label: 'Roofing', aliases: ['Roofing'], mentionNotApplicable: false, discoveryIdentity: null,
          urlMatchers: [{ kind: 'prefix', host: 'acme-roofing.example', pathPrefix: '/', pathCase: 'insensitive' }] }],
        groups: [],
        querySnapshots: [{ queryId, queryText: 'best roofer', provenance: { source: 'manual', sourceId: null, capturedAt: now } }],
        assignments: [{ targetKey: 'roofing', queryId, queryClass: 'non-brand', executionNodeKey: 'exec-1' }],
        executionNodes: [{ stableKey: 'exec-1', queryId, queryText: 'best roofer', context: { providers: engines, location: null, models: { gemini: 'gemini-flash-latest', [CITED]: 'cited' } }, expectedSnapshots: 2 }],
        usageEdges: [{ executionNodeKey: 'exec-1', targetKey: 'roofing', queryId }],
        compiledChecksum: '0'.repeat(64),
      }
      const plan = { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
      const canonicalJson = canonicalMeasurementPlanV2Json(plan)
      const versionId = crypto.randomUUID()
      db.insert(measurementPlanVersions).values({ id: versionId, projectId, revision: 1, schemaVersion: 2, canonicalJson,
        checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), compiledChecksum: plan.compiledChecksum, createdAt: now }).run()
      db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()
      const queued = queueRunIfProjectIdle(db, { projectId, runnableProviders: ['gemini', FAKE_SERVICE_ID], routeFamilies: routeFamiliesOf([createFakeAnswerServiceAdapter()]) })
      if (queued.conflict || queued.refused) throw new Error('the run should queue')
      runId = queued.runId
      // The route's profile is frozen as the requested model, so a later fill cannot run another profile.
      const manifest = parseMeasurementRunManifestV1(db.select().from(runs).where(eq(runs.id, runId)).get()!.measurementManifest)
      expect(manifest.expectedSlots.find(slot => slot.provider === CITED)?.requestedModel).toBe('cited')
    } else {
      runId = crypto.randomUUID()
      db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()
    }
    await new JobRunner(db, registry).executeRun(runId, projectId)
    const outcome = db.select().from(runs).where(eq(runs.id, runId)).get()!
    expect(outcome.status, outcome.error ?? undefined).toBe(RunStatuses.completed)
    const rows = Object.fromEntries(db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all().map(row => [row.provider, row]))
    expect(Object.keys(rows).sort()).toEqual([CITED, 'gemini'])
    expect(rows[CITED]).toMatchObject({
      model: 'cited',
      // The service names only its tier, which never becomes a served model.
      servedModel: null,
      citationState: 'cited',
      answerMentioned: true,
      citedDomains: ['acme-roofing.example'],
      retrievalStatus: 'used',
      retrievalContract: 'service-native-v1',
      citedUrls: ['https://www.acme-roofing.example/services'],
      // Tokens were not reported, so usage stays empty rather than zero.
      usage: null,
    })
    expect(rows[CITED]!.answerEvidence).toMatchObject({
      identity: { route: CITED, profile: 'cited', requestedServiceModel: 'fake-tier', disclosedModel: 'fake-tier-2', disclosedModelKind: 'service-tier' },
      usage: { cost: { micros: 4500, basis: 'estimated', estimatedBy: 'provider' } },
      citationBasis: 'explicit-citation',
    })
    // Engines without evidence keep writing exactly what they did before.
    expect(rows.gemini!.answerEvidence).toBeNull()
    expect(db.select({ scope: usageCounters.scope, count: usageCounters.count }).from(usageCounters).where(eq(usageCounters.metric, 'queries')).all().sort((a, b) => a.scope.localeCompare(b.scope)))
      .toEqual([{ scope: `${projectId}:${FAKE_SERVICE_ID}`, count: 1 }, { scope: `${projectId}:gemini`, count: 1 }])
    expect(stub.calls).toHaveLength(1)
    expect(directCalls).toEqual(['best roofer'])
    const response = await app.inject(`/api/v1/projects/p-${projectId.slice(0, 6)}/query-tracking`)
    expect(response.statusCode).toBe(200)
    const workspace = queryTrackingWorkspaceResponseSchema.parse(response.json())
    expect(workspace.tracked.find(row => row.queryId === queryId)).toMatchObject({ state: 'tracked', lastMeasuredAt: outcome.finishedAt })
    // The results read compares the sweep with what the project dispatches now, as the
    // workspace does, so the chosen profile's sweep is the one tracked now and keeps its row.
    const resultsResponse = await app.inject(`/api/v1/projects/p-${projectId.slice(0, 6)}/query-tracking/results`)
    expect(resultsResponse.statusCode).toBe(200)
    const results = queryTrackingResultsResponseSchema.parse(resultsResponse.json())
    expect(results.run).toMatchObject({ id: runId, matchesCurrentTracking: true })
    expect(results.engines).toEqual([CITED, 'gemini'])
    expect(results.pendingRows).toBe(0)
    expect(results.rows.map(row => [row.queryId, row.queryClass])).toEqual([[queryId, 'non-brand']])
  } finally { await app.close(); db.$client.close() }
})

describe('cited page URLs from an answer service', () => {
  it('stores no cited page URLs when the service documents its source URLs as redirects', async () => {
    const cited = fakeServiceDescriptor.profiles.find(profile => profile.id === 'cited')!
    const redirecting = createAnswerServiceAdapter({
      ...fakeServiceDefinition,
      descriptor: { ...fakeServiceDescriptor, profiles: [{ ...cited, capabilities: { ...cited.capabilities, evidence: { ...cited.capabilities.evidence, directUrls: false } } }] },
    }, { fetchImpl: fakeFetch([{ json: fakeCompleteBody() }]).impl, sleep: async () => undefined })
    const registry = new ProviderRegistry()
    registry.register(redirecting, { provider: FAKE_SERVICE_ID, apiKey: 'service-key', quotaPolicy: QUOTA })
    const db = createClient(':memory:'); migrate(db)
    try {
      const { projectId, now } = seedProject(db, [CITED])
      const runId = crypto.randomUUID()
      db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()
      await new JobRunner(db, registry).executeRun(runId, projectId)
      const row = db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()!
      // The citation itself is still measured from the cited sources; only the URL capture is withheld.
      expect(row).toMatchObject({ provider: CITED, citationState: 'cited', citedDomains: ['acme-roofing.example'], citedUrls: null, captureStatus: 'unsupported' })
      expect(row.answerEvidence).toMatchObject({ citationMeasurable: true, directSourceUrls: false })
    } finally { db.$client.close() }
  })
})

describe('an existing project with no providers', () => {
  it('measures only its answer engines after a service is connected, through the queue and the runner', async () => {
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const directCalls: string[] = []
    const db = createClient(':memory:'); migrate(db)
    try {
      const families = routeFamiliesOf([createFakeAnswerServiceAdapter()])
      const { projectId } = seedProject(db, [])
      // Both routed connections are registered; neither joins "all configured".
      const queued = queueRunIfProjectIdle(db, { projectId, runnableProviders: ['gemini', 'openrouter', FAKE_SERVICE_ID], routeFamilies: families })
      if (queued.conflict || queued.refused) throw new Error('the run should queue')
      await new JobRunner(db, registryWith(stub.impl, directCalls)).executeRun(queued.runId, projectId)
      // Completed with no provider error: the bare connection was never attempted.
      expect(db.select({ status: runs.status, error: runs.error }).from(runs).get()).toEqual({ status: RunStatuses.completed, error: null })
      expect(db.select({ provider: querySnapshots.provider }).from(querySnapshots).all()).toEqual([{ provider: 'gemini' }])
      expect(stub.calls).toHaveLength(0)
    } finally { db.$client.close() }
  })
})

describe('research with an answer service', () => {
  function seedResearch(db: ReturnType<typeof createClient>, provider: string, queriesToRun: string[]) {
    const { projectId, now } = seedProject(db, [])
    db.insert(researchRuns).values({ id: 'r', projectId, status: 'queued', provider, resolvedModel: provider.split(':')[1]!, totalQueries: queriesToRun.length, completedQueries: 0, failedQueries: 0, createdAt: now }).run()
    queriesToRun.forEach((query, position) => db.insert(researchRunQueries).values({ id: `q${position}`, researchRunId: 'r', position, queryText: query, status: 'queued', resolvedModel: 'x', groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run())
    return projectId
  }

  it('stores a complete answer with its evidence and the citation it measured', async () => {
    const db = createClient(':memory:'); migrate(db)
    try {
      const projectId = seedResearch(db, CITED, ['best roofer'])
      await executeResearchRun(db, registryWith(fakeFetch([{ json: fakeCompleteBody() }]).impl, []), 'r', projectId)
      const row = db.select().from(researchRunQueries).get()!
      expect(row).toMatchObject({ status: 'completed', citationState: 'cited', answerMentioned: true, citedDomains: ['acme-roofing.example'], servedModel: null })
      expect(row.answerEvidence?.completion.status).toBe('complete')
      expect(db.select({ scope: usageCounters.scope }).from(usageCounters).where(eq(usageCounters.metric, 'queries')).all()).toEqual([{ scope: `${projectId}:${FAKE_SERVICE_ID}` }])
    } finally { db.$client.close() }
  })

  it('records no citation state for sources that are not tied to the answer, while still measuring the mention', async () => {
    const db = createClient(':memory:'); migrate(db)
    try {
      const projectId = seedResearch(db, RESULTS, ['best roofer'])
      await executeResearchRun(db, registryWith(fakeFetch([{ json: fakeCompleteBody({ results: [{ url: 'https://acme-roofing.example/', title: 'Acme' }] }) }]).impl, []), 'r', projectId)
      const row = db.select().from(researchRunQueries).get()!
      expect(row).toMatchObject({ status: 'completed', citationState: null, answerMentioned: true, citedDomains: [], groundingSources: [] })
      expect(row.answerEvidence).toMatchObject({ citationMeasurable: false, citationBasis: 'none', sources: [{ relationship: 'search-result', url: 'https://acme-roofing.example/' }] })
    } finally { db.$client.close() }
  })

  it('keeps a partial or pending answer as a failed query with its evidence, never a measured answer', async () => {
    const db = createClient(':memory:'); migrate(db)
    try {
      const projectId = seedResearch(db, CITED, ['cut off', 'queued'])
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string }
        const body = query === 'cut off'
          ? fakeCompleteBody({ status: 'incomplete', finish_reason: 'max_output_tokens', answer: 'Acme Roofing is' })
          : { id: 'fake-job-7', status: 'queued' }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      await executeResearchRun(db, registryWith(fetchImpl, []), 'r', projectId)
      const rows = Object.fromEntries(db.select().from(researchRunQueries).all().map(row => [row.queryText, row]))
      expect(rows['cut off']).toMatchObject({ status: 'failed', answerText: 'Acme Roofing is', answerMentioned: null, citationState: null })
      expect(rows['cut off']!.answerEvidence?.completion).toMatchObject({ status: 'partial', finishReason: 'max_output_tokens' })
      expect(rows.queued).toMatchObject({ status: 'failed', answerText: null, citationState: null })
      expect(rows.queued!.answerEvidence?.completion).toMatchObject({ status: 'pending', upstreamJobId: 'fake-job-7' })
      expect(db.select().from(researchRuns).get()).toMatchObject({ status: 'failed', completedQueries: 0, failedQueries: 2 })
    } finally { db.$client.close() }
  })
})

describe('research waiting on an upstream job', () => {
  it('keeps a resumable job waiting: neither completed nor failed, its job id stored, the run not finished', async () => {
    const db = createClient(':memory:'); migrate(db)
    try {
      const { projectId, now } = seedProject(db, [])
      db.insert(researchRuns).values({ id: 'r', projectId, status: 'queued', provider: CITED, resolvedModel: 'cited', totalQueries: 2, completedQueries: 0, failedQueries: 0, createdAt: now }).run()
      ;['best roofer', 'queued'].forEach((query, position) => db.insert(researchRunQueries).values({ id: `q${position}`, researchRunId: 'r', position, queryText: query, status: 'queued', resolvedModel: 'cited', groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run())
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string }
        const body = query === 'queued' ? { id: 'fake-job-7', status: 'queued' } : fakeCompleteBody()
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      const base = createFakeAnswerServiceAdapter({ fetchImpl, sleep: async () => undefined })
      // Stands in for a job profile run by a job executor, which can follow the job by its id.
      const resumable: ProviderAdapter = {
        ...base,
        forRoute: route => {
          const inner = base.forRoute!(route)
          return {
            ...inner,
            executeTrackedQuery: async (input, config) => {
              try {
                return await inner.executeTrackedQuery(input, config)
              } catch (error) {
                if (error instanceof IncompleteAnswerError && error.evidence.completion.status === 'pending') {
                  throw new IncompleteAnswerError(error.message, error.evidence, error.answerText, error.rawResponse, { resumable: true })
                }
                throw error
              }
            },
          }
        },
      }
      const registry = new ProviderRegistry()
      registry.register(resumable, { provider: FAKE_SERVICE_ID, apiKey: 'service-key', quotaPolicy: QUOTA })
      await executeResearchRun(db, registry, 'r', projectId)
      const rows = Object.fromEntries(db.select().from(researchRunQueries).all().map(row => [row.queryText, row]))
      expect(rows['best roofer']).toMatchObject({ status: 'completed', citationState: 'cited' })
      expect(rows.queued).toMatchObject({ status: 'waiting-upstream', upstreamJobId: 'fake-job-7', error: null, finishedAt: null, answerText: null, citationState: null, answerMentioned: null })
      expect(rows.queued!.answerEvidence?.completion).toMatchObject({ status: 'pending', upstreamJobId: 'fake-job-7' })
      // Not finished, and the waiting query is counted as neither completed nor failed.
      expect(db.select().from(researchRuns).get()).toMatchObject({ status: 'waiting-upstream', completedQueries: 1, failedQueries: 0, finishedAt: null })
    } finally { db.$client.close() }
  })
})

describe('snapshots with an answer service', () => {
  beforeEach(() => {
    fetchSiteTextMock.mockResolvedValue('Acme Roofing repairs roofs.')
    runAeoAuditMock.mockResolvedValue({ url: 'https://acme-roofing.example', finalUrl: 'https://acme-roofing.example', auditedAt: '2026-10-01T00:00:00.000Z', overallScore: 50, overallGrade: 'C', summary: 'Audit summary.', factors: [] })
  })

  it('leaves the service out when no provider is named', async () => {
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const directCalls: string[] = []
    const report = await new SnapshotService(registryWith(stub.impl, directCalls)).createReport({ companyName: 'Acme Roofing', domain: 'acme-roofing.example', queries: ['best roofer'] })
    expect(report.queryResults[0]!.providerResults.map(result => result.provider)).toEqual(['gemini'])
    expect(stub.calls).toHaveLength(0)
  })

  it('runs named profiles with manual queries and never uses one for analysis', async () => {
    const stub = fakeFetch([{ json: fakeCompleteBody() }])
    const report = await new SnapshotService(registryWith(stub.impl, [])).createReport({ companyName: 'Acme Roofing', domain: 'acme-roofing.example', queries: ['best roofer'], providers: [CITED, RESULTS] })
    const results = Object.fromEntries(report.queryResults[0]!.providerResults.map(result => [result.provider, result]))
    expect(results[CITED]).toMatchObject({ cited: true, mentioned: true, citationMeasured: true, error: null })
    // Search results only: not counted as cited, and the report says it was not measured.
    expect(results[RESULTS]).toMatchObject({ cited: false, mentioned: true, citationMeasured: false })
    expect(results[CITED]!.evidence?.identity.route).toBe(CITED)
    // No generation-capable provider was selected, so the fallback assessment ran and nothing else called the service.
    expect(stub.calls).toHaveLength(2)
    // The unmeasured answer is in the mention denominator only, never counted as "not cited".
    expect(report.summary).toMatchObject({ totalComparisons: 2, mentionCount: 2, citationCount: 1, citationComparisons: 1 })
    expect(report.summary.visibilityGap).toBe('Acme Roofing was mentioned in 2/2 successful provider responses and cited in 1/1 where citation was measured. Citation was not measured in 1 of them, because those providers do not tie their sources to the answer.')
    const markdown = formatSnapshotMarkdown(report)
    expect(markdown).toContain('| Results only · Fake Answers | Yes | Not measured |')
    expect(markdown).toContain('| Cited · Fake Answers | Yes | Yes |')
  })

  it('never says a company was not cited when no answer could measure citation', async () => {
    const stub = fakeFetch([{ json: fakeCompleteBody({ results: [{ url: 'https://acme-roofing.example/' }] }) }])
    const report = await new SnapshotService(registryWith(stub.impl, [])).createReport({ companyName: 'Acme Roofing', domain: 'acme-roofing.example', queries: ['best roofer'], providers: [RESULTS] })
    expect(report.queryResults[0]!.providerResults[0]).toMatchObject({ cited: false, mentioned: true, citationMeasured: false, error: null })
    expect(report.summary).toMatchObject({ totalComparisons: 1, mentionCount: 1, citationCount: 0, citationComparisons: 0 })
    expect(report.summary.visibilityGap).toBe('Acme Roofing was mentioned in 1/1 successful provider response. Citation was not measured, because that provider does not tie its sources to the answer.')
    expect(report.summary.visibilityGap).not.toContain('never linked or cited')
    expect(formatSnapshotText(report)).toContain('citation not measured')
    expect(formatSnapshotMarkdown(report)).toContain('| Yes | Not measured |')
  })

  it('refuses a profile that does not run snapshots and asks for queries when nothing can generate them', async () => {
    const service = new SnapshotService(registryWith(fakeFetch([{ json: fakeCompleteBody() }]).impl, []))
    await expect(service.createReport({ companyName: 'Acme Roofing', domain: 'acme-roofing.example', queries: ['best roofer'], providers: [STREAM] })).rejects.toThrow('does not run snapshots')
    await expect(service.createReport({ companyName: 'Acme Roofing', domain: 'acme-roofing.example', providers: [CITED] })).rejects.toThrow('requires a selected API provider that can generate text')
  })
})

describe('shared execution gate', () => {
  it('gives every profile of one service the same gate', () => {
    const registry = registryWith(fakeFetch([{ json: fakeCompleteBody() }]).impl, [])
    const gateFor = (name: string) => getSharedProviderExecutionGate(registry.connectionOf(name), 1, 10)
    expect(gateFor(CITED)).toBe(gateFor(RESULTS))
    expect(gateFor(CITED)).not.toBe(gateFor('gemini'))
  })
})
