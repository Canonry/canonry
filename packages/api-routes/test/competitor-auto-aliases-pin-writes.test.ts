import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditLog,
  competitors,
  createClient,
  marketCompetitorNames,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  canonicalMeasurementPlanV2Json,
  competitorLandscapeResponseSchema,
  measurementPlanV2Schema,
  type CompetitorAutoAlias,
} from '@ainyc/canonry-contracts'
import { apiRoutes, backfillProjectAnswerMentions, readMarketCompetitorNames } from '../src/index.js'

// A market pin write can claim a name a competitor learned from answers: a
// tracked competitor's stored auto name, or a name learned for a competitor
// only a market pins. The Advanced landscape counts the active revision's and
// the pending draft's pins together, and the stored competitor columns score
// with the same learned names, so every pin writer drops the tracked auto
// names its pins now claim and, when the identity stored answers are scored
// with changed, asks for the competitor-fields recompute.

const NOW = '2026-10-01T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string
let namesChanged: string[]
let rescans: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-auto-alias-pin-writes-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  namesChanged = []
  rescans = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    // As Cloud does: the competitor-fields recompute, inside the request.
    onCompetitorAliasesChanged: (id, name) => {
      namesChanged.push(name)
      backfillProjectAnswerMentions(db, id, { competitorFieldsOnly: true })
    },
    onCompetitorAutoAliasRescan: (_id, name) => rescans.push(name),
  })
  await app.ready()
  const created = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/rotorwise',
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' },
  })
  expect(created.statusCode, created.body).toBe(201)
  projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
  db.insert(queries).values({ id: 'market-query', projectId, query: 'rotor repair near me', createdAt: NOW }).run()
  const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['alpha.example'] } })
  expect(added.statusCode, added.body).toBe(200)
  namesChanged = []
  rescans = []
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type Pin = { domain: string; label: string; aliases: string[] }

