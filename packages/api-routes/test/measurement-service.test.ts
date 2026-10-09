import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  measurementDiscoveryResponseSchema,
  measurementPlanResponseSchema,
  measurementReportResponseSchema,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { hashApiKey } from '../src/auth.js'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementRunManifest } from '../src/measurement-report-adapter.js'

const ROOT_KEY = 'cnry_measurement_root'
const PLAN_KEY = 'cnry_measurement_plan'
const RUNS_KEY = 'cnry_measurement_runs'
const READ_KEY = 'cnry_measurement_read'
const CREATED_AT = '2026-08-01T12:00:00.000Z'
const LEGACY_CREATED_AT = '2026-07-31T12:00:00.000Z'

let directory: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let queryId: string
const fetchSitemap = vi.fn()

function seedKey(name: string, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: CREATED_AT,
  }).run()
}

function request(method: 'GET' | 'POST' | 'PUT', url: string, token = ROOT_KEY, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

function discoveryRequest() {
  return {
    sitemapUrl: 'https://northstar.example/sitemap.xml',
    rule: {
      primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' },
      aliases: [{ host: 'homes.northstar.example', pathTemplate: '/{slug}' }],
      excludedSlugSuffixes: ['-region'],
    },
  }
}

async function publishPlan() {
  const response = await request('PUT', '/api/v1/projects/northstar/measurement-plan', ROOT_KEY, {
    expectedActiveRevision: null,
    plan: {
      schemaVersion: 1,
      targets: [{
        stableKey: 'harbor',
        label: 'Harbor Homes',
        urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        aliases: ['Harbor Homes'],
      }],
      groups: [{
        stableKey: 'regional',
        label: 'Regional comparison',
        targetKeys: ['harbor'],
        competitors: ['challenger.example'],
      }],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: [queryId] }],
    },
  })
  expect(response.statusCode).toBe(201)
  return measurementPlanResponseSchema.parse(response.json()).active!
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-service-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('plan', PLAN_KEY, ['measurement-plan.write'])
  seedKey('runs', RUNS_KEY, ['runs.write'])
  seedKey('read', READ_KEY, ['read'])
  fetchSitemap.mockReset().mockResolvedValue({
    fetchedSitemaps: 1,
    urls: [
      'https://northstar.example/locations/harbor/',
      'https://homes.northstar.example/harbor/',
      'https://northstar.example/locations/lake-region/',
      'https://northstar.example/locations/',
      'https://northstar.example/about/',
    ],
  })

  app = Fastify()
  app.register(apiRoutes, {
    db,
    getRunnableProviderNames: () => ['gemini', 'openai'],
    fetchMeasurementSitemap: fetchSitemap,
  })
  await app.ready()

  expect((await request('PUT', '/api/v1/projects/northstar', ROOT_KEY, {
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    ownedDomains: ['homes.northstar.example'],
    country: 'US',
    language: 'en',
    locations: [{ label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' }],
    defaultLocation: 'Harbor',
  })).statusCode).toBe(201)
  expect((await request('POST', '/api/v1/projects/northstar/queries', ROOT_KEY, {
    queries: ['homes near harbor'],
  })).statusCode).toBe(200)
  const project = db.select().from(projects).where(eq(projects.name, 'northstar')).get()!
  queryId = db.select().from(queries).where(eq(queries.projectId, project.id)).get()!.id
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement discovery route', () => {
  it('fetches once and returns the deterministic five-class review payload', async () => {
    const response = await request('POST', '/api/v1/projects/northstar/measurement-discovery', PLAN_KEY, discoveryRequest())
    expect(response.statusCode).toBe(200)
    const body = measurementDiscoveryResponseSchema.parse(response.json())
    expect(fetchSitemap).toHaveBeenCalledWith('https://northstar.example/sitemap.xml')
    expect(body).toEqual({
      proposed: [{
        classification: 'proposed', reason: 'primary-match', stableKey: 'target-harbor', slug: 'harbor', label: 'Harbor',
        primaryUrl: 'https://northstar.example/locations/harbor',
        aliasCoverageUrls: ['https://homes.northstar.example/harbor'],
      }],
      aliases: [{
        classification: 'alias', reason: 'exact-slug-match', slug: 'harbor',
        url: 'https://homes.northstar.example/harbor', targetStableKey: 'target-harbor',
      }],
      shared: [{
        url: 'https://northstar.example/locations', canonicalUrl: 'https://northstar.example/locations',
        classification: 'shared', reason: 'shared-path',
      }],
      unmatched: [{
        url: 'https://northstar.example/about', canonicalUrl: 'https://northstar.example/about',
        classification: 'unmatched', reason: 'unmatched-path',
      }],
      excluded: [{
        url: 'https://northstar.example/locations/lake-region', canonicalUrl: 'https://northstar.example/locations/lake-region',
        classification: 'excluded', reason: 'excluded-slug',
      }],
      diagnostics: [],
    })
  })

  it('requires plan-write authority and surfaces bounded fetch failure without classifying', async () => {
    expect((await request('POST', '/api/v1/projects/northstar/measurement-discovery', RUNS_KEY, discoveryRequest())).statusCode).toBe(403)
    expect((await request('POST', '/api/v1/projects/northstar/measurement-discovery', READ_KEY, discoveryRequest())).statusCode).toBe(403)
    expect(fetchSitemap).not.toHaveBeenCalled()

    fetchSitemap.mockRejectedValueOnce(new Error('HTTP 503'))
    const failed = await request('POST', '/api/v1/projects/northstar/measurement-discovery', PLAN_KEY, discoveryRequest())
    expect(failed.statusCode).toBe(502)
    expect(failed.json()).toEqual({ error: { code: 'DELIVERY_FAILED', message: 'Unable to fetch sitemap: HTTP 503' } })
  })
})

