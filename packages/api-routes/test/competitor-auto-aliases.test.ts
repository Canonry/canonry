import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, competitors, createClient, marketCompetitorNames, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import {
  canonicalMeasurementPlanV2Json,
  competitorLandscapeResponseSchema,
  measurementPlanV2Schema,
  type AnchoredAnswerSpan,
  type CompetitorAutoAliasDetectionDto,
  type CompetitorDto,
} from '@ainyc/canonry-contracts'
import { apiRoutes, createRunCompetitorResolver, readMarketCompetitorNames } from '../src/index.js'

// Answer-derived competitor aliases over the API: detection reads stored
// answers only (fictional ones here), writes through the shared competitor
// identity rules, and curated identity always wins.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let namesChanged: string[]
let rescans: string[]

async function startApp(anchors?: (provider: string, rawResponse: string | null) => AnchoredAnswerSpan[]) {
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onCompetitorAliasesChanged: (_id, name) => namesChanged.push(name),
    onCompetitorAutoAliasRescan: (_id, name) => rescans.push(name),
    ...(anchors ? { competitorAnswerAnchors: anchors } : {}),
  })
  await app.ready()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-competitor-auto-aliases-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  namesChanged = []
  rescans = []
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function createProject(): Promise<string> {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/rotorwise',
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' },
  })
  expect(res.statusCode).toBe(201)
  return db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
}

function track(projectId: string, domain: string, extra: Partial<typeof competitors.$inferInsert> = {}): void {
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, provenance: 'cli', createdAt: '2026-09-01T00:00:00.000Z', ...extra }).run()
}

type SeededAnswer = { text: string; cited: string[]; rawResponse?: string }

/**
 * One run per entry, each storing the given answers. Runs are a day apart
 * unless `createdAt` puts several at one moment (one multi-location sweep).
 */
