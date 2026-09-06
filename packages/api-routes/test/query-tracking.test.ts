import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalSimpleMeasurementDefinitionJson,
  canonicalMeasurementPlanV2Json,
  buildMeasurementRunManifestV1,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  auditLog,
  createClient,
  discoveryProbes,
  discoverySessions,
  measurementPlanVersions,
  measurementOperationReceipts,
  measurementPlans,
  measurementQueryTemplates,
  migrate,
  projects,
  queries,
  querySnapshots,
  researchRunQueries,
  researchRuns,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { sweepExpiredMeasurementReceipts } from '../src/measurement-draft-repo.js'

const ROOT_KEY = 'cnry_query_tracking_root'
const NOW = '2026-09-04T00:00:00.000Z'
const PROJECT = 'northwind'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let providerSummary: Array<{ name: string; configured: boolean; model?: string }>

function request(method: 'GET' | 'POST', pathName: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${pathName}`,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function workspace() {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

async function preview(payload: Record<string, unknown>) {
  const response = await request('POST', '/query-tracking/preview', payload)
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingPreviewResponseSchema.parse(response.json())
}

async function commit(payload: Record<string, unknown>) {
  return request('POST', '/query-tracking/commit', payload)
}

function seedAdvancedPlan() {
  const planWithoutChecksum = {
    schemaVersion: 2 as const,
    identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
    targets: [{
      stableKey: 'harbor-point', label: 'Harbor Point', aliases: ['Harbor Point'],
      urlMatchers: [{ kind: 'prefix' as const, host: 'northwind.example', pathPrefix: '/harbor-point', pathCase: 'insensitive' as const }],
      mentionNotApplicable: false, discoveryIdentity: null,
    }],
    groups: [{ stableKey: 'northbridge', label: 'Northbridge', targetKeys: ['harbor-point'], competitors: [] }],
    querySnapshots: [{
      queryId: 'q-existing', queryText: 'best apartments in northbridge',
      provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    }],
    assignments: [
      { targetKey: 'harbor-point', queryId: 'q-existing', queryClass: 'non-brand' as const, classificationSource: 'server' as const, executionNodeKey: 'exec-alpha' },
      { targetKey: 'harbor-point', queryId: 'q-existing', queryClass: 'non-brand' as const, classificationSource: 'server' as const, executionNodeKey: 'exec-beta' },
    ],
    executionNodes: [
      { stableKey: 'exec-alpha', queryId: 'q-existing', queryText: 'best apartments in northbridge', context: { providers: ['openai'], models: { openai: 'gpt-test' }, location: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' } }, expectedSnapshots: 1 },
      { stableKey: 'exec-beta', queryId: 'q-existing', queryText: 'best apartments in northbridge', context: { providers: ['gemini', 'openai'], models: { gemini: 'gemini-test', openai: 'gpt-test' }, location: { label: 'beta', city: 'Beta', region: 'BB', country: 'US' } }, expectedSnapshots: 2 },
    ],
    usageEdges: [
      { executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' },
      { executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' },
    ],
    reportingScopes: [{
      stableKey: 'alpha-market', label: 'Alpha', kind: 'market' as const,
      usageEdges: [{ executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' }],
    }],
    compiledChecksum: '0'.repeat(64),
  }
  const checksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(planWithoutChecksum)).digest('hex')
  const plan = measurementPlanV2Schema.parse({ ...planWithoutChecksum, compiledChecksum: checksum })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: 'project-northwind', revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, publishedBy: null, sourceDraftId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: 'project-northwind', activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
}

function activeV2Plan() {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-northwind')).get()!
  const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, pointer.activeVersionId)).get()!
  return { pointer, version, plan: measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson)) }
}

function rewriteActivePlan(mutate: (plan: Record<string, unknown>) => void) {
  const { version } = activeV2Plan()
  const draft = JSON.parse(version.canonicalJson) as Record<string, unknown>
  mutate(draft)
  const provisional = measurementPlanV2Schema.parse({ ...draft, compiledChecksum: '0'.repeat(64) })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  const plan = measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.update(measurementPlanVersions).set({
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    compiledChecksum,
  }).where(eq(measurementPlanVersions.id, version.id)).run()
  return plan
}

/** Alpha contains both Properties; only Harbor Point also belongs to Beta. */
function seedMultiMarketPlan() {
  seedAdvancedPlan()
  return rewriteActivePlan(plan => {
    const targets = plan.targets as Array<Record<string, unknown>>
    const groups = plan.groups as Array<Record<string, unknown>>
    const assignments = plan.assignments as Array<Record<string, unknown>>
    const usageEdges = plan.usageEdges as Array<Record<string, unknown>>
    const reportingScopes = plan.reportingScopes as Array<{ stableKey: string; label: string; kind: string; usageEdges: Array<Record<string, unknown>> }>
    targets.push({
      stableKey: 'river-point', label: 'River Point', aliases: ['River Point'],
      urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: '/river-point', pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    })
    groups.push({ stableKey: 'southbridge', label: 'Southbridge', targetKeys: ['river-point'], competitors: [] })
    const riverEdge = { executionNodeKey: 'exec-alpha', targetKey: 'river-point', queryId: 'q-existing' }
    assignments.push({ ...riverEdge, queryClass: 'non-brand', classificationSource: 'server' })
    usageEdges.push(riverEdge)
    reportingScopes[0]!.usageEdges.push(riverEdge)
    reportingScopes.push({
      stableKey: 'beta-market', label: 'Beta', kind: 'market',
      usageEdges: [{ executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' }],
    })
  })
}

function additionSource(pattern: string | null) {
  if (pattern === null) return { source: 'manual' as const, text: 'apartments with a rooftop terrace' }
  db.insert(measurementQueryTemplates).values({
    id: 'template-assignment', projectId: 'project-northwind', name: 'assignment template', description: null,
    pattern, variables: [...pattern.matchAll(/\{(\w+)\}/g)].map(match => match[1]!), createdAt: NOW, updatedAt: NOW,
  }).run()
  return { source: 'template' as const, templateId: 'template-assignment', templateVersion: NOW, template: pattern }
}

/** Insert only canonical, full-sweep evidence for the exact frozen v2 slots. */
function insertFrozenV2Run(opts: {
  id: string
  omitSlots?: readonly string[]
  finishedAt?: string
}): void {
  const { version, plan } = activeV2Plan()
  const omitted = new Set(opts.omitSlots ?? [])
  const manifest = buildMeasurementRunManifestV1({
    expectedSlots: plan.executionNodes.flatMap(node => node.context.providers.map(provider => ({
      executionId: node.stableKey,
      queryText: node.queryText,
      provider,
      context: node.context.location,
      ...(node.context.models[provider] ? { requestedModel: node.context.models[provider] } : {}),
    }))),
  })
  db.insert(runs).values({
    id: opts.id,
    projectId: 'project-northwind',
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: version.id,
    measurementManifest: manifest,
    finishedAt: opts.finishedAt ?? NOW,
    createdAt: opts.finishedAt ?? NOW,
  }).run()
  for (const node of plan.executionNodes) {
    for (const provider of node.context.providers) {
      if (omitted.has(`${node.stableKey}\u0000${provider}`)) continue
      const location = node.context.location
      db.insert(querySnapshots).values({
        id: `${opts.id}-${node.stableKey}-${provider}`,
        runId: opts.id,
        queryId: node.queryId,
        queryText: node.queryText,
        provider,
        model: node.context.models[provider] ?? null,
        citationState: 'not-cited',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        location: location?.label ?? null,
        measurementExecutionId: node.stableKey,
        requestedContext: location,
        supportedContext: location ? { status: 'applied', resolved: location } : null,
        createdAt: opts.finishedAt ?? NOW,
      }).run()
    }
  }
}

/** Insert a planless run with the exact sidecar JobRunner freezes at dispatch. */
function insertFrozenSimpleRun(opts: {
  id: string
  queryIds?: readonly string[]
  omitSlots?: readonly string[]
  finishedAt?: string
}): void {
  const project = db.select().from(projects).where(eq(projects.id, 'project-northwind')).get()!
  const selected = new Set(opts.queryIds ?? ['q-existing'])
  const rows = db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    .filter(query => selected.has(query.id))
  const providers = project.providers.length > 0 ? project.providers : ['gemini', 'openai']
  const location = project.defaultLocation
    ? project.locations.find(candidate => candidate.label === project.defaultLocation) ?? null
    : null
  const definition = buildSimpleMeasurementDefinition({
    capturedAt: opts.finishedAt ?? NOW,
    identity: {
      displayName: project.displayName,
      aliases: project.aliases,
      canonicalDomain: project.canonicalDomain,
      ownedDomains: project.ownedDomains,
    },
    country: project.country,
    language: project.language,
    location,
    engines: providers.map(provider => ({
      provider,
      requestedModel: project.providerModels[provider]
        ?? providerSummary.find(candidate => candidate.name === provider)?.model
        ?? null,
    })),
    queries: rows.map(query => ({ queryId: query.id, queryText: query.query, provenance: query.provenance })),
  })
  const stamp = opts.finishedAt ?? NOW
  db.insert(runs).values({
    id: opts.id,
    projectId: project.id,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    finishedAt: stamp,
    createdAt: stamp,
  }).run()
  db.insert(simpleMeasurementDefinitions).values({
    projectId: project.id,
    runId: opts.id,
    definition,
    checksum: crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex'),
    capturedAt: definition.capturedAt,
  }).run()
  const omitted = new Set(opts.omitSlots ?? [])
  for (const query of definition.queries) {
    for (const engine of definition.engines) {
      if (omitted.has(`${query.queryId}\u0000${engine.provider}`)) continue
      db.insert(querySnapshots).values({
        id: `${opts.id}-${query.queryId}-${engine.provider}`,
        runId: opts.id,
        queryId: query.queryId,
        queryText: query.queryText,
        provider: engine.provider,
        citationState: 'not-cited',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        location: location?.label ?? null,
        createdAt: stamp,
      }).run()
    }
  }
}

function seedOtherProject() {
  db.insert(projects).values({
    id: 'project-other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [], defaultLocation: null, createdAt: NOW, updatedAt: NOW,
  }).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-query-tracking-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: 'project-northwind', name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['gemini', 'openai'],
    providerModels: { gemini: 'gemini-test', openai: 'gpt-test' },
    locations: [
      { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' },
      { label: 'beta', city: 'Beta', region: 'BB', country: 'US' },
    ],
    defaultLocation: 'alpha', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-existing', projectId: 'project-northwind', query: 'best apartments in northbridge', provenance: 'cli', createdAt: NOW }).run()

  providerSummary = [
    { name: 'gemini', configured: true, model: 'gemini-test' },
    { name: 'openai', configured: true, model: 'gpt-test' },
  ]
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['gemini', 'openai'], providerSummary })
  await app.ready()
})

afterEach(async () => {
  vi.useRealTimers()
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('query tracking workspace: simple projects', () => {
  it('returns project-owned saved research and discovery candidates, then commits without provider work', async () => {
    db.insert(researchRuns).values({
      id: 'research-1', projectId: 'project-northwind', status: 'completed', provider: 'openai', requestedModel: null,
      resolvedModel: 'gpt-test', location: null, totalQueries: 1, completedQueries: 1, failedQueries: 0, createdAt: NOW,
    }).run()
    db.insert(researchRunQueries).values({
      id: 'research-query-1', researchRunId: 'research-1', position: 0, queryText: 'what is northwind', status: 'completed',
      requestedModel: null, resolvedModel: 'gpt-test', groundingSources: [], citedDomains: [], searchQueries: [],
      namedCompetitors: [], citedCompetitorDomains: [], createdAt: NOW,
    }).run()
    db.insert(discoverySessions).values({ id: 'discovery-1', projectId: 'project-northwind', status: 'completed', competitorMap: [], createdAt: NOW }).run()
    db.insert(discoveryProbes).values({
      id: 'discovery-probe-1', sessionId: 'discovery-1', projectId: 'project-northwind', query: 'northwind alternatives',
      citationState: 'not-cited', citedDomains: [], createdAt: NOW,
    }).run()

    const current = await workspace()
    expect(current.mode).toBe('simple')
    expect(current.savedSources.research.map(row => row.researchRunQueryId)).toEqual(['research-query-1'])
    expect(current.savedSources.discovery.map(row => row.discoveryProbeId)).toEqual(['discovery-probe-1'])

    const review = await preview({
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [
        { input: { source: 'manual', text: 'best apartments in northbridge' } },
        { input: { source: 'research', researchRunQueryId: 'research-query-1' } },
        { input: { source: 'discovery', discoveryProbeId: 'discovery-probe-1' } },
      ],
      removals: [],
    })
    expect(review.diff.reused.map(row => row.queryId)).toContain('q-existing')
    expect(review.diff.added).toHaveLength(2)

    const published = await commit({
      expectedWorkspaceVersion: current.workspaceVersion, previewToken: review.previewToken, reviewedAt: review.reviewedAt,
      additions: [
        { input: { source: 'manual', text: 'best apartments in northbridge' } },
        { input: { source: 'research', researchRunQueryId: 'research-query-1' } },
        { input: { source: 'discovery', discoveryProbeId: 'discovery-probe-1' } },
      ],
      removals: [],
    })
    expect(published.statusCode, published.body).toBe(200)
    expect(queryTrackingCommitResponseSchema.parse(published.json()).committed).toBe(true)
    expect(db.select().from(queries).where(eq(queries.projectId, 'project-northwind')).all()).toHaveLength(3)
    expect(db.select().from(runs).where(eq(runs.projectId, 'project-northwind')).all()).toHaveLength(0)
    const after = await workspace()
    expect(after.tracked.filter(row => row.queryText !== 'best apartments in northbridge').map(row => row.queryId).sort())
      .toEqual(review.diff.added.map(row => row.queryId).sort())
    expect(after.tracked.find(row => row.queryText === 'what is northwind')?.provenance)
      .toMatchObject({ source: 'research', sourceId: 'research-query-1' })
    expect(after.tracked.find(row => row.queryText === 'northwind alternatives')?.provenance)
      .toMatchObject({ source: 'discovery', sourceId: 'discovery-probe-1' })
  })

  it('rejects a commit after the reviewed workspace changes', async () => {
    const current = await workspace()
    const review = await preview({
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'new question' } }], removals: [],
    })
    db.insert(queries).values({ id: 'q-concurrent', projectId: 'project-northwind', query: 'concurrent question', provenance: null, createdAt: NOW }).run()

    const response = await commit({
      expectedWorkspaceVersion: current.workspaceVersion, previewToken: review.previewToken, reviewedAt: review.reviewedAt,
      additions: [{ input: { source: 'manual', text: 'new question' } }], removals: [],
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE' } })
  })

  it('freezes the server review time as manual provenance and rejects future or expired replay times', async () => {
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'manual question reviewed now' } }], removals: [],
    }
    const review = await preview(mutation)
    expect(review.reviewedAt).not.toBe(NOW)

    const future = await commit({
      ...mutation,
      previewToken: review.previewToken,
      reviewedAt: new Date(Date.now() + 2 * 60 * 1_000).toISOString(),
    })
    expect(future.statusCode).toBe(400)

    const expired = await commit({
      ...mutation,
      previewToken: review.previewToken,
      reviewedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
    })
    expect(expired.statusCode).toBe(400)

    const published = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(published.statusCode, published.body).toBe(200)
    expect((await workspace()).tracked.find(row => row.queryText === 'manual question reviewed now')?.provenance)
      .toMatchObject({ source: 'manual', sourceId: null, capturedAt: review.reviewedAt })
  })

  it('normalizes Unicode/whitespace identity, preserves a no-op, and refuses a tampered preview token', async () => {
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'Ｂｅｓｔ   apartments   in   northbridge' } }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.reused.map(row => row.queryId)).toEqual(['q-existing'])
    expect(review.diff.noOp).toBe(true)

    const bad = await commit({ ...mutation, previewToken: `qtp_${'0'.repeat(64)}`, reviewedAt: review.reviewedAt })
    expect(bad.statusCode).toBe(409)
    expect(bad.json()).toMatchObject({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE' } })

    const published = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(published.json())).toMatchObject({ committed: false, workspaceVersion: current.workspaceVersion })
    expect((await workspace()).workspaceVersion).toBe(current.workspaceVersion)
  })

  it('rejects saved sources owned by another project', async () => {
    seedOtherProject()
    db.insert(researchRuns).values({
      id: 'research-other', projectId: 'project-other', status: 'completed', provider: 'openai', requestedModel: null,
      resolvedModel: 'gpt-test', location: null, totalQueries: 1, completedQueries: 1, failedQueries: 0, createdAt: NOW,
    }).run()
    db.insert(researchRunQueries).values({
      id: 'research-query-other', researchRunId: 'research-other', position: 0, queryText: 'foreign research', status: 'completed',
      requestedModel: null, resolvedModel: 'gpt-test', groundingSources: [], citedDomains: [], searchQueries: [],
      namedCompetitors: [], citedCompetitorDomains: [], createdAt: NOW,
    }).run()
    const current = await workspace()
    const response = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'research', researchRunQueryId: 'research-query-other' } }], removals: [],
    })
    expect(response.statusCode).toBe(404)
  })

  it('keeps a frozen simple query tracked when a different query is added', async () => {
    insertFrozenSimpleRun({ id: 'simple-existing' })
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'tracked', lastMeasuredAt: NOW })

    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'apartments near northbridge parks' } }],
      removals: [],
    }
    const review = await preview(mutation)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)

    const after = await workspace()
    expect(after.tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'tracked', lastMeasuredAt: NOW })
    expect(after.tracked.find(row => row.queryText === 'apartments near northbridge parks'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it('invalidates only the edited simple query, not another query in the same frozen run', async () => {
    db.insert(queries).values({
      id: 'q-unaffected', projectId: 'project-northwind', query: 'northbridge pet policy', provenance: 'cli', createdAt: NOW,
    }).run()
    insertFrozenSimpleRun({ id: 'simple-two-queries', queryIds: ['q-existing', 'q-unaffected'] })
    expect((await workspace()).tracked.map(row => row.state)).toEqual(['tracked', 'tracked'])

    db.update(queries).set({ query: 'apartments near transit' }).where(eq(queries.id, 'q-existing')).run()
    const after = await workspace()
    expect(after.tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
    expect(after.tracked.find(row => row.queryId === 'q-unaffected'))
      .toMatchObject({ state: 'tracked', lastMeasuredAt: NOW })
  })

  it('treats a legacy simple run without a frozen sidecar as unknown', async () => {
    db.insert(runs).values({
      id: 'simple-legacy', projectId: 'project-northwind', kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      finishedAt: NOW, createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      id: 'simple-legacy-existing', runId: 'simple-legacy', queryId: 'q-existing', queryText: 'best apartments in northbridge', provider: 'gemini',
      citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: NOW,
    }).run()

    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it('does not complete a simple query when one frozen provider slot is absent', async () => {
    insertFrozenSimpleRun({ id: 'simple-missing-openai', omitSlots: ['q-existing\u0000openai'] })

    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it.each([
    ['project identity/classification', () => {
      db.update(projects).set({ aliases: ['Northbridge'] }).where(eq(projects.id, 'project-northwind')).run()
    }],
    ['provider roster', () => {
      db.update(projects).set({ providers: ['openai'], providerModels: { openai: 'gpt-test' } })
        .where(eq(projects.id, 'project-northwind')).run()
    }],
    ['explicit provider model', () => {
      db.update(projects).set({ providerModels: { gemini: 'gemini-next', openai: 'gpt-test' } })
        .where(eq(projects.id, 'project-northwind')).run()
    }],
    ['default location', () => {
      db.update(projects).set({ defaultLocation: 'beta' }).where(eq(projects.id, 'project-northwind')).run()
    }],
  ])('marks simple evidence awaiting when its %s changes', async (_name, mutate) => {
    insertFrozenSimpleRun({ id: `simple-${_name.replace(/[^a-z]+/gi, '-')}` })
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing')?.state).toBe('tracked')

    mutate()
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it('marks simple evidence awaiting when the registered default model changes', async () => {
    db.update(projects).set({ providerModels: {} }).where(eq(projects.id, 'project-northwind')).run()
    providerSummary.find(provider => provider.name === 'gemini')!.model = 'gemini-default-a'
    providerSummary.find(provider => provider.name === 'openai')!.model = 'gpt-default-a'
    insertFrozenSimpleRun({ id: 'simple-default-model' })
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing')?.state).toBe('tracked')

    providerSummary.find(provider => provider.name === 'gemini')!.model = 'gemini-default-b'
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })
})

describe('query tracking workspace: advanced portfolios', () => {
  it('reuses frozen executions and changes classification only in the selected market', async () => {
    seedMultiMarketPlan()
    const before = activeV2Plan()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'best apartments in northbridge' }, audience: { marketKeys: ['alpha-market'] }, queryClass: 'branded' }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.workload).toMatchObject({ addedNodes: 0, addedProviderCalls: 0, nextSweepProviderCalls: 3 })
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    const after = activeV2Plan().plan
    expect(after.executionNodes).toEqual(before.plan.executionNodes)
    expect(after.usageEdges).toEqual(before.plan.usageEdges)
    expect(after.assignments.filter(row => row.executionNodeKey === 'exec-alpha'))
      .toEqual(before.plan.assignments.filter(row => row.executionNodeKey === 'exec-alpha').map(row => ({ ...row, queryClass: 'branded', classificationSource: 'operator' })))
    expect(after.assignments.filter(row => row.executionNodeKey === 'exec-beta'))
      .toEqual(before.plan.assignments.filter(row => row.executionNodeKey === 'exec-beta'))
    expect(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, before.version.id)).get()).toEqual(before.version)
  })

  it('does not widen an explicit context classification change to another execution', async () => {
    seedAdvancedPlan()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'best apartments in northbridge' }, audience: { targetKeys: ['harbor-point'] }, contexts: [{ providers: ['openai'], models: { openai: 'gpt-test' }, location: 'alpha' }], queryClass: 'branded' }],
      removals: [],
    }
    const review = await preview(mutation)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    expect(activeV2Plan().plan.assignments.find(row => row.executionNodeKey === 'exec-beta'))
      .toMatchObject({ queryClass: 'non-brand', classificationSource: 'server' })
    expect(activeV2Plan().plan.executionNodes).toHaveLength(2)
  })

  it('refuses market-only reclassification of an execution also owned by an unselected market', async () => {
    seedMultiMarketPlan()
    rewriteActivePlan(plan => {
      const scopes = plan.reportingScopes as Array<{ stableKey: string; usageEdges: unknown[] }>
      scopes.find(row => row.stableKey === 'beta-market')!.usageEdges.push({ executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' })
    })
    const before = activeV2Plan()
    const current = await workspace()
    const response = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'best apartments in northbridge' }, audience: { marketKeys: ['alpha-market'] }, queryClass: 'branded' }], removals: [],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { message: expect.stringContaining('shared with another market') } })
    expect(activeV2Plan()).toEqual(before)
  })

  it('treats an equivalent legacy execution as a no-op and prefers the actively bound query identity', async () => {
    seedMultiMarketPlan()
    db.insert(queries).values({ id: 'q-older-duplicate', projectId: 'project-northwind', query: 'Ｂｅｓｔ  apartments in northbridge', createdAt: '2020-01-01T00:00:00.000Z' }).run()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'Ｂｅｓｔ  apartments in northbridge' }, audience: { marketKeys: ['alpha-market'] } }], removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(true)
    expect(review.diff.reused.map(row => row.queryId)).toEqual(['q-existing'])
    expect(review.workload).toMatchObject({ addedProviderCalls: 0, addedNodes: 0 })
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json())).toMatchObject({ committed: false, active: { revision: 1 } })
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
  })

  it.each(['simple', 'advanced'])('replays a lost %s commit response without another write', async mode => {
    if (mode === 'advanced') seedMultiMarketPlan()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'apartments with a rooftop terrace' }, ...(mode === 'advanced' ? { audience: { marketKeys: ['alpha-market'] } } : {}) }], removals: [],
    }
    const review = await preview(mutation)
    const payload = { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
    const responses = await Promise.all([commit(payload), commit(payload), commit(payload)])
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toEqual(responses[0]!.json())
    }
    expect(db.select().from(measurementOperationReceipts).all()).toHaveLength(1)
    expect(db.select().from(auditLog).all()).toHaveLength(1)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(mode === 'advanced' ? 2 : 0)
    expect(db.select().from(runs).all()).toHaveLength(0)
    const altered = await commit({ ...payload, additions: [{ input: { source: 'manual', text: 'another question' } }] })
    expect(altered.statusCode).toBe(409)
    expect(altered.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT' } })
  })

  it('recovers an expired review only when its original commit already succeeded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-05T12:00:00.000Z'))
    const current = await workspace()
    const mutation = { expectedWorkspaceVersion: current.workspaceVersion, additions: [{ input: { source: 'manual', text: 'apartments near a park' } }], removals: [] }
    const review = await preview(mutation)
    const payload = { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
    const first = await commit(payload)
    expect(first.statusCode, first.body).toBe(200)
    vi.setSystemTime(new Date('2026-09-05T12:20:00.000Z'))
    const replay = await commit(payload)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(first.json())

    db.update(measurementOperationReceipts).set({ expiresAt: '2026-09-05T12:20:00.000Z' }).run()
    const expired = await commit(payload)
    expect(expired.statusCode).toBe(400)
    expect(expired.json()).toMatchObject({ error: { message: expect.stringContaining('expired') } })
    expect(sweepExpiredMeasurementReceipts(db, new Date())).toBe(1)
    expect(db.select().from(measurementOperationReceipts).all()).toHaveLength(0)
  })

  it('checks write authorization before replaying a committed review', async () => {
    const current = await workspace()
    const mutation = { expectedWorkspaceVersion: current.workspaceVersion, additions: [{ input: { source: 'manual', text: 'apartments near a park' } }], removals: [] }
    const review = await preview(mutation)
    const payload = { ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt }
    const first = await commit(payload)
    expect(first.statusCode, first.body).toBe(200)
    db.update(apiKeys).set({ scopes: ['unrelated.write'] }).where(eq(apiKeys.keyHash, hashApiKey(ROOT_KEY))).run()
    const denied = await commit(payload)
    expect(denied.statusCode).toBe(403)
    expect(db.select().from(measurementOperationReceipts).all()).toHaveLength(1)
  })

  it('allows only one of two competing reviewed mutations to publish', async () => {
    seedMultiMarketPlan()
    const current = await workspace()
    const mutations = ['apartments near a park', 'apartments near a library'].map(text => ({
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: { source: 'manual', text }, audience: { marketKeys: ['alpha-market'] } }], removals: [],
    }))
    const reviews = await Promise.all(mutations.map(preview))
    const commits = await Promise.all(mutations.map((mutation, i) => commit({ ...mutation, previewToken: reviews[i]!.previewToken, reviewedAt: reviews[i]!.reviewedAt })))
    expect(commits.map(response => response.statusCode).sort()).toEqual([200, 409])
    expect(db.select().from(measurementOperationReceipts).all()).toHaveLength(1)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(2)
    expect(db.select().from(auditLog).all()).toHaveLength(1)
  })

  it('applies Whole site to every active Property with explicit contexts, and removes it globally', async () => {
    seedMultiMarketPlan()
    const original = activeV2Plan().version
    const current = await workspace()
    const addition = { input: additionSource(null) }
    const implicit = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion, additions: [addition], removals: [],
    })
    expect(implicit.statusCode).toBe(400)
    expect(implicit.json()).toMatchObject({ error: { message: expect.stringContaining('Select an execution context') } })
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ ...addition, contexts: [{ providers: ['openai'], models: { openai: 'gpt-test' }, location: 'alpha' }] }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.tracked.find(row => row.queryText === 'apartments with a rooftop terrace')?.assignments.map(row => row.targetKey).sort())
      .toEqual(['harbor-point', 'river-point'])
    expect(review.workload.addedProviderCalls).toBe(1)
    const published = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(published.statusCode, published.body).toBe(200)
    const queryId = review.diff.added[0]!.queryId
    const after = await workspace()
    const removal = { expectedWorkspaceVersion: after.workspaceVersion, additions: [], removals: [{ queryId }] }
    const removalReview = await preview(removal)
    const removed = await commit({ ...removal, previewToken: removalReview.previewToken, reviewedAt: removalReview.reviewedAt })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(activeV2Plan().plan.assignments.some(row => row.queryId === queryId)).toBe(false)
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toBeUndefined()
    expect(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, original.id)).get()).toEqual(original)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it.each([
    { kind: 'manual', pattern: null, output: 'apartments with a rooftop terrace' },
    { kind: 'variable-free template', pattern: 'apartments with a rooftop terrace', output: 'apartments with a rooftop terrace' },
    { kind: 'market template', pattern: 'apartments in {market}', output: 'apartments in Alpha' },
    { kind: 'property template', pattern: '{property} amenities', output: 'Harbor Point amenities' },
    { kind: 'combined template', pattern: '{property} amenities in {market}', output: 'Harbor Point amenities in Alpha' },
  ].flatMap(testCase => [
    { ...testCase, selection: 'Property', audience: { targetKeys: ['harbor-point'], marketKeys: ['alpha-market'] } },
    { ...testCase, selection: 'group', audience: { groupKeys: ['northbridge'], marketKeys: ['alpha-market'] } },
  ]))('keeps $kind scoped to an explicitly selected $selection within a shared market', async ({ pattern, output, audience }) => {
    seedMultiMarketPlan()
    const original = activeV2Plan().version
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: additionSource(pattern), audience }], removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.added.map(row => row.queryText)).toEqual([output])
    const added = review.tracked.find(row => row.queryText === output)!
    expect(added.assignments.map(row => row.targetKey)).toEqual(['harbor-point'])
    expect(added.assignments[0]?.queryClass).toBe(pattern?.includes('{property}') ? 'branded' : 'non-brand')
    expect(review.workload.addedProviderCalls).toBe(1)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    expect(activeV2Plan().plan.usageEdges.filter(edge => edge.queryId === added.queryId).map(edge => edge.targetKey)).toEqual(['harbor-point'])
    expect(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, original.id)).get()).toEqual(original)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it.each([
    { kind: 'manual', pattern: null, outputs: ['apartments with a rooftop terrace'], calls: 3 },
    { kind: 'variable-free template', pattern: 'apartments with a rooftop terrace', outputs: ['apartments with a rooftop terrace'], calls: 3 },
    { kind: 'market template', pattern: 'apartments in {market}', outputs: ['apartments in Alpha', 'apartments in Beta'], calls: 3 },
    { kind: 'property template', pattern: '{property} amenities', outputs: ['Harbor Point amenities', 'River Point amenities'], calls: 4 },
    { kind: 'combined template', pattern: '{property} amenities in {market}', outputs: ['Harbor Point amenities in Alpha', 'Harbor Point amenities in Beta', 'River Point amenities in Alpha'], calls: 4 },
  ])('keeps every market on its own frozen contexts for $kind and makes retry a no-op', async ({ pattern, outputs, calls }) => {
    seedMultiMarketPlan()
    const original = activeV2Plan().version
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: additionSource(pattern), audience: { marketKeys: ['alpha-market', 'beta-market'] } }], removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.added.map(row => row.queryText).sort()).toEqual([...outputs].sort())
    expect(review.workload.addedProviderCalls).toBe(calls)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    const { plan, version } = activeV2Plan()
    const addedIds = new Set(review.diff.added.map(row => row.queryId))
    const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
    for (const market of plan.reportingScopes ?? []) {
      const edges = market.usageEdges.filter(edge => addedIds.has(edge.queryId))
      expect(edges.length).toBeGreaterThan(0)
      expect([...new Set(edges.map(edge => nodes.get(edge.executionNodeKey)?.context.location?.label))])
        .toEqual([market.stableKey === 'alpha-market' ? 'alpha' : 'beta'])
      expect([...new Set(edges.map(edge => edge.targetKey))].sort())
        .toEqual(market.stableKey === 'alpha-market' ? ['harbor-point', 'river-point'] : ['harbor-point'])
    }
    expect(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, original.id)).get()).toEqual(original)
    const after = await workspace()
    const retry = { ...mutation, expectedWorkspaceVersion: after.workspaceVersion }
    const retryReview = await preview(retry)
    expect(retryReview.diff.noOp).toBe(true)
    expect(retryReview.workload).toMatchObject({ addedProviderCalls: 0, removedProviderCalls: 0 })
    const retried = await commit({ ...retry, previewToken: retryReview.previewToken, reviewedAt: retryReview.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(retried.json()).committed).toBe(false)
    expect(activeV2Plan().version).toEqual(version)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it.each([
    { targetKeys: ['river-point'], marketKeys: ['beta-market'] },
    { targetKeys: ['harbor-point', 'river-point'], marketKeys: ['beta-market'] },
    { groupKeys: ['southbridge'], marketKeys: ['alpha-market', 'beta-market'] },
  ])('rejects an explicit audience that cannot belong to the selected markets: %j', async audience => {
    seedMultiMarketPlan()
    const current = await workspace()
    const response = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: additionSource(null), audience }], removals: [],
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
  })

  it('partitions explicit contexts by frozen market membership and rejects incompatible contexts', async () => {
    seedMultiMarketPlan()
    const current = await workspace()
    const input = additionSource(null)
    const audience = { targetKeys: ['harbor-point'], marketKeys: ['alpha-market', 'beta-market'] }
    const contexts = [
      { providers: ['openai'], models: { openai: 'gpt-test' }, location: 'alpha' },
      { providers: ['gemini', 'openai'], models: { gemini: 'gemini-test', openai: 'gpt-test' }, location: 'beta' },
    ]
    const mutation = { expectedWorkspaceVersion: current.workspaceVersion, additions: [{ input, audience, contexts }], removals: [] }
    const review = await preview(mutation)
    expect(review.workload.addedProviderCalls).toBe(3)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    const { plan } = activeV2Plan()
    const addedId = review.diff.added[0]!.queryId
    const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
    for (const market of plan.reportingScopes ?? []) {
      expect(market.usageEdges.filter(edge => edge.queryId === addedId).map(edge => nodes.get(edge.executionNodeKey)?.context.location?.label))
        .toEqual([market.stableKey === 'alpha-market' ? 'alpha' : 'beta'])
    }
    const after = await workspace()
    for (const invalidContexts of [
      [contexts[0]!],
      [...contexts, { providers: ['openai'], models: { openai: 'gpt-test' }, location: null }],
    ]) {
      const invalid = await request('POST', '/query-tracking/preview', {
        expectedWorkspaceVersion: after.workspaceVersion,
        additions: [{ input, audience, contexts: invalidContexts }], removals: [],
      })
      expect(invalid.statusCode, invalid.body).toBe(400)
    }
  })

  it('resolves replacement market contexts from the frozen plan even when removing its last query first', async () => {
    seedMultiMarketPlan()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{ input: additionSource(null), audience: { marketKeys: ['alpha-market', 'beta-market'] } }],
      removals: [{ queryId: 'q-existing' }],
    }
    const review = await preview(mutation)
    expect(review.workload).toMatchObject({ addedProviderCalls: 3, removedProviderCalls: 3, nextSweepProviderCalls: 3 })
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    expect(activeV2Plan().plan.reportingScopes?.map(scope => scope.usageEdges.length)).toEqual([2, 1])
  })

  it('preserves full contexts, assigns a template through a market edge, and publishes no provider work', async () => {
    seedAdvancedPlan()
    db.insert(measurementQueryTemplates).values({
      id: 'template-1', projectId: 'project-northwind', name: 'property market', description: null,
      pattern: 'best {property} apartments in {market}', variables: ['property', 'market'], createdAt: NOW, updatedAt: NOW,
    }).run()
    const current = await workspace()
    expect(current.mode).toBe('advanced')
    expect(current.tracked[0]?.assignments[0]?.contexts).toHaveLength(2)
    expect(current.tracked[0]?.assignments[0]?.marketKeys).toEqual(['alpha-market'])

    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{
        input: { source: 'template', templateId: 'template-1', templateVersion: NOW, template: 'best {property} apartments in {market}' },
        audience: { marketKeys: ['alpha-market'] },
      }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.added.map(row => row.queryText)).toEqual(['best Harbor Point apartments in Alpha'])
    expect(review.workload.existingProviderCalls).toBe(3)
    expect(review.workload.addedProviderCalls).toBe(1)

    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(response.statusCode, response.body).toBe(200)
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    const active = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, 'project-northwind')).get()!
    const version = db.select().from(measurementPlanVersions).where(and(
      eq(measurementPlanVersions.projectId, 'project-northwind'), eq(measurementPlanVersions.id, active.activeVersionId),
    )).get()!
    const plan = measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson))
    expect(plan.reportingScopes?.[0]?.usageEdges).toHaveLength(2)
    expect(plan.querySnapshots.find(query => query.queryText.includes('Harbor Point'))?.provenance.template?.bindings)
      .toEqual({ market: 'Alpha', property: 'Harbor Point' })
    expect(plan.executionNodes.filter(node => node.queryText.includes('Harbor Point')).map(node => node.context.location?.label))
      .toEqual(['alpha'])
  })

  it('requires an explicit context for a new group assignment instead of fanning out to every project location', async () => {
    seedAdvancedPlan()
    const current = await workspace()
    const addition = {
      input: { source: 'manual', text: 'Harbor Point apartment amenities' },
      audience: { groupKeys: ['northbridge'] },
    }

    const implicit = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [addition], removals: [],
    })
    expect(implicit.statusCode).toBe(400)
    expect(implicit.json()).toMatchObject({ error: { message: expect.stringContaining('Select an execution context') } })

    const review = await preview({
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{
        ...addition,
        contexts: [{
          providers: ['gemini', 'openai'],
          models: { gemini: 'gemini-test', openai: 'gpt-test' },
          location: 'alpha',
        }],
      }],
      removals: [],
    })
    expect(review.workload).toMatchObject({ addedNodes: 1, addedProviderCalls: 2 })
    expect(review.tracked.find(row => row.queryText === 'Harbor Point apartment amenities')?.assignments[0]?.contexts)
      .toEqual([{
        providers: ['gemini', 'openai'],
        models: { gemini: 'gemini-test', openai: 'gpt-test' },
        location: { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' },
      }])
  })

  it('removes an unshared market edge from future execution without touching another market context', async () => {
    seedAdvancedPlan()
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [],
      removals: [{ queryId: 'q-existing', audience: { marketKeys: ['alpha-market'] } }],
    }
    const review = await preview(mutation)
    expect(review.diff.removed.find(row => row.queryId === 'q-existing')?.assignmentCount).toBe(1)
    expect(review.workload).toMatchObject({
      existingProviderCalls: 3,
      nextSweepProviderCalls: 2,
      removedNodes: 1,
      removedProviderCalls: 1,
    })

    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    const plan = activeV2Plan().plan
    expect(plan.executionNodes.map(node => node.stableKey)).toEqual(['exec-beta'])
    expect(plan.usageEdges).toEqual([{ executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' }])
    expect(plan.reportingScopes?.find(scope => scope.stableKey === 'alpha-market')?.usageEdges).toEqual([])
  })

  it('keeps an exact market edge executable while another market still owns that same frozen triple', async () => {
    seedAdvancedPlan()
    rewriteActivePlan(plan => {
      const scopes = plan.reportingScopes as Array<Record<string, unknown>>
      scopes.push({
        stableKey: 'beta-market', label: 'Beta', kind: 'market',
        usageEdges: [
          { executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' },
          { executionNodeKey: 'exec-beta', targetKey: 'harbor-point', queryId: 'q-existing' },
        ],
      })
    })
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [],
      removals: [{ queryId: 'q-existing', audience: { marketKeys: ['alpha-market'] } }],
    }
    const review = await preview(mutation)
    expect(review.diff.removed.find(row => row.queryId === 'q-existing')?.assignmentCount).toBe(1)
    expect(review.workload).toMatchObject({ removedNodes: 0, removedProviderCalls: 0, nextSweepProviderCalls: 3 })

    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    const plan = activeV2Plan().plan
    expect(plan.executionNodes.map(node => node.stableKey)).toEqual(['exec-alpha', 'exec-beta'])
    expect(plan.reportingScopes?.find(scope => scope.stableKey === 'alpha-market')?.usageEdges).toEqual([])
    expect(plan.reportingScopes?.find(scope => scope.stableKey === 'beta-market')?.usageEdges)
      .toContainEqual({ executionNodeKey: 'exec-alpha', targetKey: 'harbor-point', queryId: 'q-existing' })
  })

  it('leaves an already-assigned question untouched and never publishes a duplicate revision', async () => {
    seedAdvancedPlan()
    const current = await workspace()
    const pointerBefore = activeV2Plan().pointer.activeVersionId
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{
        input: { source: 'manual', text: 'best apartments in northbridge' },
        audience: { targetKeys: ['harbor-point'] },
      }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(true)
    expect(review.workload).toMatchObject({ existingProviderCalls: 3, nextSweepProviderCalls: 3, addedProviderCalls: 0 })
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json())).toMatchObject({ committed: false, active: { revision: 1 } })
    expect(activeV2Plan().pointer.activeVersionId).toBe(pointerBefore)
  })

  it('keeps an operator class override frozen when a later automatic addition reuses the question', async () => {
    seedAdvancedPlan()
    insertFrozenV2Run({ id: 'before-class-override' })
    const first = await workspace()
    expect(first.tracked.find(row => row.queryId === 'q-existing')).toMatchObject({ state: 'tracked', lastMeasuredAt: NOW })
    const mutation = {
      expectedWorkspaceVersion: first.workspaceVersion,
      additions: [{
        input: { source: 'manual', text: 'best apartments in northbridge' },
        audience: { targetKeys: ['harbor-point'] },
        queryClass: 'branded',
      }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.diff.noOp).toBe(false)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    expect(activeV2Plan().plan.assignments.every(assignment => assignment.queryClass === 'branded' && assignment.classificationSource === 'operator')).toBe(true)
    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })

    const second = await workspace()
    const automatic = await preview({
      expectedWorkspaceVersion: second.workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'best apartments in northbridge' }, audience: { targetKeys: ['harbor-point'] } }],
      removals: [],
    })
    expect(automatic.diff.noOp).toBe(true)
  })

  it('removes one group assignment without broadening that removal to another Property', async () => {
    seedAdvancedPlan()
    rewriteActivePlan(plan => {
      const targets = plan.targets as Array<Record<string, unknown>>
      const groups = plan.groups as Array<Record<string, unknown>>
      const assignments = plan.assignments as Array<Record<string, unknown>>
      const usageEdges = plan.usageEdges as Array<Record<string, unknown>>
      targets.push({
        stableKey: 'river-point', label: 'River Point', aliases: ['River Point'],
        urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: '/river-point', pathCase: 'insensitive' }],
        mentionNotApplicable: false, discoveryIdentity: null,
      })
      groups.push({ stableKey: 'southbridge', label: 'Southbridge', targetKeys: ['river-point'], competitors: [] })
      assignments.push({ targetKey: 'river-point', queryId: 'q-existing', queryClass: 'non-brand', classificationSource: 'server', executionNodeKey: 'exec-alpha' })
      usageEdges.push({ executionNodeKey: 'exec-alpha', targetKey: 'river-point', queryId: 'q-existing' })
    })
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [],
      removals: [{ queryId: 'q-existing', audience: { groupKeys: ['northbridge'] } }],
    }
    const review = await preview(mutation)
    expect(review.diff.removed.find(row => row.queryId === 'q-existing')?.assignmentCount).toBe(2)
    expect(review.diff.noOp).toBe(false)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    expect(activeV2Plan().plan.assignments.map(assignment => assignment.targetKey)).toEqual(['river-point'])
  })

  it('keeps a combined group removal and new group assignment isolated to their selected Properties', async () => {
    seedAdvancedPlan()
    rewriteActivePlan(plan => {
      const targets = plan.targets as Array<Record<string, unknown>>
      const groups = plan.groups as Array<Record<string, unknown>>
      targets.push({
        stableKey: 'river-point', label: 'River Point', aliases: ['River Point'],
        urlMatchers: [{ kind: 'prefix', host: 'northwind.example', pathPrefix: '/river-point', pathCase: 'insensitive' }],
        mentionNotApplicable: false, discoveryIdentity: null,
      })
      groups.push({ stableKey: 'southbridge', label: 'Southbridge', targetKeys: ['river-point'], competitors: [] })
    })
    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{
        input: { source: 'manual', text: 'River Point apartment amenities' },
        audience: { groupKeys: ['southbridge'] },
        contexts: [{ providers: ['gemini'], models: { gemini: 'gemini-test' }, location: 'alpha' }],
      }],
      removals: [{ queryId: 'q-existing', audience: { groupKeys: ['northbridge'] } }],
    }
    const review = await preview(mutation)
    expect(review.workload).toMatchObject({ addedProviderCalls: 1, removedProviderCalls: 3, nextSweepProviderCalls: 1 })

    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    const plan = activeV2Plan().plan
    const riverQuery = plan.querySnapshots.find(snapshot => snapshot.queryText === 'River Point apartment amenities')
    expect(riverQuery).toBeDefined()
    expect(plan.assignments).toEqual([expect.objectContaining({ targetKey: 'river-point', queryId: riverQuery?.queryId })])
    expect(plan.usageEdges).toEqual([expect.objectContaining({ targetKey: 'river-point', queryId: riverQuery?.queryId })])
  })

  it('keeps unchanged frozen assignments measured after a material publish, while new work awaits a sweep', async () => {
    seedAdvancedPlan()
    seedOtherProject()
    db.insert(runs).values({
      id: 'foreign-run', projectId: 'project-other', kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      measurementPlanVersionId: null, finishedAt: NOW, createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      id: 'foreign-snapshot', runId: 'foreign-run', queryId: 'q-existing', queryText: 'best apartments in northbridge', provider: 'openai',
      citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: NOW,
    }).run()
    expect((await workspace()).tracked[0]?.state).toBe('awaiting-sweep')

    insertFrozenV2Run({ id: 'local-run' })
    expect((await workspace()).tracked[0]?.state).toBe('tracked')

    const current = await workspace()
    const mutation = {
      expectedWorkspaceVersion: current.workspaceVersion,
      additions: [{
        input: { source: 'manual', text: 'apartments near northbridge parks' },
        audience: { targetKeys: ['harbor-point'] },
        contexts: [{ providers: ['gemini'], models: { gemini: 'gemini-test' }, location: 'alpha' }],
      }],
      removals: [],
    }
    const review = await preview(mutation)
    expect(review.workload.addedProviderCalls).toBe(1)
    const response = await commit({ ...mutation, previewToken: review.previewToken, reviewedAt: review.reviewedAt })
    expect(queryTrackingCommitResponseSchema.parse(response.json()).committed).toBe(true)
    const after = await workspace()
    expect(after.tracked.find(row => row.queryId === 'q-existing')).toMatchObject({ state: 'tracked', lastMeasuredAt: NOW })
    expect(after.tracked.find(row => row.queryText === 'apartments near northbridge parks'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it('does not mark an execution context measured when one frozen provider slot is missing', async () => {
    seedAdvancedPlan()
    insertFrozenV2Run({ id: 'missing-beta-openai', omitSlots: ['exec-beta\u0000openai'] })

    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })

  it('does not let one fully measured context make another context for the same query tracked', async () => {
    seedAdvancedPlan()
    insertFrozenV2Run({ id: 'missing-alpha-openai', omitSlots: ['exec-alpha\u0000openai'] })

    expect((await workspace()).tracked.find(row => row.queryId === 'q-existing'))
      .toMatchObject({ state: 'awaiting-sweep', lastMeasuredAt: null })
  })
})
