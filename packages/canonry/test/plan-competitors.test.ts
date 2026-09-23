import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  measurementPlanV2ChecksumJson,
  type MeasurementPlanV2,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type RawQueryResult,
} from '@ainyc/canonry-contracts'
import { createRunCompetitorResolver, measurementPlanCompetitorDomains, measurementPlanCompetitors, queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, type DatabaseClient } from '@ainyc/canonry-db'
import { backfillProjectAnswerMentions } from '../src/commands/backfill.js'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const NOW = '2026-08-01T00:00:00.000Z'

/** One question for one Property, in a market group whose plan names one competitor. */
function plan(): MeasurementPlanV2 {
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'brand.example', ownedHosts: ['brand.example'], names: ['Brand Co'] } },
    targets: [{
      stableKey: 'property-001', label: 'property-001', aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'brand.example', pathPrefix: '/property-001', pathCase: 'insensitive' }],
      mentionNotApplicable: false, discoveryIdentity: null,
    }],
    groups: [{
      stableKey: 'metro', label: 'Metro', targetKeys: ['property-001'],
      competitors: [{ stableKey: 'competitor-rival', label: 'Rival Homes', domain: 'rivalhomes.example', aliases: ['Rival Homes'] }],
    }],
    querySnapshots: [{ queryId: 'q-1', queryText: 'best apartments in metro', provenance: { source: 'manual', sourceId: null, capturedAt: NOW } }],
    assignments: [{ targetKey: 'property-001', queryId: 'q-1', queryClass: 'non-brand', executionNodeKey: 'exec-1' }],
    executionNodes: [{
      stableKey: 'exec-1', queryId: 'q-1', queryText: 'best apartments in metro',
      context: { providers: ['openai'], models: { openai: 'gpt-planned' }, location: null }, expectedSnapshots: 1,
    }],
    usageEdges: [{ executionNodeKey: 'exec-1', targetKey: 'property-001', queryId: 'q-1' }],
    compiledChecksum: '0'.repeat(64),
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

function seed(): { db: DatabaseClient; projectId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-plan-competitors-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'planned', displayName: 'Brand Co', canonicalDomain: 'brand.example', aliases: ['Brand Co'],
    country: 'US', language: 'en', providers: [], locations: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'q-1', projectId, query: 'best apartments in metro', createdAt: NOW }).run()
  const revision = plan()
  const canonicalJson = canonicalMeasurementPlanV2Json(revision)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2, compiledChecksum: revision.compiledChecksum, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return { db, projectId }
}

const answer = 'Top picks:\n\n1. **Rival Homes** - newer buildings\n2. **Apartments.com** - browse listings'
const adapter: ProviderAdapter = {
  name: 'openai',
  validateConfig: () => ({ ok: true, provider: 'openai', message: 'ok' }),
  healthcheck: async () => ({ ok: true, provider: 'openai', message: 'ok' }),
  executeTrackedQuery: async (): Promise<RawQueryResult> => ({
    provider: 'openai', rawResponse: {}, model: 'gpt-planned', groundingSources: [], searchQueries: [],
    retrievalStatus: 'used', retrievalContract: 'search-required-v1',
  }),
  normalizeResult: (): NormalizedQueryResult => ({
    provider: 'openai', answerText: answer, citedDomains: ['rivalhomes.example', 'apartments.com'],
    groundingSources: [], searchQueries: [], retrievalStatus: 'used',
  }),
  generateText: async () => 'fake',
}

describe('a plan run is scored against the competitors its own revision names', () => {
  it('fills competitor overlap and recommendations with an empty project competitor list', async () => {
    const { db, projectId } = seed()
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('conflict')
    const registry = new ProviderRegistry()
    registry.register(adapter, { provider: 'openai', apiKey: 'k', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 } })
    await new JobRunner(db, registry).executeRun(queued.runId, projectId)

    const row = db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).get()!
    expect(row.competitorOverlap).toEqual(['rivalhomes.example'])
    // The cited listing site is where the answer sends people, not a rival.
    expect(row.recommendedCompetitors).toEqual(['Rival Homes'])
  })

  it('backfill rescores stored answers against the plan too', async () => {
    const { db, projectId } = seed()
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('conflict')
    const registry = new ProviderRegistry()
    registry.register(adapter, { provider: 'openai', apiKey: 'k', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 } })
    await new JobRunner(db, registry).executeRun(queued.runId, projectId)
    // Simulate a row written before this change: no overlap, a listing site recommended.
    db.update(querySnapshots).set({ competitorOverlap: [], recommendedCompetitors: ['Apartments.com'] }).where(eq(querySnapshots.runId, queued.runId)).run()

    const result = backfillProjectAnswerMentions(db, projectId)
    expect(result.updated).toBe(1)
    const row = db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).get()!
    expect(row.competitorOverlap).toEqual(['rivalhomes.example'])
    expect(row.recommendedCompetitors).toEqual(['Rival Homes'])
  })

  it('reads nothing for a missing revision', () => {
    const { db } = seed()
    expect(measurementPlanCompetitorDomains(db, null)).toEqual([])
    expect(measurementPlanCompetitorDomains(db, 'no-such-version')).toEqual([])
  })
})

describe('resolving a run\'s competitors', () => {
  it('collapses www, scheme and path forms of one competitor into a single domain', () => {
    const { db } = seed()
    const versionId = db.select().from(measurementPlanVersions).get()!.id
    const resolved = createRunCompetitorResolver(db, ['www.rivalhomes.example'])(versionId)
    expect(resolved.domains).toEqual(['www.rivalhomes.example'])
    expect(resolved.aliases.get('www.rivalhomes.example')).toEqual(['Rival Homes'])
  })

  it('a planless run gets exactly the project list and no plan names', () => {
    const { db } = seed()
    expect(createRunCompetitorResolver(db, ['a.example'])(null)).toEqual({ domains: ['a.example'], aliases: new Map() })
  })

  it('reads a v1 revision, whose groups name competitors as bare hosts', () => {
    const { db, projectId } = seed()
    const v1 = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'prefix', host: 'brand.example', pathPrefix: '/harbor', pathCase: 'insensitive' }], aliases: ['Harbor Homes'] }],
      groups: [{ stableKey: 'metro', label: 'Metro', targetKeys: ['harbor'], competitors: ['www.rivalhomes.example'] }],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-1'] }],
    }, {
      canonicalDomain: 'brand.example', ownedDomains: [], brandNames: ['Brand Co'],
      trackedQueries: [{ id: 'q-1', query: 'best apartments in metro' }], locations: [], defaultContext: null, expectedSnapshots: 1,
    })
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({ id: versionId, projectId, revision: 2, canonicalJson: canonicalMeasurementPlanJson(v1), checksum: 'a'.repeat(64), createdAt: NOW }).run()
    expect(measurementPlanCompetitors(db, versionId)).toEqual([{ domain: 'rivalhomes.example', aliases: [] }])
  })
})

describe('a plan competitor named but not cited', () => {
  it('counts in overlap through the plan\'s own names', async () => {
    const { db, projectId } = seed()
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('conflict')
    const registry = new ProviderRegistry()
    registry.register({
      ...adapter,
      normalizeResult: (): NormalizedQueryResult => ({
        provider: 'openai', answerText: 'Most people here pick Rival Homes for the newer buildings.',
        citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'used',
      }),
    }, { provider: 'openai', apiKey: 'k', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 } })
    await new JobRunner(db, registry).executeRun(queued.runId, projectId)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.runId, queued.runId)).get()!.competitorOverlap).toEqual(['rivalhomes.example'])
  })
})
