/**
 * `shape=answers|sources` on the Property evidence route.
 *
 * The source shape is the published one and must not move a byte, so it is
 * locked against a capture taken from the route BEFORE the parameter existed
 * (`measurement-property-evidence-baseline.json`). Do not regenerate that file
 * from the current route — regenerating it blesses exactly the drift it exists
 * to catch. A deliberate change to the flat shape is a wire-contract break and
 * needs saying out loud.
 *
 * The answer shape is paged on the SLOT, so a page boundary can never fall
 * between one answer's cited URLs, and its cursor is refused on a source-shape
 * request and the reverse.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  type MeasurementAnswerEvidence,
  type MeasurementAttributionEvidence,
  type MeasurementOtherQueryCitation,
  type MeasurementPlanV2,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementReportResponse,
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
import { buildMeasurementEvidence } from '../src/measurement-report.js'
import {
  buildMeasurementPlanV2Manifest,
  buildMeasurementPlanV2ReportInput,
  measurementRunExpectedSlots,
} from '../src/measurement-report-adapter.js'
import {
  measurementPagingPlanFixture,
  pagingNodeKind,
  PAGING_NODE_COUNTS,
  seedPagingSnapshots,
} from './measurement-property-evidence-paging-fixture.js'

/**
 * The paging walk below is quadratic, and that is a fact about the ROUTE, not
 * about the test. `measurement-property-evidence.ts` rebuilds the entire
 * evidence set on every request and then linear-scans it to resolve the cursor,
 * so walking one 156-row fixture at limit=1,2,3,7,50,100 issues 315 HTTP
 * injects to return 156 rows. Measured at ~2.6s on an idle 12-core box, which
 * is inside the 5000ms default with less headroom than it looks — the limit=1
 * and limit=2 passes alone are ~216 of those 315 requests.
 *
 * The ceiling is raised so this does not flake on slower hardware. It is NOT a
 * fix: deep paging re-derives the whole set per page in production too, and
 * that belongs in its own change against the route.
 */
vi.setConfig({ testTimeout: 30_000 })

const NOW = '2026-08-01T12:00:00.000Z'
const VERSION_ID = 'version-paging'
const RUN_ID = 'run-paging'
/** Every usage edge the Property owns is prefixed with its own stable key. */
const PILOT_EDGE_PREFIX = 'target:pilot:'

interface Baseline {
  captured: { query: string; body: string }[]
  walk: { query: string; body: string }[]
}

const BASELINE = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, 'measurement-property-evidence-baseline.json'),
  'utf8',
)) as Baseline

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string
let plan: MeasurementPlanV2

async function raw(query: string): Promise<{ status: number; body: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-property-evidence?${query}`,
  })
  return { status: response.statusCode, body: response.body }
}

async function evidence(query: string): Promise<MeasurementPropertyEvidenceResponse> {
  return JSON.parse((await raw(query)).body) as MeasurementPropertyEvidenceResponse
}

/** Walks every page at one limit and returns the concatenation, in order. */
async function walkSources(query: string, limit: number): Promise<MeasurementAttributionEvidence[]> {
  const rows: MeasurementAttributionEvidence[] = []
  let cursor: string | null = null
  do {
    const page: MeasurementPropertyEvidenceResponse = await evidence(
      `${query}&limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    )
    expect(page.evidence, `sources page at limit ${limit}`).toBeDefined()
    rows.push(...page.evidence!.items)
    cursor = page.evidence!.nextCursor
  } while (cursor !== null)
  return rows
}

async function walkAnswers(query: string, limit: number): Promise<MeasurementAnswerEvidence[]> {
  const rows: MeasurementAnswerEvidence[] = []
  let cursor: string | null = null
  do {
    const page: MeasurementPropertyEvidenceResponse = await evidence(
      `${query}&shape=answers&limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    )
    expect(page.answers, `answers page at limit ${limit}`).toBeDefined()
    rows.push(...page.answers!.items)
    cursor = page.answers!.nextCursor
  } while (cursor !== null)
  return rows
}

async function walkOtherQueries(query: string, limit: number): Promise<MeasurementOtherQueryCitation[]> {
  const rows: MeasurementOtherQueryCitation[] = []
  let cursor: string | null = null
  do {
    const page: MeasurementPropertyEvidenceResponse = await evidence(
      `${query}&shape=other-queries&limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    )
    expect(page.otherQueries, `other-queries page at limit ${limit}`).toBeDefined()
    expect(page.answers).toBeUndefined()
    expect(page.evidence).toBeUndefined()
    rows.push(...page.otherQueries!.items)
    cursor = page.otherQueries!.nextCursor
  } while (cursor !== null)
  return rows
}