function seedSweeps(projectId: string, sweeps: SeededAnswer[][], opts: { createdAt?: (index: number) => string } = {}): void {
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: `bike tune-up ${queryId}`, createdAt: '2026-09-01T00:00:00.000Z' }).run()
  sweeps.forEach((answers, index) => {
    const runId = crypto.randomUUID()
    const at = opts.createdAt?.(index) ?? `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at }).run()
    db.transaction((tx) => {
      for (const entry of answers) {
        tx.insert(querySnapshots).values({
          id: crypto.randomUUID(), runId, queryId, provider: 'gemini', citationState: 'not-cited', answerMentioned: false,
          answerText: entry.text, citedDomains: entry.cited, rawResponse: entry.rawResponse ?? null, createdAt: at,
        }).run()
      }
    })
  })
}

/** An answer that names no tracked competitor and cites none: the contrast a lift needs. */
const OTHER_ANSWER: SeededAnswer = { text: 'Check your tire pressure before every ride.', cited: ['ridersguide.example'] }
const TUNESPOKE_ANSWER: SeededAnswer = { text: 'For tune-ups, book with [TuneSpoke](https://spoketuneworks.example/book) today.', cited: ['spoketuneworks.example'] }

/**
 * Three sweeps whose answers write a named link pairing "TuneSpoke" with its
 * site, next to two answers per sweep that do neither: lift (3/3) / ((0 + 1)
 * / (6 + 2)) = 8.
 */
function seedTuneSpoke(projectId: string): void {
  seedSweeps(projectId, [0, 1, 2].map(() => [TUNESPOKE_ANSWER, OTHER_ANSWER, OTHER_ANSWER]))
}

const detect = async (method: 'GET' | 'POST') => {
  const res = await app.inject({ method, url: '/api/v1/projects/rotorwise/competitor-auto-aliases' })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as CompetitorAutoAliasDetectionDto
}
const stored = (projectId: string, domain: string) =>
  db.select().from(competitors).where(and(eq(competitors.projectId, projectId), eq(competitors.domain, domain))).get()!
const audits = (projectId: string, action: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all()
const block = (domain: string, aliases: string[], action: 'block' | 'unblock' = 'block') =>
  app.inject({ method: 'POST', url: `/api/v1/projects/rotorwise/competitors/${domain}/aliases/${action}`, payload: { aliases } })

describe('GET and POST /projects/:name/competitor-auto-aliases', () => {
  it('previews without writing, then applies once, audits as the system and stays idempotent', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedTuneSpoke(projectId)

    const preview = await detect('GET')
    expect(preview).toMatchObject({
      project: 'rotorwise',
      applied: false,
      changed: true,
      scan: { runs: 3, snapshots: 9, answers: 9, maxRuns: 60, maxSnapshots: 6000, providerCitations: false },
    })
    expect(preview.thresholds).toEqual({
      minDirectPairs: 2,
      minRuns: 2,
      minNamingAnswers: 3,
      minPrecision: 0.1,
      minLift: 3,
      minNameCasedShare: 0.75,
      minKeyLength: 4,
      dominanceMultiple: 2,
      removeBelowPrecision: 0.05,
      removeBelowLift: 1.5,
      removeBelowNameCasedShare: 0.5,
    })
    expect(preview.competitors).toEqual([expect.objectContaining({
      domain: 'spoketuneworks.example',
      aliases: [],
      blockedAliases: [],
      added: ['TuneSpoke'],
      removed: [],
      candidates: [expect.objectContaining({ name: 'TuneSpoke', status: 'added', directPairs: 3, runs: 3, namingAnswers: 3, nameCasedAnswers: 3, precision: 1, lift: 8, via: ['answer-link'] })],
    })])
    expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([])
    expect(audits(projectId, 'competitors.auto-aliases-updated')).toHaveLength(0)

    const applied = await detect('POST')
    expect(applied).toMatchObject({ applied: true, changed: true })
    expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([expect.objectContaining({ name: 'TuneSpoke', directPairs: 3 })])
    const rows = audits(projectId, 'competitors.auto-aliases-updated')
    expect(rows.map(row => row.actor)).toEqual(['system'])
    expect(namesChanged).toEqual(['rotorwise'])

    const again = await detect('POST')
    expect(again.changed).toBe(false)
    expect(audits(projectId, 'competitors.auto-aliases-updated')).toHaveLength(1)
    expect(namesChanged).toEqual(['rotorwise'])
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/competitors' })).json() as CompetitorDto[]
    expect(listed[0]).toMatchObject({ domain: 'spoketuneworks.example', aliases: [], autoAliases: [{ name: 'TuneSpoke' }], blockedAliases: [] })
    // The overview carries the names only, under its own field name.
    const overview = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/overview' })).json() as { competitors: Record<string, unknown>[] }
    expect(overview.competitors[0]).toMatchObject({ domain: 'spoketuneworks.example', autoAliasNames: ['TuneSpoke'] })
    expect(overview.competitors[0]).not.toHaveProperty('autoAliases')
  })

  it('reads provider citation structures through the host reader', async () => {
    const readerCalls: string[] = []
    await startApp((provider, rawResponse) => {
      readerCalls.push(provider)
      return rawResponse === 'anchored'
        ? [{ text: '* **TuneSpoke:** tune-ups', source: 'spoketuneworks.example', kind: 'window', via: 'gemini-support' }]
        : []
    })
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    const answer = { text: 'Options:\n* **TuneSpoke:** tune-ups\n', cited: ['spoketuneworks.example'], rawResponse: 'anchored' }
    seedSweeps(projectId, [0, 1, 2].map(() => [answer, OTHER_ANSWER, OTHER_ANSWER]))

    // Two dry runs at once share one scan: the reader sees each stored answer once.
    const [preview, twin] = await Promise.all([detect('GET'), detect('GET')])
    expect(readerCalls).toEqual(Array.from({ length: 9 }, () => 'gemini'))
    expect(twin).toEqual(preview)
    expect(preview.scan.providerCitations).toBe(true)
    expect(preview.competitors[0]!.candidates[0]).toMatchObject({ name: 'TuneSpoke', status: 'added', via: ['gemini-support'] })
  })

  it('counts the runs of one multi-location sweep as one sweep', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    // Three locations of one sweep share the moment it started.
    seedSweeps(projectId, [0, 1, 2].map(() => [TUNESPOKE_ANSWER, OTHER_ANSWER, OTHER_ANSWER]), { createdAt: () => '2026-09-01T00:00:00.000Z' })
    const preview = await detect('GET')
    expect(preview.scan.runs).toBe(3)
    expect(preview.competitors[0]).toMatchObject({ added: [] })
    expect(preview.competitors[0]!.candidates[0]).toMatchObject({ name: 'TuneSpoke', status: 'rejected', reason: 'too-few-runs', directPairs: 3, runs: 1 })
  })

  it('does not count an answer that writes the name only inside a curated alias as naming it', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    // Per sweep: one answer pairs "TuneSpoke" with its site, two write only
    // the longer "TuneSpoke Garage" and cite nothing, two do neither.
    const GARAGE_ANSWER: SeededAnswer = { text: 'Riders swear by TuneSpoke Garage for wheel truing.', cited: [] }
    seedSweeps(projectId, [0, 1, 2].map(() => [TUNESPOKE_ANSWER, GARAGE_ANSWER, GARAGE_ANSWER, OTHER_ANSWER, OTHER_ANSWER]))
    const candidate = async () => (await detect('GET')).competitors[0]!.candidates.find(item => item.name === 'TuneSpoke')

    // Counted as naming it, the garage answers sink its lift: (3/9) / ((0 + 1) / (6 + 2)) < 3.
    expect(await candidate()).toMatchObject({ status: 'rejected', reason: 'low-lift', namingAnswers: 9, citingAnswers: 3 })

    const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', payload: { aliases: ['TuneSpoke Garage'] } })
    expect(res.statusCode, res.body).toBe(200)
    // Once "TuneSpoke Garage" is curated, those answers name the curated
    // alias, not "TuneSpoke": (3/3) / ((0 + 1) / (12 + 2)) = 14.
    expect(await candidate()).toMatchObject({ status: 'added', namingAnswers: 3, citingAnswers: 3, precision: 1, lift: 14 })
  })

  it('stops at the snapshot cap inside a run instead of reading the run whole', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedSweeps(projectId, [
      [TUNESPOKE_ANSWER, OTHER_ANSWER],
      Array.from({ length: 6005 }, () => OTHER_ANSWER),
    ])
    const preview = await detect('GET')
    // The newest run alone holds 6005 snapshots: the scan reads 6000 of them
    // and never reaches the older run.
    expect(preview.scan).toMatchObject({ runs: 1, snapshots: 6000, answers: 6000, maxSnapshots: 6000 })
  })

  it('applies through the host\'s per-project pass when it provides one', async () => {
    const hostCalls: string[] = []
    app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onCompetitorAliasesChanged: (_id, name) => namesChanged.push(name),
      runCompetitorAutoAliasPass: async (projectId) => {
        hostCalls.push(projectId)
        const { applyCompetitorAutoAliases } = await import('../src/competitor-auto-aliases.js')
        return applyCompetitorAutoAliases(db, projectId)
      },
    })
    await app.ready()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedTuneSpoke(projectId)
    const applied = await detect('POST')
    expect(hostCalls).toEqual([projectId])
    expect(applied.competitors[0]!.added).toEqual(['TuneSpoke'])
    // The host's pass owns the competitor-fields refresh.
    expect(namesChanged).toEqual([])
  })

  it('applies one pass at a time per project: a concurrent apply waits and finds nothing left to change', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedTuneSpoke(projectId)
    const [first, second] = await Promise.all([detect('POST'), detect('POST')])
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(audits(projectId, 'competitors.auto-aliases-updated')).toHaveLength(1)
    expect(namesChanged).toEqual(['rotorwise'])
  })

  it('returns 404 for an unknown project', async () => {
    await startApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nobody/competitor-auto-aliases' })
    expect(res.statusCode).toBe(404)
  })
})

describe('auto names in the competitor matchers', () => {
  it('credits an answer that names a competitor only by its auto name, and stops once the name is blocked', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedTuneSpoke(projectId)
    await detect('POST')

    const runId = crypto.randomUUID()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-09-20T00:00:00.000Z' }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, provider: 'openai', citationState: 'not-cited', answerMentioned: false,
      answerText: 'Riders keep recommending TuneSpoke for quick fixes.', citedDomains: [], createdAt: '2026-09-20T00:00:00.000Z',
    }).run()
    const terms = async () => {
      const detail = (await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })).json() as { snapshots: { mentionedCompetitorTerms?: string[] }[] }
      return detail.snapshots[0]!.mentionedCompetitorTerms ?? []
    }
    expect(await terms()).toEqual(['TuneSpoke'])

    expect((await block('spoketuneworks.example', ['TuneSpoke'])).statusCode).toBe(200)
    expect(await terms()).toEqual([])
  })
})

describe('POST /projects/:name/competitors/:domain/aliases/block and unblock', () => {
  it('removes a stored auto name, keeps it out of detection, and releases it on unblock', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    seedTuneSpoke(projectId)
    await detect('POST')
    namesChanged = []

    const blocked = await block('spoketuneworks.example', ['  tune spoke ', 'Tune-Spoke'])
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({ domain: 'spoketuneworks.example', autoAliases: [], blockedAliases: ['tune spoke'] })
    expect(namesChanged).toEqual(['rotorwise'])
    expect(JSON.parse(audits(projectId, 'competitors.aliases-blocked')[0]!.diff!)).toMatchObject({
      domain: 'spoketuneworks.example', blocked: ['tune spoke'], before: [], after: ['tune spoke'], removedAutoAliases: ['TuneSpoke'],
    })

    // Idempotent: the same block again writes and audits nothing.
    expect((await block('www.spoketuneworks.example', ['TUNESPOKE'])).statusCode).toBe(200)
    expect(audits(projectId, 'competitors.aliases-blocked')).toHaveLength(1)
    expect((await detect('POST')).changed).toBe(false)
    expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([])

    const unblocked = await block('spoketuneworks.example', ['TuneSpoke'], 'unblock')
    expect(unblocked.json()).toMatchObject({ blockedAliases: [] })
    expect(rescans).toEqual(['rotorwise'])
    expect((await detect('POST')).competitors[0]!.added).toEqual(['TuneSpoke'])
  })

  it('refuses a curated alias, an unknown competitor and an empty name', async () => {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'qvx.example', { aliases: ['QVX'] })
    const curated = await block('qvx.example', ['qvx'])
    expect(curated.statusCode).toBe(400)
    expect(curated.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { domain: 'qvx.example', curated: ['qvx'] } })
    expect((await block('nobody.example', ['Nobody'])).statusCode).toBe(404)
    expect((await block('qvx.example', ['...'])).statusCode).toBe(400)
    expect((await block('qvx.example', [])).statusCode).toBe(400)
  })
})

describe('curated identity wins over auto names', () => {
  async function withAutoTuneSpoke(): Promise<string> {
    await startApp()
    const projectId = await createProject()
    track(projectId, 'spoketuneworks.example')
    track(projectId, 'rimdoctor.example')
    seedTuneSpoke(projectId)
    await detect('POST')
    namesChanged = []
    return projectId
  }

  it('drops the auto name when the same competitor curates it, and audits the drop', async () => {
    const projectId = await withAutoTuneSpoke()
    const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', payload: { aliases: ['Tune Spoke'] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ aliases: ['Tune Spoke'], autoAliases: [] })
    expect(namesChanged).toEqual(['rotorwise'])
    expect(JSON.parse(audits(projectId, 'competitors.aliases-updated')[0]!.diff!)).toMatchObject({
      autoAliasChanges: [{ domain: 'spoketuneworks.example', before: ['TuneSpoke'], after: [] }],
      droppedAutoAliases: [{ domain: 'spoketuneworks.example', alias: 'TuneSpoke', reason: 'already-matched', stored: true }],
    })
  })

  it('drops another competitor\'s overlapping auto name instead of refusing a curated write', async () => {
    const projectId = await withAutoTuneSpoke()
    // "TuneSpoke" sits inside "TuneSpoke Rims": one answer would credit both.
    const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/rimdoctor.example/aliases', payload: { aliases: ['TuneSpoke Rims'] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([])
    expect(stored(projectId, 'rimdoctor.example').aliases).toEqual(['TuneSpoke Rims'])
  })

  it('adds a domain whose name overlaps an auto name, drops that name and asks for a rescan', async () => {
    const projectId = await withAutoTuneSpoke()
    rescans = []
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([])
    expect(namesChanged).toEqual(['rotorwise'])
    expect(rescans).toEqual(['rotorwise'])
  })

  it('records discarded auto and blocked names when a competitor is deleted', async () => {
    const projectId = await withAutoTuneSpoke()
    await block('spoketuneworks.example', ['Spoke Crew'])
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example'] } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(audits(projectId, 'competitors.deleted')[0]!.diff!)).toMatchObject({
      deleted: ['spoketuneworks.example'],
      deletedAutoAliases: { 'spoketuneworks.example': ['TuneSpoke'] },
      deletedBlockedAliases: { 'spoketuneworks.example': ['Spoke Crew'] },
    })
  })
})

describe('a competitor an Advanced market pins without tracking it project-wide', () => {
  /**
   * Two markets: "north" pins spoketuneworks.example, "south" pins nothing.
   * The competitor has no project competitors row.
   */
  const NODES = { north: 3, south: 10 } as const
  const nodes = (market: keyof typeof NODES) => Array.from({ length: NODES[market] }, (_, index) => `${market}-${index}`)
  type PinInput = { stableKey: string; label: string; domain: string; aliases: string[] }
  const SPOKE_PIN: PinInput = { stableKey: 'spoke', label: 'Spoke Tune Works', domain: 'spoketuneworks.example', aliases: [] }

  /**
   * Publish a plan revision and make it the active one. Revision 1 pins
   * spoketuneworks.example in "north" unless `north` says otherwise.
   */
  function seedMarkets(projectId: string, opts: { north?: PinInput[]; revision?: number } = {}): string {
    const revision = opts.revision ?? 1
    const all = [...nodes('north'), ...nodes('south')]
    const marketOf = (node: string) => node.split('-')[0]!
    const plan = measurementPlanV2Schema.parse({
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'rotorwise.example', ownedHosts: ['rotorwise.example'], names: ['Rotorwise'] } },
      targets: ['north', 'south'].map(market => ({
        stableKey: `${market}-shop`, label: `${market} shop`, aliases: [`${market} shop`],
        urlMatchers: [{ kind: 'host', host: 'rotorwise.example' }], mentionNotApplicable: false, discoveryIdentity: null,
      })),
      groups: [
        { stableKey: 'north', label: 'North', targetKeys: ['north-shop'], competitors: opts.north ?? [SPOKE_PIN] },
        { stableKey: 'south', label: 'South', targetKeys: ['south-shop'], competitors: [] },
      ],
      querySnapshots: all.map(node => ({ queryId: `q-${node}`, queryText: `bike tune-up ${node}`, provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-01T00:00:00.000Z' } })),
      assignments: all.map(node => ({ targetKey: `${marketOf(node)}-shop`, queryId: `q-${node}`, queryClass: 'non-brand', executionNodeKey: `exec-${node}` })),
      executionNodes: all.map(node => ({
        stableKey: `exec-${node}`, queryId: `q-${node}`, queryText: `bike tune-up ${node}`,
        context: { providers: ['gemini'], models: {}, location: null }, expectedSnapshots: 1,
      })),
      usageEdges: all.map(node => ({ executionNodeKey: `exec-${node}`, targetKey: `${marketOf(node)}-shop`, queryId: `q-${node}` })),
      compiledChecksum: 'a'.repeat(64),
    })
    const versionId = crypto.randomUUID()
    const canonicalJson = canonicalMeasurementPlanV2Json(plan)
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId, revision, canonicalJson, checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
      schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: '2026-09-01T00:00:00.000Z',
    }).run()
    if (revision === 1) {
      db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }).run()
    } else {
      db.update(measurementPlans).set({ activeVersionId: versionId, updatedAt: '2026-09-10T00:00:00.000Z' }).where(eq(measurementPlans.projectId, projectId)).run()
    }
    return versionId
  }

  /**
   * Three plan sweeps. In the north market each pairs "TuneSpoke" with its
   * site once, beside two answers that do neither. In the south market, where
   * the competitor is not measured, ten answers per sweep name "TuneSpoke"
   * and cite nothing: counted, they would sink its precision to 3 of 33.
   */
  function seedMarketSweeps(projectId: string, versionId: string, opts: { /** At most 6. */ extraNorth?: SeededAnswer[] } = {}): void {
    for (const day of ['01', '02', '03']) {
      const runId = crypto.randomUUID()
      const at = `2026-09-${day}T00:00:00.000Z`
      db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', measurementPlanVersionId: versionId, createdAt: at, finishedAt: at }).run()
      const north = nodes('north')
      const answers: (SeededAnswer & { node: string; provider?: string })[] = [
        { ...TUNESPOKE_ANSWER, node: north[0]! },
        { ...OTHER_ANSWER, node: north[1]! },
        { ...OTHER_ANSWER, node: north[2]! },
        // More answers per sweep to the north market's questions, from other
        // providers (one snapshot per run, execution node and provider).
        ...(opts.extraNorth ?? []).map((entry, index) => ({ ...entry, node: north[index % 3]!, provider: ['openai', 'claude'][Math.floor(index / 3)]! })),
        ...nodes('south').map(node => ({ text: 'Riders in the south say TuneSpoke is worth a look.', cited: [], node })),
      ]
      db.transaction((tx) => {
        for (const entry of answers) {
          tx.insert(querySnapshots).values({
            id: crypto.randomUUID(), runId, provider: entry.provider ?? 'gemini', citationState: 'not-cited', answerMentioned: false,
            answerText: entry.text, citedDomains: entry.cited, measurementExecutionId: `exec-${entry.node}`, createdAt: at,
          }).run()
        }
      })
    }
  }

  const landscape = async (groupKey: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/rotorwise/analytics/competitors?window=all&groupKey=${groupKey}&queryClass=non-brand` })
    expect(res.statusCode, res.body).toBe(200)
    return competitorLandscapeResponseSchema.parse(res.json())
  }

  it('learns its names from that market\'s answers only, stores them for that market, and never tracks it project-wide', async () => {
    await startApp()
    const projectId = await createProject()
    seedMarketSweeps(projectId, seedMarkets(projectId))
    expect((await landscape('north')).pinned.find(row => row.domain === 'spoketuneworks.example')).toMatchObject({ mentionCount: 0 })

    const applied = await detect('POST')
    const market = applied.competitors.find(entry => entry.domain === 'spoketuneworks.example')
    expect(market).toMatchObject({ marketKeys: ['north'], aliases: ['Spoke Tune Works'], added: ['TuneSpoke'] })
    // Only the north market's 9 answers: 3 name it, all 3 cite it.
    expect(market!.candidates[0]).toMatchObject({ name: 'TuneSpoke', status: 'added', directPairs: 3, runs: 3, namingAnswers: 3, citingAnswers: 3, precision: 1, lift: 8 })
    expect(namesChanged).toEqual(['rotorwise'])

    // Not a project competitor: nothing is tracked project-wide.
    const listed = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/competitors' })
    expect(listed.json()).toEqual([])
    // Readers of the north market match it by the learned name; the south
    // market never measures it.
    expect((await landscape('north')).pinned.find(row => row.domain === 'spoketuneworks.example')).toMatchObject({ mentionCount: 3 })
    expect((await landscape('south')).pinned.map(row => row.domain)).toEqual([])
    expect((await detect('POST')).changed).toBe(false)
  })

  it('does not count a north answer that writes the name only inside the pin\'s plan alias as naming it', async () => {
    await startApp()
    const projectId = await createProject()
    const GARAGE_ANSWER: SeededAnswer = { text: 'Riders swear by TuneSpoke Garage for wheel truing.', cited: [] }
    const versionId = seedMarkets(projectId, { north: [{ ...SPOKE_PIN, aliases: ['TuneSpoke Garage'] }] })
    seedMarketSweeps(projectId, versionId, { extraNorth: [GARAGE_ANSWER, GARAGE_ANSWER] })

    const market = (await detect('GET')).competitors.find(entry => entry.domain === 'spoketuneworks.example')!
    expect(market).toMatchObject({ marketKeys: ['north'], aliases: ['Spoke Tune Works', 'TuneSpoke Garage'], added: ['TuneSpoke'] })
    // 15 north answers: 3 pair and name "TuneSpoke"; the 6 that write only
    // "TuneSpoke Garage" name the plan alias, so they neither name it nor
    // sink its lift to (3/9) / ((0 + 1) / (6 + 2)).
    expect(market.candidates.find(item => item.name === 'TuneSpoke'))
      .toMatchObject({ status: 'added', namingAnswers: 3, citingAnswers: 3, precision: 1, lift: 14 })
  })

  it('blocks and unblocks a learned market name like a project competitor\'s', async () => {
    await startApp()
    const projectId = await createProject()
    seedMarketSweeps(projectId, seedMarkets(projectId))
    await detect('POST')
    namesChanged = []

    const blocked = await block('spoketuneworks.example', ['TuneSpoke'])
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({ domain: 'spoketuneworks.example', marketKeys: ['north'], aliases: ['Spoke Tune Works'], autoAliases: [], blockedAliases: ['TuneSpoke'] })
    expect(namesChanged).toEqual(['rotorwise'])
    expect((await landscape('north')).pinned.find(row => row.domain === 'spoketuneworks.example')).toMatchObject({ mentionCount: 0 })
    expect((await detect('POST')).changed).toBe(false)
    // A plan name is the operator's own and cannot be blocked.
    expect((await block('spoketuneworks.example', ['Spoke Tune Works'])).statusCode).toBe(400)

    expect((await block('spoketuneworks.example', ['TuneSpoke'], 'unblock')).json()).toMatchObject({ blockedAliases: [] })
    expect(rescans).toEqual(['rotorwise'])
    expect((await detect('POST')).competitors.find(entry => entry.domain === 'spoketuneworks.example')!.added).toEqual(['TuneSpoke'])
  })

  /** What one north answer is scored against, as the stored fields and the landscape score it. */
  const northAliases = (projectId: string, versionId: string) => Object.fromEntries(createRunCompetitorResolver(
    db,
    db.select().from(competitors).where(eq(competitors.projectId, projectId)).all(),
    readMarketCompetitorNames(db, projectId),
  )(versionId, 'exec-north-1').aliases)

  describe('when a project competitor\'s pin in the same market lists the name as a plan alias', () => {
    // qvx.example is tracked with no curated alias; the north market pins it
    // as "Quiet Vox" with the plan alias "TuneSpoke".
    const QUIET_VOX_PIN: PinInput = { stableKey: 'qvx', label: 'Quiet Vox', domain: 'qvx.example', aliases: ['TuneSpoke'] }

    it('never learns the name for the market competitor, so one answer never counts for both', async () => {
      await startApp()
      const projectId = await createProject()
      track(projectId, 'qvx.example')
      const versionId = seedMarkets(projectId, { north: [QUIET_VOX_PIN, SPOKE_PIN] })
      seedMarketSweeps(projectId, versionId)

      const market = (await detect('POST')).competitors.find(entry => entry.domain === 'spoketuneworks.example')!
      expect(market).toMatchObject({ marketKeys: ['north'], added: [] })
      expect(market.candidates.find(candidate => candidate.name === 'TuneSpoke'))
        .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'qvx.example' })
      expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
      expect(northAliases(projectId, versionId)).toEqual({ 'qvx.example': ['Quiet Vox', 'TuneSpoke'], 'spoketuneworks.example': ['Spoke Tune Works'] })
    })

    it('stops reading a name stored before the pin listed it, and detection removes it', async () => {
      await startApp()
      const projectId = await createProject()
      track(projectId, 'qvx.example')
      const versionId = seedMarkets(projectId, { north: [QUIET_VOX_PIN, SPOKE_PIN] })
      seedMarketSweeps(projectId, versionId)
      db.insert(marketCompetitorNames).values({
        id: crypto.randomUUID(), projectId, domain: 'spoketuneworks.example', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
        autoAliases: [{ name: 'TuneSpoke', directPairs: 3, cooccurrences: 3, namingAnswers: 3, precision: 1, lift: 8, nameCasedAnswers: 3, runs: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-03T00:00:00.000Z', addedAt: '2026-09-04T00:00:00.000Z' }],
      }).run()

      expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
      expect(northAliases(projectId, versionId)['spoketuneworks.example']).toEqual(['Spoke Tune Works'])
      const market = (await detect('POST')).competitors.find(entry => entry.domain === 'spoketuneworks.example')!
      expect(market.removed).toEqual([{ name: 'TuneSpoke', reason: 'other-competitor', conflictsWith: 'qvx.example' }])
    })
  })

  describe('a market pin of another domain that lists a project competitor\'s learned name', () => {
    // The north market pins qvx.example, which the project does not track, as
    // "Quiet Vox" with the plan alias "TuneSpoke".
    const QUIET_VOX_PIN: PinInput = { stableKey: 'qvx', label: 'Quiet Vox', domain: 'qvx.example', aliases: ['TuneSpoke'] }

    it('keeps the name out while a superseded revision a run was measured under still pins it', async () => {
      await startApp()
      const projectId = await createProject()
      track(projectId, 'spoketuneworks.example')
      seedTuneSpoke(projectId)
      const rev1 = seedMarkets(projectId, { north: [QUIET_VOX_PIN] })
      seedMarkets(projectId, { north: [], revision: 2 })
      const spoke = async () => (await detect('GET')).competitors.find(entry => entry.domain === 'spoketuneworks.example')!

      // No run was measured under revision 1, so its pin scores nothing.
      expect((await spoke()).added).toEqual(['TuneSpoke'])

      // A run that ended without storing an answer scored nothing with it either.
      const runId = crypto.randomUUID()
      db.insert(runs).values({
        id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled',
        measurementPlanVersionId: rev1, createdAt: '2026-09-05T00:00:00.000Z', finishedAt: '2026-09-05T00:00:00.000Z',
      }).run()
      expect((await spoke()).added).toEqual(['TuneSpoke'])

      // Once that run stores an answer, it is scored with revision 1's pin.
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, provider: 'gemini', citationState: 'not-cited', answerMentioned: false,
        answerText: 'Check your tire pressure before every ride.', citedDomains: [], measurementExecutionId: 'exec-north-0',
        createdAt: '2026-09-05T00:00:00.000Z',
      }).run()
      const measured = await spoke()
      expect(measured.added).toEqual([])
      expect(measured.candidates.find(candidate => candidate.name === 'TuneSpoke'))
        .toMatchObject({ status: 'rejected', reason: 'other-competitor', conflictsWith: 'qvx.example' })
    })

    it('drops the stored name on the next competitor write, as a curated alias would', async () => {
      await startApp()
      const projectId = await createProject()
      track(projectId, 'spoketuneworks.example')
      track(projectId, 'rimdoctor.example')
      seedTuneSpoke(projectId)
      await detect('POST')
      expect(stored(projectId, 'spoketuneworks.example').autoAliases.map(record => record.name)).toEqual(['TuneSpoke'])
      // A revision stored after the name was learned, without a pin route
      // (one would have dropped it already), as an older build could.
      seedMarkets(projectId, { north: [QUIET_VOX_PIN] })
      namesChanged = []

      const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/rimdoctor.example/aliases', payload: { aliases: ['Rim Docs'] } })
      expect(res.statusCode, res.body).toBe(200)
      expect(stored(projectId, 'spoketuneworks.example').autoAliases).toEqual([])
      expect(namesChanged).toEqual(['rotorwise'])
      expect(JSON.parse(audits(projectId, 'competitors.aliases-updated')[0]!.diff!)).toMatchObject({
        droppedAutoAliases: [{ domain: 'spoketuneworks.example', alias: 'TuneSpoke', reason: 'other-competitor', stored: true, conflictsWith: 'qvx.example' }],
      })
    })
  })

  it('keeps applying learned names to the runs whose own revision pins the competitor after a newer revision drops the pin', async () => {
    await startApp()
    const projectId = await createProject()
    const rev1 = seedMarkets(projectId)
    seedMarketSweeps(projectId, rev1)
    await detect('POST')
    expect(northAliases(projectId, rev1)['spoketuneworks.example']).toEqual(['Spoke Tune Works', 'TuneSpoke'])

    // Revision 2 pins nothing: the older runs still measured the competitor,
    // so their stored fields keep its learned name on the next recompute.
    seedMarkets(projectId, { north: [], revision: 2 })
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map([['spoketuneworks.example', ['TuneSpoke']]]))
    expect(northAliases(projectId, rev1)['spoketuneworks.example']).toEqual(['Spoke Tune Works', 'TuneSpoke'])

    // Current curated identity still wins: a project competitor that now
    // carries the name takes it.
    track(projectId, 'qvx.example', { aliases: ['TuneSpoke'] })
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
  })
})