/** A v2 plan whose one market (`regional`) pins `pins`. */
function marketPlan(pins: Pin[]) {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'rotorwise.example', ownedHosts: ['rotorwise.example'], names: ['Rotorwise'] },
    },
    targets: [{
      stableKey: 'market-target',
      label: 'Market Target',
      aliases: ['Rotorwise'],
      urlMatchers: [{ kind: 'host', host: 'rotorwise.example' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [{
      stableKey: 'regional',
      label: 'Regional',
      targetKeys: ['market-target'],
      competitors: pins.map(pin => ({ stableKey: `competitor-${pin.domain}`, ...pin })),
    }],
    querySnapshots: [{
      queryId: 'market-query',
      queryText: 'rotor repair near me',
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    }],
    assignments: [{ targetKey: 'market-target', queryId: 'market-query', queryClass: 'non-brand', executionNodeKey: 'market-node' }],
    executionNodes: [{
      stableKey: 'market-node',
      queryId: 'market-query',
      queryText: 'rotor repair near me',
      context: { providers: ['openai'], models: {}, location: null },
      expectedSnapshots: 1,
    }],
    usageEdges: [{ executionNodeKey: 'market-node', targetKey: 'market-target', queryId: 'market-query' }],
    compiledChecksum: 'a'.repeat(64),
  })
}

/** Publish `pins` as revision 1 and store one answer the market measured. */
function seedMarket(pins: Pin[], answerText: string) {
  const plan = marketPlan(pins)
  db.insert(measurementPlanVersions).values({
    id: 'plan_v1',
    projectId,
    revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: '1'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: 'plan_v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(runs).values({
    id: 'market_run', projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: 'plan_v1', createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: 'market_answer',
    runId: 'market_run',
    queryId: 'market-query',
    queryText: 'rotor repair near me',
    provider: 'openai',
    citationState: 'not-cited',
    answerMentioned: true,
    answerText,
    citedDomains: [],
    citedUrls: null,
    captureStatus: 'complete',
    competitorOverlap: [],
    location: null,
    measurementExecutionId: 'market-node',
    createdAt: NOW,
  }).run()
}

function learned(name: string): CompetitorAutoAlias {
  return {
    name, directPairs: 3, cooccurrences: 3, namingAnswers: 3, precision: 1, lift: 8, nameCasedAnswers: 3, runs: 3,
    firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-03T00:00:00.000Z', addedAt: '2026-09-04T00:00:00.000Z',
  }
}

let idempotencyCounter = 0

function draftAction(action: string, payload: unknown, ifMatch?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/rotorwise/measurement-plan/draft/actions/${action}`,
    headers: { 'idempotency-key': `${action}-${++idempotencyCounter}`, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
    payload,
  })
}

async function publishDraft(etag: string) {
  const preview = await draftAction('compile-preview', {})
  expect(preview.json().ok, preview.body).toBe(true)
  return draftAction('publish', { expectedActiveRevision: 1, expectedCompiledChecksum: preview.json().compiledChecksum }, etag)
}

async function marketLandscape() {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/rotorwise/analytics/competitors?window=all&groupKey=regional&queryClass=non-brand',
  })
  expect(res.statusCode, res.body).toBe(200)
  return competitorLandscapeResponseSchema.parse(res.json())
}

const storedAutoNames = (domain: string) => db.select({ autoAliases: competitors.autoAliases }).from(competitors)
  .where(and(eq(competitors.projectId, projectId), eq(competitors.domain, domain))).get()!.autoAliases.map(record => record.name)
const storedOverlap = () => db.select({ overlap: querySnapshots.competitorOverlap }).from(querySnapshots)
  .where(eq(querySnapshots.id, 'market_answer')).get()!.overlap
const auditDiff = (action: string) => {
  const rows = db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all()
  return JSON.parse(rows.at(-1)!.diff ?? '{}') as Record<string, unknown>
}
/** Stored competitor columns a fresh recompute would still change (0 when they are current). */
const staleRows = () => backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true, dryRun: true }).wouldUpdate

const KESTREL_DROP = { domain: 'alpha.example', alias: 'Kestrel', reason: 'other-competitor', stored: true, conflictsWith: 'kestrelrotor.example' }

describe('a market pin that claims a tracked competitor\'s auto name', () => {
  beforeEach(() => {
    seedMarket([], 'Rotorwise and Kestrel both repair rotors.')
    db.update(competitors).set({ autoAliases: [learned('Kestrel')] }).where(eq(competitors.domain, 'alpha.example')).run()
    backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
  })

  it('drops the name at the draft pin, so the market keeps one credit per rival before and after publish', async () => {
    const before = await marketLandscape()
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(before.evidence.mentionCredits).toBe(2)
    expect(storedOverlap()).toEqual(['alpha.example'])

    const pinned = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'kestrelrotor.example', label: 'Kestrel' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(storedAutoNames('alpha.example')).toEqual([])
    expect(auditDiff('measurement-draft.pin-competitor')).toMatchObject({
      autoAliasChanges: [{ domain: 'alpha.example', before: ['Kestrel'], after: [] }],
      droppedAutoAliases: [KESTREL_DROP],
    })
    expect(namesChanged).toEqual(['rotorwise'])
    expect(rescans).toEqual(['rotorwise'])
    // The run's own revision never pinned kestrelrotor.example, so the stored
    // answer now credits nobody, and a fresh recompute agrees.
    expect(storedOverlap()).toEqual([])
    expect(staleRows()).toBe(0)
    // The landscape reads the pending pin: one credit, now the pin's.
    const drafted = await marketLandscape()
    expect(drafted.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(drafted.evidence.mentionCredits).toBe(2)
    expect(drafted.pinned.map(row => [row.domain, row.mentionCount])).toEqual(
      expect.arrayContaining([['alpha.example', 0], ['kestrelrotor.example', 1]]),
    )

    const published = await publishDraft(pinned.json().etag)
    expect(published.statusCode, published.body).toBe(200)
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(after.evidence.mentionCredits).toBe(2)
    expect(staleRows()).toBe(0)
  })

  it('drops a name stored after the draft pinned it when the draft is published', async () => {
    const pinned = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'kestrelrotor.example', label: 'Kestrel' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    // Stored by an older build, after the pin.
    db.update(competitors).set({ autoAliases: [learned('Kestrel')] }).where(eq(competitors.domain, 'alpha.example')).run()
    namesChanged = []

    const published = await publishDraft(pinned.json().etag)
    expect(published.statusCode, published.body).toBe(200)
    expect(storedAutoNames('alpha.example')).toEqual([])
    expect(auditDiff('measurement-draft.published')).toMatchObject({ droppedAutoAliases: [KESTREL_DROP] })
    expect(namesChanged).toEqual(['rotorwise'])
    expect(staleRows()).toBe(0)
    expect((await marketLandscape()).project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
  })

  it('drops the name at a draft competitor upsert', async () => {
    const created = await draftAction('create', { expectedActiveRevision: 1 })
    expect(created.statusCode, created.body).toBe(200)
    const upserted = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-kestrel', label: 'Kestrel', domain: 'kestrelrotor.example', aliases: [] },
    }, created.json().etag)
    expect(upserted.statusCode, upserted.body).toBe(200)
    expect(storedAutoNames('alpha.example')).toEqual([])
    expect(auditDiff('measurement-draft.upsert-competitor')).toMatchObject({ droppedAutoAliases: [KESTREL_DROP] })
    expect(namesChanged).toEqual(['rotorwise'])
    expect(staleRows()).toBe(0)
  })

  it('leaves the names and the stored columns alone for a draft edit that touches no name', async () => {
    const created = await draftAction('create', { expectedActiveRevision: 1 })
    const relabelled = await draftAction('upsert-group', { group: { stableKey: 'regional', label: 'Regional West', targetKeys: ['market-target'] } }, created.json().etag)
    expect(relabelled.statusCode, relabelled.body).toBe(200)
    expect(storedAutoNames('alpha.example')).toEqual(['Kestrel'])
    expect(auditDiff('measurement-draft.upsert-group')).not.toHaveProperty('droppedAutoAliases')
    expect(namesChanged).toEqual([])
    expect(rescans).toEqual([])
  })
})

it('a legacy v1 publish drops a tracked auto name its host claims', async () => {
  db.update(competitors).set({ autoAliases: [learned('Kestrel')] }).where(eq(competitors.domain, 'alpha.example')).run()
  const published = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/rotorwise/measurement-plan',
    payload: {
      expectedActiveRevision: null,
      plan: {
        schemaVersion: 1,
        targets: [{
          stableKey: 'market-target',
          label: 'Market Target',
          urls: [{ kind: 'prefix', host: 'rotorwise.example', pathPrefix: '/', pathCase: 'insensitive' }],
          aliases: [],
        }],
        groups: [{ stableKey: 'regional', label: 'Regional', targetKeys: ['market-target'], competitors: ['kestrel.example'] }],
        targetQuerySelections: [{ targetKey: 'market-target', queryIds: ['market-query'] }],
      },
    },
  })
  expect(published.statusCode, published.body).toBe(201)
  expect(storedAutoNames('alpha.example')).toEqual([])
  expect(auditDiff('measurement-plan.published')).toMatchObject({
    droppedAutoAliases: [{ domain: 'alpha.example', alias: 'Kestrel', reason: 'other-competitor', stored: true, conflictsWith: 'kestrel.example' }],
  })
  expect(namesChanged).toEqual(['rotorwise'])
})

describe('a market pin that claims a name learned for a competitor only a market pins', () => {
  // gearloft.example is pinned in "regional" without a competitors row and
  // learned "LoftGear" from that market's answers.
  beforeEach(() => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    db.insert(marketCompetitorNames).values({
      id: 'gearloft_names', projectId, domain: 'gearloft.example', autoAliases: [learned('LoftGear')], blockedAliases: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
  })

  it('refreshes the stored columns when a draft pin claims the name, and again when the draft is discarded', async () => {
    expect(storedOverlap()).toEqual(['gearloft.example'])
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map([['gearloft.example', ['LoftGear']]]))

    const pinned = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'qvx.example', label: 'LoftGear' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
    expect(namesChanged).toEqual(['rotorwise'])
    expect(storedOverlap()).toEqual([])
    expect(staleRows()).toBe(0)
    // One credit in the landscape, the pending pin's.
    const drafted = await marketLandscape()
    expect(drafted.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(drafted.evidence.mentionCredits).toBe(2)

    const discarded = await draftAction('discard', {}, pinned.json().etag)
    expect(discarded.statusCode, discarded.body).toBe(200)
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map([['gearloft.example', ['LoftGear']]]))
    expect(namesChanged).toEqual(['rotorwise', 'rotorwise'])
    expect(rescans).toEqual(['rotorwise', 'rotorwise'])
    expect(storedOverlap()).toEqual(['gearloft.example'])
    expect(staleRows()).toBe(0)
  })

  it('refreshes the stored columns when deactivating the plan releases the name', async () => {
    // Revision 2, now active and measured by nothing, pins qvx.example as
    // "LoftGear": the old answer no longer credits gearloft.example.
    const plan = marketPlan([{ domain: 'qvx.example', label: 'LoftGear', aliases: [] }])
    db.insert(measurementPlanVersions).values({
      id: 'plan_v2', projectId, revision: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '2'.repeat(64),
      schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW,
    }).run()
    db.update(measurementPlans).set({ activeVersionId: 'plan_v2' }).where(eq(measurementPlans.projectId, projectId)).run()
    backfillProjectAnswerMentions(db, projectId, { competitorFieldsOnly: true })
    expect(storedOverlap()).toEqual([])

    const deactivated = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/measurement-plan/actions/deactivate',
      headers: { 'idempotency-key': 'deactivate-1' },
      payload: { expectedActiveRevision: 2 },
    })
    expect(deactivated.statusCode, deactivated.body).toBe(200)
    expect(namesChanged).toEqual(['rotorwise'])
    expect(storedOverlap()).toEqual(['gearloft.example'])
    expect(staleRows()).toBe(0)
  })
})
