import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  projectOverviewDtoSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type MeasurementPlanV2,
  type MentionIdentity,
  type ProjectOverviewWhatChangedDto,
} from '@canonry/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

/**
 * Overview's "What changed" (`whatChanged` on GET /projects/:name/overview):
 * each signal counts a query once however many answers lost it, mentions and
 * citations are counted apart, and the rows say exactly what the dashboard
 * and `canonry overview` list. Simple and Advanced each have their own rule
 * for what an answer is compared with.
 */

const FIRST = '2026-09-01T00:00:00.000Z'
const SECOND = '2026-09-08T00:00:00.000Z'
const THIRD = '2026-09-15T00:00:00.000Z'

let directory: string
let db: DatabaseClient
let app: FastifyInstance

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-what-changed-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function readWhatChanged(project: string, query = ''): Promise<ProjectOverviewWhatChangedDto> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/overview${query}` })
  expect(response.statusCode, response.body).toBe(200)
  const whatChanged = projectOverviewDtoSchema.parse(response.json()).whatChanged
  if (whatChanged === undefined) throw new Error('The overview carries no whatChanged')
  return whatChanged
}

const NOTHING_LOST = { queryCount: 0, queries: [], truncated: false }
const NO_ACTIVE_RUNS = { count: 0, runIds: [] }

/** The rows a project lists, as the server builds them. */
function lostMentionsRow(projectId: string, projectName: string, label: string, detail: string) {
  return { id: `attention_${projectId}_lost_mentions`, tone: 'negative', title: `${label} lost mentions`, detail, actionLabel: 'Open project', href: `/projects/${projectName}` }
}
function lostCitationsRow(projectId: string, projectName: string, label: string, detail: string) {
  return { id: `attention_${projectId}_lost`, tone: 'negative', title: `${label} lost citations`, detail, actionLabel: 'Open project', href: `/projects/${projectName}` }
}
function activeRunsRow(projectId: string, label: string, detail: string) {
  return { id: `attention_${projectId}_active`, tone: 'neutral', title: `${label} has active runs`, detail, actionLabel: 'View runs', href: '/runs' }
}

function simpleLost(query: string, queryId: string, queryClass: 'branded' | 'non-brand', providers: string[], locations: Array<string | null> = [null]) {
  return { queryId, query, queryClass, providers, locations, properties: [], markets: [] }
}

describe('What changed: Simple projects', () => {
  const PROJECT_ID = 'proj_acme'

  function seedProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'acme',
      displayName: 'Acme Coatings',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      createdAt: FIRST,
      updatedAt: FIRST,
      ...overrides,
    }).run()
  }

  function addQuery(id: string, query: string) {
    db.insert(queries).values({ id, projectId: PROJECT_ID, query, createdAt: FIRST }).run()
  }

  function addRun(id: string, createdAt: string, overrides: Partial<typeof runs.$inferInsert> = {}) {
    db.insert(runs).values({
      id,
      projectId: PROJECT_ID,
      kind: RunKinds['answer-visibility'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      createdAt,
      finishedAt: createdAt,
      ...overrides,
    }).run()
  }

  /** One engine's answer. A mention is read from the answer text, as the evidence rows read it. */
  function addAnswer(runId: string, queryId: string, answer: {
    mentioned: boolean
    cited: boolean
    provider?: string
    location?: string | null
    answerText?: string
    storedMentioned?: boolean
    mentionIdentity?: MentionIdentity | null
  }) {
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId,
      provider: answer.provider ?? 'openai',
      citationState: answer.cited ? 'cited' : 'not-cited',
      answerMentioned: answer.storedMentioned ?? answer.mentioned,
      mentionIdentity: answer.mentionIdentity ?? null,
      answerText: answer.answerText ?? (answer.mentioned ? 'Acme Coatings is the one to call.' : 'Other contractors lead here.'),
      citedDomains: answer.cited ? ['acme.example'] : [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: answer.location ?? null,
      createdAt: new Date(Date.parse(runCreatedAt(runId)) + 10_000).toISOString(),
    }).run()
  }

  function runCreatedAt(runId: string): string {
    const row = db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, runId)).get()
    if (!row) throw new Error(`No run ${runId}`)
    return row.createdAt
  }

  it('counts lost mentions and lost citations apart, each query once, from each engine\'s previous check', async () => {
    seedProject()
    addQuery('q_brand', 'acme coatings reviews')
    addQuery('q_best', 'best polyurea roof coating')
    addQuery('q_kept', 'roof coating contractors')
    addQuery('q_versus', 'polyurea vs silicone roof coating')
    addRun('run_1', FIRST)
    addRun('run_2', SECOND)
    addRun('run_3', THIRD, { status: RunStatuses.cancelled })
    // Lost its mention on both engines; never cited.
    addAnswer('run_1', 'q_best', { mentioned: true, cited: false })
    addAnswer('run_1', 'q_best', { mentioned: true, cited: false, provider: 'gemini' })
    addAnswer('run_2', 'q_best', { mentioned: false, cited: false })
    addAnswer('run_2', 'q_best', { mentioned: false, cited: false, provider: 'gemini' })
    // Lost its citation on one engine; never mentioned.
    addAnswer('run_1', 'q_versus', { mentioned: false, cited: true })
    addAnswer('run_2', 'q_versus', { mentioned: false, cited: false })
    // A branded query that lost its citation while keeping its mention.
    addAnswer('run_1', 'q_brand', { mentioned: true, cited: true })
    addAnswer('run_2', 'q_brand', { mentioned: true, cited: false })
    // Kept both in the latest completed check; only the cancelled run after it lost them.
    addAnswer('run_1', 'q_kept', { mentioned: true, cited: true })
    addAnswer('run_2', 'q_kept', { mentioned: true, cited: true })
    addAnswer('run_3', 'q_kept', { mentioned: false, cited: false })

    expect(await readWhatChanged('acme')).toEqual({
      mode: 'simple',
      latestCheck: { runIds: ['run_2'], createdAt: SECOND },
      comparison: { state: 'available', previousRunIds: ['run_1'] },
      lostMentions: { queryCount: 1, queries: [simpleLost('best polyurea roof coating', 'q_best', 'non-brand', ['gemini', 'openai'])], truncated: false },
      lostCitations: {
        queryCount: 2,
        queries: [
          simpleLost('acme coatings reviews', 'q_brand', 'branded', ['openai']),
          simpleLost('polyurea vs silicone roof coating', 'q_versus', 'non-brand', ['openai']),
        ],
        truncated: false,
      },
      activeRuns: NO_ACTIVE_RUNS,
      items: [
        lostMentionsRow(PROJECT_ID, 'acme', 'Acme Coatings', '1 query lost a mention in the latest check.'),
        lostCitationsRow(PROJECT_ID, 'acme', 'Acme Coatings', '2 queries lost a citation in the latest check.'),
      ],
    })
  })

  it('compares each answer with its engine\'s own last answer, whatever that run\'s status, and never a probe', async () => {
    seedProject()
    addQuery('q_skipped', 'best polyurea roof coating')
    addQuery('q_failed', 'polyurea vs silicone roof coating')
    addQuery('q_probe', 'roof coating contractors')
    addRun('run_1', FIRST)
    addRun('run_2', SECOND, { status: RunStatuses.failed })
    addRun('run_probe', '2026-09-10T00:00:00.000Z', { trigger: RunTriggers.probe })
    addRun('run_3', THIRD)
    // Gemini skipped the failed run, so its previous check is the first run's answer.
    addAnswer('run_1', 'q_skipped', { mentioned: true, cited: false })
    addAnswer('run_1', 'q_skipped', { mentioned: true, cited: false, provider: 'gemini' })
    addAnswer('run_2', 'q_skipped', { mentioned: true, cited: false })
    addAnswer('run_3', 'q_skipped', { mentioned: true, cited: false })
    addAnswer('run_3', 'q_skipped', { mentioned: false, cited: false, provider: 'gemini' })
    // Already uncited in the failed run: nothing lost since then.
    addAnswer('run_1', 'q_failed', { mentioned: false, cited: true })
    addAnswer('run_2', 'q_failed', { mentioned: false, cited: false })
    addAnswer('run_3', 'q_failed', { mentioned: false, cited: false })
    // Only a probe mentioned it, and a probe is never a previous check.
    addAnswer('run_2', 'q_probe', { mentioned: false, cited: false })
    addAnswer('run_probe', 'q_probe', { mentioned: true, cited: true })
    addAnswer('run_3', 'q_probe', { mentioned: false, cited: false })

    const whatChanged = await readWhatChanged('acme')
    expect(whatChanged.latestCheck).toEqual({ runIds: ['run_3'], createdAt: THIRD })
    expect(whatChanged.comparison).toEqual({ state: 'available', previousRunIds: ['run_2', 'run_1'] })
    expect(whatChanged.lostMentions).toEqual({ queryCount: 1, queries: [simpleLost('best polyurea roof coating', 'q_skipped', 'non-brand', ['gemini'])], truncated: false })
    expect(whatChanged.lostCitations).toEqual(NOTHING_LOST)
    expect(whatChanged.items).toEqual([lostMentionsRow(PROJECT_ID, 'acme', 'Acme Coatings', '1 query lost a mention in the latest check.')])
  })

  it('compares each location of a fan-out sweep with that location\'s previous check', async () => {
    seedProject({
      locations: [
        { label: 'florida', city: 'Orlando', region: 'Florida', country: 'US' },
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
      ],
    })
    addQuery('q_best', 'best polyurea roof coating')
    addRun('run_fl_1', FIRST, { location: 'florida' })
    addRun('run_mi_1', FIRST, { location: 'michigan' })
    addRun('run_fl_2', SECOND, { location: 'florida' })
    addRun('run_mi_2', SECOND, { location: 'michigan' })
    // Florida lost the mention and Michigan gained it: across locations the
    // two would look unchanged, and each against the other would flip.
    addAnswer('run_fl_1', 'q_best', { mentioned: true, cited: false, location: 'florida' })
    addAnswer('run_mi_1', 'q_best', { mentioned: false, cited: false, location: 'michigan' })
    addAnswer('run_fl_2', 'q_best', { mentioned: false, cited: false, location: 'florida' })
    addAnswer('run_mi_2', 'q_best', { mentioned: true, cited: false, location: 'michigan' })

    const whatChanged = await readWhatChanged('acme')
    expect([...whatChanged.latestCheck?.runIds ?? []].sort()).toEqual(['run_fl_2', 'run_mi_2'])
    expect(whatChanged.comparison.state).toBe('available')
    expect(whatChanged.comparison.state === 'available' ? [...whatChanged.comparison.previousRunIds].sort() : []).toEqual(['run_fl_1', 'run_mi_1'])
    expect(whatChanged.lostMentions).toEqual({ queryCount: 1, queries: [simpleLost('best polyurea roof coating', 'q_best', 'non-brand', ['openai'], ['florida'])], truncated: false })
    expect(whatChanged.lostCitations).toEqual(NOTHING_LOST)

    // The overview's location filter keeps only that location's answers.
    const michigan = await readWhatChanged('acme', '?location=michigan')
    expect(michigan.latestCheck).toEqual({ runIds: ['run_mi_2'], createdAt: SECOND })
    expect(michigan.lostMentions).toEqual(NOTHING_LOST)
    expect(michigan.items).toEqual([])
  })

  it('reads a mention as the evidence rows do: the answer text with the project\'s current names, and a wrong-subject verdict', async () => {
    seedProject({ aliases: ['AcmeCo'] })
    addQuery('q_alias', 'roof coating near me')
    addQuery('q_other_acme', 'acme coatings phone')
    addRun('run_1', FIRST)
    addRun('run_2', SECOND)
    // Stored before the alias was added: the column says unmentioned, the text names it.
    addAnswer('run_1', 'q_alias', { mentioned: true, cited: false, answerText: 'AcmeCo is the one to call.', storedMentioned: false })
    addAnswer('run_2', 'q_alias', { mentioned: false, cited: false })
    // The name matched, but the answer is about another Acme: never a mention to lose.
    addAnswer('run_1', 'q_other_acme', { mentioned: false, cited: false, answerText: 'Acme Coatings in Ohio closed in 2019.', storedMentioned: false, mentionIdentity: 'wrong-subject' })
    addAnswer('run_2', 'q_other_acme', { mentioned: false, cited: false })

    const whatChanged = await readWhatChanged('acme')
    expect(whatChanged.lostMentions).toEqual({ queryCount: 1, queries: [simpleLost('roof coating near me', 'q_alias', 'non-brand', ['openai'])], truncated: false })
  })

  it('reports nothing lost before a second check, or when the latest check lost nothing', async () => {
    seedProject()
    addQuery('q_best', 'best polyurea roof coating')
    const empty = { lostMentions: NOTHING_LOST, lostCitations: NOTHING_LOST, activeRuns: NO_ACTIVE_RUNS, items: [] }

    expect(await readWhatChanged('acme')).toEqual({
      mode: 'simple', latestCheck: null, comparison: { state: 'unavailable', reason: 'not-measured' }, ...empty,
    })

    addRun('run_1', FIRST)
    addAnswer('run_1', 'q_best', { mentioned: false, cited: false })
    expect(await readWhatChanged('acme')).toEqual({
      mode: 'simple', latestCheck: { runIds: ['run_1'], createdAt: FIRST }, comparison: { state: 'unavailable', reason: 'no-previous-check' }, ...empty,
    })

    // Gains are not losses.
    addRun('run_2', SECOND)
    addAnswer('run_2', 'q_best', { mentioned: true, cited: true })
    expect(await readWhatChanged('acme')).toEqual({
      mode: 'simple', latestCheck: { runIds: ['run_2'], createdAt: SECOND }, comparison: { state: 'available', previousRunIds: ['run_1'] }, ...empty,
    })

    // An earlier check outside the overview's window is not compared.
    expect((await readWhatChanged('acme', `?since=${encodeURIComponent('2026-09-05T00:00:00.000Z')}`)).comparison)
      .toEqual({ state: 'unavailable', reason: 'no-previous-check' })
  })

  it('counts queued and running AI Visibility runs as in progress, never a probe or another kind', async () => {
    seedProject()
    addRun('run_done', FIRST)
    addRun('run_queued', SECOND, { status: RunStatuses.queued, finishedAt: null })
    addRun('run_running', THIRD, { status: RunStatuses.running, finishedAt: null })
    addRun('run_probe', '2026-09-16T00:00:00.000Z', { status: RunStatuses.running, trigger: RunTriggers.probe, finishedAt: null })
    addRun('run_sync', '2026-09-17T00:00:00.000Z', { kind: RunKinds['gsc-sync'], status: RunStatuses.running, finishedAt: null })

    const whatChanged = await readWhatChanged('acme')
    expect(whatChanged.activeRuns).toEqual({ count: 2, runIds: ['run_running', 'run_queued'] })
    expect(whatChanged.items).toEqual([activeRunsRow(PROJECT_ID, 'Acme Coatings', '2 runs in progress.')])

    db.update(runs).set({ status: RunStatuses.completed, finishedAt: THIRD }).where(eq(runs.id, 'run_running')).run()
    const one = await readWhatChanged('acme')
    expect(one.activeRuns).toEqual({ count: 1, runIds: ['run_queued'] })
    expect(one.items).toEqual([activeRunsRow(PROJECT_ID, 'Acme Coatings', '1 run in progress.')])
  })

  it('names at most 25 queries in query text order while counting all of them', async () => {
    seedProject()
    addRun('run_1', FIRST)
    addRun('run_2', SECOND)
    const texts = Array.from({ length: 26 }, (_, index) => `roof coating question ${String(index + 1).padStart(2, '0')}`)
    // Seeded in reverse so the order comes from the response, not the inserts.
    for (const [index, text] of [...texts.entries()].reverse()) {
      addQuery(`q_${index}`, text)
      addAnswer('run_1', `q_${index}`, { mentioned: false, cited: true })
      addAnswer('run_2', `q_${index}`, { mentioned: false, cited: false })
    }

    const whatChanged = await readWhatChanged('acme')
    expect(whatChanged.lostCitations.queryCount).toBe(26)
    expect(whatChanged.lostCitations.truncated).toBe(true)
    expect(whatChanged.lostCitations.queries.map(row => row.query)).toEqual(texts.slice(0, 25))
    expect(whatChanged.lostMentions).toEqual(NOTHING_LOST)
    expect(whatChanged.items).toEqual([lostCitationsRow(PROJECT_ID, 'acme', 'Acme Coatings', '26 queries lost a citation in the latest check.')])
  })
})

describe('What changed: Advanced projects', () => {
  const PROJECT_ID = 'proj_northstar'
  const HARBOR_URL = 'https://northstar.example/locations/harbor/details'

  beforeEach(() => {
    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'northstar',
      displayName: 'Northstar',
      canonicalDomain: 'northstar.example',
      country: 'US',
      language: 'en',
      createdAt: FIRST,
      updatedAt: FIRST,
    }).run()
  })

  function publish(frozenPlan: MeasurementPlanV2): string {
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId: PROJECT_ID,
      revision: 1,
      canonicalJson: canonicalMeasurementPlanV2Json(frozenPlan),
      checksum: 'c'.repeat(64),
      schemaVersion: 2,
      compiledChecksum: frozenPlan.compiledChecksum,
      createdAt: FIRST,
    }).run()
    db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: versionId, createdAt: FIRST, updatedAt: FIRST }).run()
    return versionId
  }

  type NearbyAnswers = Record<'openai' | 'gemini', { answerText: string; cited: boolean }>

  /** One whole-plan sweep. The branded `exec-brand` query names only the project brand, never a Property. */
  function sweep(id: string, input: { versionId: string; frozenPlan: MeasurementPlanV2; createdAt: string; nearby: NearbyAnswers; models?: string }) {
    const manifest = buildMeasurementPlanV2Manifest(input.frozenPlan)
    db.insert(runs).values({
      id,
      projectId: PROJECT_ID,
      kind: RunKinds['answer-visibility'],
      status: RunStatuses.completed,
      trigger: RunTriggers.manual,
      measurementPlanVersionId: input.versionId,
      measurementManifest: { schemaVersion: 1, expectedSlots: manifest.expectedSlots },
      measurementExecutionIdentity: {
        schemaVersion: 1,
        providers: ['gemini', 'openai'],
        models: { gemini: 'pin-gemini', openai: 'pin-openai' },
        checksum: input.models ?? 'stable-model-series',
      },
      createdAt: input.createdAt,
      finishedAt: input.createdAt,
    }).run()
    for (const slot of manifest.expectedSlots) {
      const answer = slot.executionId === 'exec-nearby'
        ? input.nearby[slot.provider as keyof NearbyAnswers]
        : { answerText: 'Northstar is reliable.', cited: false }
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(),
        runId: id,
        queryId: null,
        queryText: slot.queryText,
        provider: slot.provider,
        servedModel: `${slot.provider}-served`,
        citationState: answer.cited ? 'cited' : 'not-cited',
        answerMentioned: true,
        answerText: answer.answerText,
        citedDomains: [],
        citedUrls: answer.cited ? [HARBOR_URL] : [],
        captureStatus: 'complete',
        recommendedCompetitors: [],
        location: HARBOR_CONTEXT.label,
        measurementExecutionId: slot.executionId,
        requestedContext: HARBOR_CONTEXT,
        supportedContext: { status: 'applied', resolved: HARBOR_CONTEXT },
        createdAt: input.createdAt,
      }).run()
    }
  }

  /** OpenAI named and cited Harbor Homes; Gemini named no Property. */
  const NAMED_AND_CITED: NearbyAnswers = {
    openai: { answerText: 'Harbor Homes is recommended.', cited: true },
    gemini: { answerText: 'No property names are supplied.', cited: false },
  }
  /** Neither engine names or cites a Property. */
  const NOTHING_NAMED: NearbyAnswers = {
    openai: { answerText: 'No property names are supplied.', cited: false },
    gemini: { answerText: 'No property names are supplied.', cited: false },
  }

  const HARBOR_LOST = {
    queryId: 'q-nearby',
    query: 'homes near harbor',
    queryClass: 'non-brand',
    providers: ['openai'],
    locations: ['Harbor'],
    properties: [{ key: 'harbor', label: 'Harbor Homes' }],
    markets: [],
  }

  it('counts each Property\'s lost mention and lost citation against the comparable previous sweep, each query once', async () => {
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = publish(frozenPlan)
    sweep('run_1', { versionId, frozenPlan, createdAt: FIRST, nearby: NAMED_AND_CITED })
    sweep('run_2', { versionId, frozenPlan, createdAt: SECOND, nearby: NOTHING_NAMED })

    expect(await readWhatChanged('northstar')).toEqual({
      mode: 'advanced',
      latestCheck: { runIds: ['run_2'], createdAt: SECOND },
      comparison: { state: 'available', previousRunIds: ['run_1'] },
      lostMentions: { queryCount: 1, queries: [HARBOR_LOST], truncated: false },
      lostCitations: { queryCount: 1, queries: [HARBOR_LOST], truncated: false },
      activeRuns: NO_ACTIVE_RUNS,
      items: [
        lostMentionsRow(PROJECT_ID, 'northstar', 'Northstar', '1 query lost a mention in the latest check.'),
        lostCitationsRow(PROJECT_ID, 'northstar', 'Northstar', '1 query lost a citation in the latest check.'),
      ],
    })
  })

  it('compares nothing across a change of engines or models, and nothing before the first sweep', async () => {
    const frozenPlan = measurementPlanV2Fixture()
    const versionId = publish(frozenPlan)
    expect((await readWhatChanged('northstar')).comparison).toEqual({ state: 'unavailable', reason: 'not-measured' })

    sweep('run_1', { versionId, frozenPlan, createdAt: FIRST, nearby: NAMED_AND_CITED })
    expect((await readWhatChanged('northstar')).comparison).toEqual({ state: 'unavailable', reason: 'no-previous-check' })

    sweep('run_2', { versionId, frozenPlan, createdAt: SECOND, nearby: NOTHING_NAMED, models: 'another-model-series' })
    expect(await readWhatChanged('northstar')).toEqual({
      mode: 'advanced',
      latestCheck: { runIds: ['run_2'], createdAt: SECOND },
      comparison: { state: 'unavailable', reason: 'model-changed' },
      lostMentions: NOTHING_LOST,
      lostCitations: NOTHING_LOST,
      activeRuns: NO_ACTIVE_RUNS,
      items: [],
    })
  })
})
