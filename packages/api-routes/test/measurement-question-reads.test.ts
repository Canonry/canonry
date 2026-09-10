import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { targetMentionedInAnswer } from '../src/measurement-report.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-08-01T12:00:00.000Z'

interface QuestionRow {
  resultId: string | null
  queryId: string
  text: string
  class: 'branded' | 'non-brand'
  provider: string
  requestedModel: string | null
  servedModel: string | null
  location: string | null
  status: 'answered' | 'missing'
  mentioned: boolean | null
  cited: boolean | null
  recommendedInstead: string[]
  answerExcerpt: string | null
}

interface PropertyQuestionsResponse {
  property: { targetKey: string; label: string }
  measurement: { state: string; displayedRunId: string | null; planRevision: number; completedAt: string | null }
  queryClass: 'all' | 'branded' | 'non-brand'
  questions: QuestionRow[]
  total: number
  truncated: boolean
}

interface QuestionResultResponse {
  property: { targetKey: string; label: string }
  measurement: { state: string; displayedRunId: string | null; planRevision: number; completedAt: string | null }
  question: Omit<QuestionRow, 'mentioned' | 'cited' | 'recommendedInstead' | 'answerExcerpt'>
  mentioned: boolean | null
  cited: boolean | null
  recommendedInstead: string[]
  answer: string | null
  sources: Array<{
    url: string
    classification: string
    matchedTargetKeys: string[]
    assigned: boolean
    historical: boolean
    evidenceComplete: boolean
  }>
  captureStatus: string | null
  retrievalStatus: string | null
  retrievalContract: string | null
}

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2

function seedVersion(revision: number, owner = projectId): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId: owner,
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  return id
}

function activate(versionId: string): void {
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: NOW,
    updatedAt: NOW,
  }).onConflictDoUpdate({
    target: measurementPlans.projectId,
    set: { activeVersionId: versionId, updatedAt: NOW },
  }).run()
}

function runManifest(executionKeys?: readonly string[]) {
  const manifest = buildMeasurementPlanV2Manifest(plan)
  const allowed = executionKeys === undefined ? null : new Set(executionKeys)
  return {
    ...manifest,
    expectedSlots: manifest.expectedSlots
      .filter(slot => allowed === null || allowed.has(slot.executionId))
      .map(slot => {
        const node = plan.executionNodes.find(candidate => candidate.stableKey === slot.executionId)!
        return { ...slot, requestedModel: node.context.models[slot.provider] }
      }),
  }
}

function seedRun(
  versionId: string,
  values: Partial<typeof runs.$inferInsert> = {},
): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: runManifest(),
    finishedAt: NOW,
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

function seedSnapshot(
  runId: string,
  executionKey: string,
  provider: string,
  values: Partial<typeof querySnapshots.$inferInsert> = {},
): string {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === executionKey)!
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId: null,
    queryText: node.queryText,
    provider,
    model: node.context.models[provider] ?? null,
    servedModel: `${provider}-served`,
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'Harbor Homes is a strong option. Challenger is also recommended.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: ['Challenger'],
    measurementExecutionId: executionKey,
    requestedContext: node.context.location,
    supportedContext: { status: 'applied', resolved: node.context.location },
    location: node.context.location?.label ?? null,
    citedUrls: ['https://northstar.example/locations/harbor/details'],
    captureStatus: 'complete',
    createdAt: NOW,
    ...values,
  }).run()
  return id
}