describe('measurement report route', () => {
  it('maps a published revision and stored plan-aware snapshots field-for-field without live work', async () => {
    const active = await publishPlan()
    const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.revision, 1)).get()!
    const manifest = buildMeasurementRunManifest(active.plan, ['gemini', 'openai'])
    const executionId = active.plan.executionNodes[0]!.stableKey
    const project = db.select().from(projects).where(eq(projects.name, 'northstar')).get()!
    const context = active.plan.executionNodes[0]!.context

    db.insert(runs).values({
      id: 'run-measurement-1', projectId: project.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      location: 'Harbor', queries: ['homes near harbor'], measurementPlanVersionId: version.id,
      measurementManifest: manifest, createdAt: CREATED_AT, startedAt: CREATED_AT, finishedAt: CREATED_AT,
    }).run()
    db.insert(querySnapshots).values([
      {
        id: 'snapshot-openai', runId: 'run-measurement-1', queryId, queryText: 'homes near harbor', provider: 'openai',
        citationState: 'cited', answerMentioned: true, answerText: 'Northstar recommends Harbor Homes.',
        citedDomains: ['northstar.example'], citedUrls: ['https://northstar.example/locations/harbor'], captureStatus: 'complete',
        competitorOverlap: [], recommendedCompetitors: [], location: 'Harbor', measurementExecutionId: executionId,
        requestedContext: context, supportedContext: { status: 'applied', resolved: context }, createdAt: CREATED_AT,
      },
      {
        id: 'snapshot-gemini', runId: 'run-measurement-1', queryId, queryText: 'homes near harbor', provider: 'gemini',
        citationState: 'cited', answerMentioned: true, answerText: 'Northstar recommends Harbor Homes.',
        citedDomains: ['northstar.example'], citedUrls: ['https://northstar.example/locations/harbor'], captureStatus: 'complete',
        competitorOverlap: [], recommendedCompetitors: [], location: 'Harbor', measurementExecutionId: executionId,
        requestedContext: context, supportedContext: { status: 'applied', resolved: context }, createdAt: CREATED_AT,
      },
    ]).run()

    const response = await request('GET', '/api/v1/projects/northstar/measurement-report?revision=1', READ_KEY)
    expect(response.statusCode).toBe(200)
    const body = measurementReportResponseSchema.parse(response.json())
    const completeness = { executed: 2, expected: 2, complete: true, sourceComplete: true, sourceCompleteObservations: 2, answerComplete: true }
    const fullRate = { numerator: 2, denominator: 2, rate: 1 }
    const providerCompleteness = { executed: 1, expected: 1, complete: true, sourceComplete: true, sourceCompleteObservations: 1, answerComplete: true }
    const providerRate = { numerator: 1, denominator: 1, rate: 1 }
    const baselineEdgeId = `baseline:${queryId}:${executionId}`
    const targetEdgeId = `target:harbor:${queryId}:${executionId}`
    const evidenceFor = (provider: 'gemini' | 'openai', usageEdgeId: string, usageEdgeType: 'baseline' | 'target') => ({
      observationId: `snapshot-${provider}`,
      expectedSlotId: `slot:${executionId}:${provider}`,
      executionId,
      usageEdgeId,
      usageEdgeType,
      provider,
      queryText: 'homes near harbor',
      location: 'Harbor',
      sourceUrl: 'https://northstar.example/locations/harbor',
      bridged: false,
      historical: false,
      evidenceComplete: true,
      classification: usageEdgeType === 'target' ? 'assigned' as const : 'sibling' as const,
      normalizedUrl: 'https://northstar.example/locations/harbor',
      matchedTargetIds: ['harbor'],
      matchedUrlIds: ['harbor:url:0'],
    })
    const sovDomains = [
      { domain: 'northstar.example', own: true, presentIn: 2, of: 2 },
      { domain: 'challenger.example', own: false, presentIn: 0, of: 2 },
    ]

    expect(body).toEqual({
      revision: 1,
      queryClass: null,
      run: { id: 'run-measurement-1', status: 'completed', createdAt: CREATED_AT, startedAt: CREATED_AT, finishedAt: CREATED_AT },
      groups: [{
        id: 'regional', label: 'Regional comparison', targetIds: ['harbor'], completeness,
        answerCoverage: fullRate, targetCoverage: { numerator: 1, denominator: 1, rate: 1 },
        sov: {
          domains: sovDomains,
          providers: ['gemini', 'openai'].map(provider => ({
            provider,
            domains: [
              { domain: 'northstar.example', own: true, presentIn: 1, of: 1 },
              { domain: 'challenger.example', own: false, presentIn: 0, of: 1 },
            ],
          })),
        },
        providers: ['gemini', 'openai'].map(provider => ({ provider, completeness: providerCompleteness, answerCoverage: providerRate })),
      }],
      targets: [{
        id: 'harbor', label: 'Harbor Homes', completeness, citationCoverage: fullRate, mentionCoverage: fullRate,
        providers: ['gemini', 'openai'].map(provider => ({
          provider, completeness: providerCompleteness, citationCoverage: providerRate, mentionCoverage: providerRate,
        })),
      }],
      evidence: [
        evidenceFor('gemini', baselineEdgeId, 'baseline'),
        evidenceFor('gemini', targetEdgeId, 'target'),
        evidenceFor('openai', baselineEdgeId, 'baseline'),
        evidenceFor('openai', targetEdgeId, 'target'),
      ],
      diagnostics: {
        bridgedObservationIds: [], historicalObservationIds: [],
        evidenceIncompleteObservationIds: [], ambiguousObservationIds: [], unmatchedObservationIds: [],
      },
    })

    db.insert(runs).values({
      id: 'run-measurement-2', projectId: project.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      location: 'Harbor', queries: ['homes near harbor'], measurementPlanVersionId: version.id,
      measurementManifest: manifest, createdAt: '2026-08-01T13:00:00.000Z',
      startedAt: '2026-08-01T13:00:00.000Z', finishedAt: '2026-08-01T13:00:00.000Z',
    }).run()
    const pinned = await request(
      'GET',
      '/api/v1/projects/northstar/measurement-report?revision=1&runId=run-measurement-1',
      READ_KEY,
    )
    expect(pinned.statusCode).toBe(200)
    expect(measurementReportResponseSchema.parse(pinned.json()).run?.id).toBe('run-measurement-1')
    expect((await request(
      'GET',
      '/api/v1/projects/northstar/measurement-report?revision=1&runId=run-unknown',
      READ_KEY,
    )).statusCode).toBe(404)
    expect((await request('GET', '/api/v1/projects/northstar/measurement-report?revision=2', READ_KEY)).statusCode).toBe(404)
    // This v1 revision records no class: every answer is read, and a request
    // for one class is refused rather than answered with unclassified answers.
    const pooled = await request('GET', '/api/v1/projects/northstar/measurement-report?revision=1&queryClass=all', READ_KEY)
    expect(pooled.statusCode).toBe(200)
    expect(measurementReportResponseSchema.parse(pooled.json()).queryClass).toBeNull()
    for (const queryClass of ['branded', 'non-brand', 'brand']) {
      const refused = await request('GET', `/api/v1/projects/northstar/measurement-report?revision=1&queryClass=${queryClass}`, READ_KEY)
      expect(refused.statusCode, queryClass).toBe(400)
      expect(refused.json(), queryClass).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    }
  })

  it('bridges a real pre-plan run through the HTTP report adapter', async () => {
    const active = await publishPlan()
    const project = db.select().from(projects).where(eq(projects.name, 'northstar')).get()!
    const runId = 'run-legacy'
    db.insert(runs).values({
      id: runId, projectId: project.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      measurementPlanVersionId: null, measurementManifest: null, createdAt: LEGACY_CREATED_AT,
    }).run()
    db.insert(querySnapshots).values(['gemini', 'openai'].map(provider => ({
      id: `snapshot-legacy-${provider}`,
      runId,
      queryId,
      queryText: 'homes near harbor',
      provider,
      citationState: 'cited',
      answerMentioned: true,
      answerText: 'Northstar recommends Harbor Homes.',
      citedDomains: ['northstar.example'],
      citedUrls: null,
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: 'Harbor',
      measurementExecutionId: null,
      rawResponse: JSON.stringify({ groundingSources: [{ uri: 'https://northstar.example/locations/harbor' }] }),
      createdAt: LEGACY_CREATED_AT,
    }))).run()

    const response = await request('GET', '/api/v1/projects/northstar/measurement-report?revision=1', READ_KEY)
    expect(response.statusCode).toBe(200)
    const body = measurementReportResponseSchema.parse(response.json())
    expect(body.run?.id).toBe(runId)
    expect(body.revision).toBe(active.revision)
    expect(body.diagnostics.bridgedObservationIds).toEqual(['snapshot-legacy-gemini', 'snapshot-legacy-openai'])
    expect(body.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationId: 'snapshot-legacy-gemini', bridged: true, historical: true, classification: 'assigned' }),
      expect.objectContaining({ observationId: 'snapshot-legacy-openai', bridged: true, historical: true, classification: 'assigned' }),
    ]))
  })

  it('withholds all rate fields when one expected provider slot is absent', async () => {
    const active = await publishPlan()
    const version = db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.revision, 1)).get()!
    const project = db.select().from(projects).where(eq(projects.name, 'northstar')).get()!
    const execution = active.plan.executionNodes[0]!
    db.insert(runs).values({
      id: 'run-incomplete', projectId: project.id, kind: 'answer-visibility', status: 'partial', trigger: 'manual',
      measurementPlanVersionId: version.id, measurementManifest: buildMeasurementRunManifest(active.plan, ['gemini', 'openai']),
      createdAt: CREATED_AT,
    }).run()
    db.insert(querySnapshots).values({
      id: 'snapshot-openai', runId: 'run-incomplete', queryId, queryText: 'homes near harbor', provider: 'openai',
      citationState: 'not-cited', answerMentioned: false, answerText: 'No result.', citedDomains: [], citedUrls: [], captureStatus: 'complete',
      competitorOverlap: [], recommendedCompetitors: [], location: 'Harbor', measurementExecutionId: execution.stableKey,
      requestedContext: execution.context, supportedContext: { status: 'applied', resolved: execution.context }, createdAt: CREATED_AT,
    }).run()

    const response = await request('GET', '/api/v1/projects/northstar/measurement-report?revision=1', READ_KEY)
    expect(response.statusCode).toBe(200)
    const body = measurementReportResponseSchema.parse(response.json())
    expect(body.run?.status).toBe('partial')
    expect(body.targets[0]?.citationCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
    expect(body.groups[0]?.answerCoverage).toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })
})