/** The unpaged source rows, read from the whole-revision report rather than from the paged route. */
async function unpagedSources(): Promise<MeasurementAttributionEvidence[]> {
  const response = await app.inject({
    method: 'GET',
    // Every class, as the paged route reads by default.
    url: `/api/v1/projects/northstar/measurement-report?revision=1&runId=${RUN_ID}&queryClass=all`,
  })
  const report = response.json() as MeasurementReportResponse
  return report.evidence.filter(row => row.usageEdgeId.startsWith(PILOT_EDGE_PREFIX))
}

/** The unpaged answer rows, read straight from the kernel rather than from the paged route. */
function unpagedAnswers(): MeasurementAnswerEvidence[] {
  const run = db.select().from(runs).all().find(candidate => candidate.id === RUN_ID)!
  const snapshots = db.select().from(querySnapshots).all()
  const manifest = measurementRunExpectedSlots(run, plan)
  const { input } = buildMeasurementPlanV2ReportInput(1, plan, manifest, snapshots)
  return buildMeasurementEvidence(input).answers
    .filter(row => row.usageEdgeId.startsWith(PILOT_EDGE_PREFIX)) as MeasurementAnswerEvidence[]
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-evidence-shape-'))
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
  plan = measurementPagingPlanFixture()
  db.insert(measurementPlanVersions).values({
    id: VERSION_ID,
    projectId,
    revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: 'd'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({
    projectId, activeVersionId: VERSION_ID, createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: RUN_ID,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: VERSION_ID,
    measurementManifest: buildMeasurementPlanV2Manifest(plan),
    finishedAt: NOW,
    createdAt: NOW,
  }).run()
  seedPagingSnapshots(db, RUN_ID, plan, NOW)

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('the source shape is byte-for-byte what the route returned before shapes existed', () => {
  it('answers every captured request identically, whether shape is omitted or named', async () => {
    for (const { query, body } of BASELINE.captured) {
      expect(await raw(query), query).toMatchObject({ status: 200, body })
      expect((await raw(`${query}&shape=sources`)).body, `${query} (explicit)`).toBe(body)
    }
  })

  it('mints the same cursors and walks the same pages', async () => {
    // Cursor bytes are part of the lock: a caller mid-walk when this deploys is
    // holding one, and the page it names must still be the page it gets.
    let cursor: string | null = null
    for (const page of BASELINE.walk) {
      const query = `targetKey=sibling&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      expect(query).toBe(page.query)
      const { body } = await raw(query)
      expect(body, page.query).toBe(page.body)
      cursor = (JSON.parse(body) as { evidence: { nextCursor: string | null } }).evidence.nextCursor
    }
    expect(cursor).toBeNull()
  })
})

describe('the answer shape', () => {
  it('emits a row for an answer that cited nobody, which the source shape cannot represent', async () => {
    const answers = await walkAnswers('targetKey=pilot', 100)
    const sources = await walkSources('targetKey=pilot', 100)

    const losses = answers.filter(row => row.sources.length === 0)
    expect(losses.length).toBe(PAGING_NODE_COUNTS.loss * PAGING_NODE_COUNTS.providers)
    expect(losses.every(row => row.cited === false)).toBe(true)
    // The gap is invisible in the flat rows by construction: there is no URL to
    // hang one on, so the whole loss set contributes nothing there.
    const lossSlots = new Set(losses.map(row => row.expectedSlotId))
    expect(sources.some(row => lossSlots.has(row.expectedSlotId))).toBe(false)
  })

  it('leaves the mention unknown rather than false when the answer text never landed', async () => {
    const answers = await walkAnswers('targetKey=pilot', 100)

    const unknown = answers.filter(row => row.mentioned === null)
    expect(unknown.length).toBe(PAGING_NODE_COUNTS.silent * PAGING_NODE_COUNTS.providers)
    // Cited but with no readable answer: the two signals are independent, and
    // the missing one must not read as a measured "no".
    expect(unknown.every(row => row.cited === true)).toBe(true)
  })

  it('carries the frozen question class of the Property\'s own assignment', async () => {
    const branded = await walkAnswers('targetKey=pilot&queryClass=branded', 100)
    const nonBrand = await walkAnswers('targetKey=pilot&queryClass=non-brand', 100)

    expect(branded.length).toBeGreaterThan(0)
    expect(branded.every(row => row.queryClass === 'branded')).toBe(true)
    expect(nonBrand.every(row => row.queryClass === 'non-brand')).toBe(true)
    expect(branded.length + nonBrand.length).toBe(PAGING_NODE_COUNTS.nodes * PAGING_NODE_COUNTS.providers)
  })

  it('nests the cited URLs inside the answer instead of splitting them across rows', async () => {
    const answers = await walkAnswers('targetKey=pilot', 100)

    const cited = answers.filter(row => row.sources.length > 0)
    expect(cited.every(row => row.sources.length === 3)).toBe(true)
    // Sources keep the observation's own URL order, and each carries the
    // classification the flat shape put on its row.
    const one = cited[0]!
    expect(one.sources.map(source => source.classification)).toEqual(['external', 'assigned', 'sibling'])
    expect(one.sources.map(source => source.sourceUrl)).toEqual([...one.sources.map(source => source.sourceUrl)].sort())
    expect(one.cited).toBe(true)
  })
})

describe('a cursor is bound to the shape it was issued for', () => {
  it('refuses a source cursor on an answer request and an answer cursor on a source request', async () => {
    const sourcePage = await evidence('targetKey=pilot&limit=4')
    const answerPage = await evidence('targetKey=pilot&shape=answers&limit=4')
    const sourceCursor = encodeURIComponent(sourcePage.evidence!.nextCursor!)
    const answerCursor = encodeURIComponent(answerPage.answers!.nextCursor!)

    const crossedToAnswers = await raw(`targetKey=pilot&shape=answers&limit=4&cursor=${sourceCursor}`)
    expect(crossedToAnswers.status).toBe(400)
    expect(JSON.parse(crossedToAnswers.body)).toMatchObject({
      error: { message: 'The measurement property evidence cursor shape does not match the request.' },
    })

    const crossedToSources = await raw(`targetKey=pilot&limit=4&cursor=${answerCursor}`)
    expect(crossedToSources.status).toBe(400)
    expect(JSON.parse(crossedToSources.body)).toMatchObject({
      error: { message: 'The measurement property evidence cursor shape does not match the request.' },
    })

    // Each still works on the request it was issued for.
    expect((await evidence(`targetKey=pilot&limit=4&cursor=${sourceCursor}`)).evidence!.items).toHaveLength(4)
    expect((await evidence(`targetKey=pilot&shape=answers&limit=4&cursor=${answerCursor}`)).answers!.items).toHaveLength(4)
  })
})

describe('paging across more rows than fit on one page', () => {
  const LIMITS = [1, 2, 3, 7, 50, 100] as const

  it('lands exactly on the unpaged source rows at every page size', async () => {
    const expected = await unpagedSources()
    // The fixture must actually overflow the default page, or this proves nothing.
    expect(expected.length).toBeGreaterThan(50)

    for (const limit of LIMITS) {
      expect(await walkSources('targetKey=pilot', limit), `limit ${limit}`).toEqual(expected)
    }
    // The default page size is what a caller who passes no limit gets.
    const first = await evidence('targetKey=pilot')
    expect(first.evidence!.items).toEqual(expected.slice(0, 50))
    expect(first.evidence!.totalEstimate).toBe(expected.length)
  })

  it('lands exactly on the unpaged answer rows at every page size', async () => {
    const expected = unpagedAnswers()
    expect(expected.length).toBeGreaterThan(50)

    for (const limit of LIMITS) {
      expect(await walkAnswers('targetKey=pilot', limit), `limit ${limit}`).toEqual(expected)
    }
    const first = await evidence('targetKey=pilot&shape=answers')
    expect(first.answers!.items).toEqual(expected.slice(0, 50))
    expect(first.answers!.totalEstimate).toBe(expected.length)
  })

  it('keys every answer page on the slot, so no answer is repeated or dropped at a boundary', async () => {
    const answers = await walkAnswers('targetKey=pilot', 7)

    const keys = answers.map(row => `${row.expectedSlotId}\u0000${row.usageEdgeId}`)
    expect(new Set(keys).size).toBe(keys.length)
    // Every source row belongs to exactly one answer row, so the two shapes are
    // two readings of one result set rather than two computations of it.
    const flattened = answers.flatMap(answer => answer.sources.map(source => source.sourceUrl))
    expect(flattened).toEqual((await walkSources('targetKey=pilot', 7)).map(row => row.sourceUrl))
  })

  it('pages a narrowed result set the same way', async () => {
    const brandedAnswers = await walkAnswers('targetKey=pilot&queryClass=branded', 3)
    const brandedSources = await walkSources('targetKey=pilot&queryClass=branded', 3)

    expect(brandedAnswers).toEqual(unpagedAnswers().filter(row => row.queryClass === 'branded'))
    expect(brandedSources).toEqual(
      (await unpagedSources()).filter(row => brandedAnswers.some(answer => answer.usageEdgeId === row.usageEdgeId)),
    )
  })
})

/**
 * `sibling` is assigned only q-01, yet every answer that cited anything links
 * `/locations/sibling/<n>` too. Those are the citations its own rows can never
 * show: answers to queries assigned only to `pilot`.
 */
describe('the other-queries shape', () => {
  /** Questions whose answers cite a sibling page, minus q-01, the one sibling is assigned. */
  function expectedOtherQueryIndexes(): string[] {
    return Array.from({ length: PAGING_NODE_COUNTS.nodes }, (_unused, position) => position)
      .filter(position => pagingNodeKind(position) !== 'loss' && position !== 0)
      .map(position => String(position + 1).padStart(2, '0'))
  }

  it('lists every answer to a query not assigned to the Property that cited its pages, and only those', async () => {
    const rows = await walkOtherQueries('targetKey=sibling&queryClass=all', 100)
    const indexes = expectedOtherQueryIndexes()
    expect(indexes).toHaveLength(25)
    expect(rows).toHaveLength(indexes.length * PAGING_NODE_COUNTS.providers)
    expect(new Set(rows.map(row => row.queryText))).toEqual(new Set(indexes.map(index => `question ${index}`)))
    // Its own query never appears here: those answers are already in its rates.
    expect(rows.some(row => row.queryText === 'question 01')).toBe(false)
    for (const row of rows) {
      const index = row.queryText.slice('question '.length)
      expect(row.assignedTargetKeys).toEqual(['pilot'])
      // Only the sibling's own page is listed, never pilot's or a competitor's.
      expect(row.sources).toEqual([{
        sourceUrl: `https://northstar.example/locations/sibling/${index}`,
        normalizedUrl: `https://northstar.example/locations/sibling/${index}`,
        matchedUrlIds: [expect.any(String)],
      }])
      expect(row.sourceCount).toBe(1)
      expect(row.evidenceComplete).toBe(true)
    }
  })

  it('keeps the classes apart: each answer lists under the class its query was assigned', async () => {
    const all = await walkOtherQueries('targetKey=sibling&queryClass=all', 100)
    const nonBrand = await walkOtherQueries('targetKey=sibling&queryClass=non-brand', 100)
    const branded = await walkOtherQueries('targetKey=sibling&queryClass=branded', 100)

    // Pilot's assignments alternate classes, starting non-brand on q-01.
    expect(nonBrand).toHaveLength(12 * PAGING_NODE_COUNTS.providers)
    expect(branded).toHaveLength(13 * PAGING_NODE_COUNTS.providers)
    expect(nonBrand.every(row => row.queryClass === 'non-brand')).toBe(true)
    expect(branded.every(row => row.queryClass === 'branded')).toBe(true)
    expect(nonBrand.length + branded.length).toBe(all.length)
    const brandedSlots = new Set(branded.map(row => row.expectedSlotId))
    expect(nonBrand.some(row => brandedSlots.has(row.expectedSlotId))).toBe(false)
  })

  it('is empty for a Property assigned every query that cited it', async () => {
    const page = await evidence('targetKey=pilot&queryClass=all&shape=other-queries')
    expect(page.otherQueries).toEqual({ items: [], nextCursor: null, totalEstimate: 0 })
  })

  it('pages on the answer and class, and its cursor is refused on the other shapes', async () => {
    const expected = await walkOtherQueries('targetKey=sibling&queryClass=all', 100)
    for (const limit of [1, 7]) {
      expect(await walkOtherQueries('targetKey=sibling&queryClass=all', limit), `limit ${limit}`).toEqual(expected)
    }
    const first = await evidence('targetKey=sibling&queryClass=all&shape=other-queries&limit=3')
    expect(first.otherQueries!.totalEstimate).toBe(expected.length)
    const cursor = encodeURIComponent(first.otherQueries!.nextCursor!)
    const crossed = await raw(`targetKey=sibling&queryClass=all&shape=answers&limit=3&cursor=${cursor}`)
    expect(crossed.status).toBe(400)
    expect(JSON.parse(crossed.body)).toMatchObject({
      error: { message: 'The measurement property evidence cursor shape does not match the request.' },
    })
  })
})