async function questions(query: string): Promise<{ status: number; body: PropertyQuestionsResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-property-questions?${query}`,
  })
  return { status: response.statusCode, body: response.json() as PropertyQuestionsResponse }
}

async function questionResult(query: string): Promise<{ status: number; body: QuestionResultResponse }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-question-result?${query}`,
  })
  return { status: response.statusCode, body: response.json() as QuestionResultResponse }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-question-reads-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'current.example',
    ownedDomains: ['current-owned.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  plan = measurementPlanV2Fixture()
  for (const node of plan.executionNodes) {
    node.context.models = { openai: 'gpt-planned', gemini: 'gemini-planned' }
  }

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement question reads', () => {
  it('enumerates the active Property assignments from the latest completed full run, including missing slots', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const oldFull = seedRun(versionId, { createdAt: '2026-08-01T10:00:00.000Z' })
    seedSnapshot(oldFull, 'exec-nearby', 'openai')

    const latestFull = seedRun(versionId, { createdAt: '2026-08-01T11:00:00.000Z' })
    const resultId = seedSnapshot(latestFull, 'exec-nearby', 'openai', {
      answerText: '  Harbor Homes\n\n is\t a strong option.  ',
      // A provider can repeat the Property under punctuation/case variants;
      // that is not a recommendation *instead* of this Property.
      recommendedCompetitors: ['Harbor Homes', 'HARBOR-HOMES', 'Challenger'],
    })

    const { status, body } = await questions('targetKey=harbor')

    expect(status).toBe(200)
    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: latestFull, planRevision: 1 })
    expect(body.property).toEqual({ targetKey: 'harbor', label: 'Harbor Homes' })
    // Harbor owns two execution nodes x two providers. These are frozen plan
    // assignments, not the mutable project query table.
    expect(body.questions).toHaveLength(4)
    expect(body.total).toBe(4)
    expect(body.truncated).toBe(false)

    const answered = body.questions.find(row => row.resultId === resultId)!
    expect(answered).toMatchObject({
      queryId: 'q-nearby',
      text: 'homes near harbor',
      class: 'non-brand',
      provider: 'openai',
      requestedModel: 'gpt-planned',
      servedModel: 'openai-served',
      location: 'Harbor',
      status: 'answered',
      mentioned: true,
      cited: true,
      recommendedInstead: ['Challenger'],
      answerExcerpt: 'Harbor Homes is a strong option.',
    })

    const missing = body.questions.find(row => row.provider === 'gemini' && row.queryId === 'q-nearby')!
    expect(missing).toMatchObject({
      resultId: null,
      status: 'missing',
      mentioned: null,
      cited: null,
      recommendedInstead: [],
      answerExcerpt: null,
    })
  })

  it('uses the same recommendation identity as portfolio reads and drops empty candidate keys', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai', {
      recommendedCompetitors: ['Harbor Homes', 'HARBOR-HOMES', 'HarborHomes', '   ', '---', 'Challenger'],
    })

    const { status, body } = await questions(`targetKey=harbor&runId=${runId}&provider=openai`)
    const detail = await questionResult(`targetKey=harbor&resultId=${resultId}`)

    expect(status).toBe(200)
    expect(body.questions.find(question => question.resultId === resultId)?.recommendedInstead).toEqual(['Challenger'])
    expect(detail.status).toBe(200)
    expect(detail.body.recommendedInstead).toEqual(['Challenger'])
  })

  it('deduplicates the provider request but evaluates mention and citation for each Property separately', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    seedSnapshot(runId, 'exec-nearby', 'openai')

    const harbor = await questions(`targetKey=harbor&runId=${runId}&queryClass=non-brand&provider=openai`)
    const bayside = await questions(`targetKey=bayside&runId=${runId}&queryClass=non-brand&provider=openai`)

    expect(harbor.status).toBe(200)
    expect(harbor.body.questions).toHaveLength(1)
    expect(harbor.body.questions[0]).toMatchObject({ mentioned: true, cited: true })
    // The same stored answer was executed once, but Harbor's URL and name do
    // not credit Bayside merely because it shares the execution node.
    expect(bayside.status).toBe(200)
    expect(bayside.body.questions).toHaveLength(1)
    expect(bayside.body.questions[0]).toMatchObject({ mentioned: false, cited: false })
  })

  it('keeps mention unavailable when the published Property has no mention aliases', async () => {
    const bayside = plan.targets.find(target => target.stableKey === 'bayside')!
    bayside.aliases = []
    bayside.mentionNotApplicable = true
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai', {
      answerText: 'Bayside Homes appears in this answer.',
    })

    const listed = await questions(`targetKey=bayside&runId=${runId}&provider=openai`)
    expect(listed.status).toBe(200)
    expect(listed.body.questions[0]).toMatchObject({ resultId, status: 'answered', mentioned: null })

    const detail = await questionResult(`targetKey=bayside&resultId=${resultId}`)
    expect(detail.status).toBe(200)
    expect(detail.body.mentioned).toBeNull()
  })

  it('pages beyond the compact default without making later results unreachable', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    seedSnapshot(runId, 'exec-nearby', 'openai')

    const first = await questions(`targetKey=harbor&runId=${runId}&offset=0&limit=1`)
    const second = await questions(`targetKey=harbor&runId=${runId}&offset=1&limit=1`)
    const final = await questions(`targetKey=harbor&runId=${runId}&offset=3&limit=1`)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.total).toBe(4)
    expect(second.body.total).toBe(4)
    expect(first.body.questions).toHaveLength(1)
    expect(second.body.questions).toHaveLength(1)
    expect(first.body.questions[0]).not.toEqual(second.body.questions[0])
    expect(first.body.truncated).toBe(true)
    expect(second.body.truncated).toBe(true)
    expect(final.body.truncated).toBe(false)
  })

  it.each([true, null])('preserves partial source evidence as %s after filtering frozen slots', async expectedCitation => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    seedSnapshot(runId, 'exec-brand', 'openai', {
      captureStatus: 'partial',
      citedUrls: expectedCitation ? ['https://northstar.example/locations/harbor/details'] : [],
    })

    const { status, body } = await questions('targetKey=harbor&queryClass=branded&provider=openai&location=Harbor&limit=1')

    expect(status).toBe(200)
    expect(body.questions).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.questions[0]).toMatchObject({
      queryId: 'q-brand',
      class: 'branded',
      resultId: expect.any(String),
      mentioned: true,
      cited: expectedCitation,
    })
  })

  it('keeps malformed large provider payloads out of normal list and detail materialization', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai', {
      rawResponse: 'not-json:' + 'x'.repeat(256_000),
    })
    const prepare = vi.spyOn(db.$client, 'prepare')

    const listed = await questions('targetKey=harbor&runId=' + runId + '&queryClass=non-brand&provider=openai')
    const detail = await questionResult('targetKey=harbor&resultId=' + resultId)

    expect(listed.status).toBe(200)
    expect(listed.body.questions[0]).toMatchObject({ resultId, cited: true })
    expect(detail.status).toBe(200)
    expect(detail.body.question.resultId).toBe(resultId)
    expect(JSON.stringify(detail.body)).not.toContain('not-json:')
    const snapshotSql = prepare.mock.calls
      .map(([statement]) => String(statement))
      .filter(statement => statement.includes('query_snapshots'))
    expect(snapshotSql).not.toHaveLength(0)
    expect(snapshotSql.join('\n')).not.toContain('raw_response')
  })

  it('recovers legacy raw citations only for the selected legacy slot', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai', {
      citedUrls: null,
      captureStatus: null,
      rawResponse: JSON.stringify({
        groundingSources: [{ uri: 'https://northstar.example/locations/harbor/details' }],
      }),
    })
    const prepare = vi.spyOn(db.$client, 'prepare')

    const listed = await questions('targetKey=harbor&runId=' + runId + '&queryClass=non-brand&provider=openai')

    expect(listed.status).toBe(200)
    expect(listed.body.questions[0]).toMatchObject({ resultId, cited: true })
    const rawStatements = prepare.mock.calls
      .map(([statement]) => String(statement))
      .filter(statement => statement.includes('raw_response'))
    expect(rawStatements).toHaveLength(1)
    expect(rawStatements[0]).toContain('query_snapshots')
    expect(rawStatements[0]).toContain('"id"')
    prepare.mockRestore()

    const detail = await questionResult('targetKey=harbor&resultId=' + resultId)
    expect(detail.status).toBe(200)
    expect(detail.body.sources).toEqual([expect.objectContaining({
      assigned: true,
      historical: true,
      url: 'https://northstar.example/locations/harbor/details',
    })])
  })

  it('materializes only the requested Property and result execution while retaining shared attribution', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai')
    // This is a stored result for a different Property execution. If the read
    // expands to every run snapshot, frozen provenance validation correctly
    // rejects it; the Bayside read must never materialize it in the first place.
    seedSnapshot(runId, 'exec-brand', 'openai', { queryText: 'corrupt unrelated result' })

    const listed = await questions('targetKey=bayside&runId=' + runId + '&provider=openai')
    const detail = await questionResult('targetKey=bayside&resultId=' + resultId)

    expect(listed.status).toBe(200)
    expect(listed.body.questions).toHaveLength(1)
    expect(listed.body.questions[0]).toMatchObject({ resultId, cited: false, mentioned: false })
    expect(detail.status).toBe(200)
    expect(detail.body.sources).toEqual([expect.objectContaining({
      assigned: false,
      classification: 'sibling',
      matchedTargetKeys: ['harbor'],
    })])
  })

  it('allows an explicitly selected active-revision terminal spot check but rejects a foreign revision or project', async () => {
    const activeVersion = seedVersion(2)
    activate(activeVersion)
    const spot = seedRun(activeVersion, {
      status: 'partial',
      trigger: 'probe',
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
      measurementManifest: runManifest(['exec-nearby']),
    })
    const spotResult = seedSnapshot(spot, 'exec-nearby', 'openai')

    const selected = await questions(`targetKey=harbor&runId=${spot}`)
    expect(selected.status).toBe(200)
    expect(selected.body.measurement).toMatchObject({ state: 'partial', displayedRunId: spot, planRevision: 2 })
    expect(selected.body.questions).toHaveLength(2)

    const outOfScope = await questions(`targetKey=bayside&runId=${spot}`)
    expect(outOfScope.status).toBe(400)
    const outOfScopeDetail = await questionResult(`targetKey=bayside&resultId=${spotResult}`)
    expect(outOfScopeDetail.status).toBe(400)

    const queryOnlySpot = seedRun(activeVersion, {
      status: 'partial',
      trigger: 'probe',
      measurementScope: { groups: [], targets: [], queries: ['q-nearby'], resolvedTargets: [] },
      measurementManifest: runManifest(['exec-nearby']),
    })
    seedSnapshot(queryOnlySpot, 'exec-nearby', 'openai')
    const queryScopedSibling = await questions(`targetKey=bayside&runId=${queryOnlySpot}`)
    expect(queryScopedSibling.status).toBe(200)

    const oldVersion = seedVersion(1)
    const oldRun = seedRun(oldVersion)
    const mismatched = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-questions?targetKey=harbor&runId=${oldRun}`,
    })
    expect(mismatched.statusCode).toBe(422)

    const foreignProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: foreignProjectId,
      name: 'elsewhere',
      displayName: 'Elsewhere',
      canonicalDomain: 'elsewhere.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      locations: [],
      providers: [],
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    const foreignVersion = seedVersion(1, foreignProjectId)
    const foreignRun = crypto.randomUUID()
    db.insert(runs).values({
      id: foreignRun,
      projectId: foreignProjectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      measurementPlanVersionId: foreignVersion,
      measurementManifest: runManifest(),
      finishedAt: NOW,
      createdAt: NOW,
    }).run()
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-questions?targetKey=harbor&runId=${foreignRun}`,
    })
    expect(foreign.statusCode).toBe(404)

    const ordinaryProbe = seedRun(activeVersion, { trigger: 'probe' })
    const rejectedProbe = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/northstar/measurement-property-questions?targetKey=harbor&runId=${ordinaryProbe}`,
    })
    expect(rejectedProbe.statusCode).toBe(400)
  })

  it('returns one full stored result with target-specific source attribution and never exposes the raw provider blob', async () => {
    const versionId = seedVersion(1)
    activate(versionId)
    const runId = seedRun(versionId)
    const resultId = seedSnapshot(runId, 'exec-nearby', 'openai', {
      rawResponse: JSON.stringify({ apiResponse: { secret: 'do-not-return' } }),
      answerText: 'The full answer names Harbor Homes and recommends Challenger.',
    })

    const { status, body } = await questionResult(`targetKey=bayside&resultId=${resultId}`)

    expect(status).toBe(200)
    expect(body.measurement).toMatchObject({ state: 'complete', displayedRunId: runId, planRevision: 1 })
    expect(body.question).toMatchObject({
      resultId,
      queryId: 'q-nearby',
      class: 'non-brand',
      provider: 'openai',
      requestedModel: 'gpt-planned',
      servedModel: 'openai-served',
    })
    expect(body).toMatchObject({ mentioned: false, cited: false, recommendedInstead: ['Challenger'] })
    expect(body.answer).toBe('The full answer names Harbor Homes and recommends Challenger.')
    expect(body.sources).toEqual([expect.objectContaining({
      url: 'https://northstar.example/locations/harbor/details',
      classification: 'sibling',
      matchedTargetKeys: ['harbor'],
      assigned: false,
    })])
    expect(JSON.stringify(body)).not.toContain('do-not-return')
  })
})

describe('targetMentionedInAnswer', () => {
  it('returns a target-specific tri-state without treating an ambiguous shared alias as a mention', () => {
    const targets = [
      { id: 'harbor', label: 'Harbor', aliases: ['Harbor Homes', 'Harbor'], urls: [] },
      { id: 'bayside', label: 'Bayside', aliases: ['Bayside Homes', 'Harbor'], urls: [] },
    ]

    expect(targetMentionedInAnswer(null, 'harbor', targets)).toBeNull()
    expect(targetMentionedInAnswer('Harbor Homes is open.', 'harbor', targets)).toBe(true)
    expect(targetMentionedInAnswer('Harbor Homes is open.', 'bayside', targets)).toBe(false)
    expect(targetMentionedInAnswer('Harbor is open.', 'harbor', targets)).toBeNull()
    expect(targetMentionedInAnswer('Harbor is open.', 'bayside', targets)).toBeNull()
  })
})
