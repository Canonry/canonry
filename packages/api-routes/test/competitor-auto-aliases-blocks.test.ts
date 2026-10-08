import crypto from 'node:crypto'
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
  measurementPlanDrafts,
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
  measurementPlanV2Schema,
  type CompetitorAutoAlias,
  type CompetitorAutoAliasDetectionDto,
} from '@ainyc/canonry-contracts'
import { apiRoutes, readMarketCompetitorNames } from '../src/index.js'

// Blocked names, plan pins and who asked for an apply. A block must hold:
// a name the operator blocked never comes back because the competitor's row
// was re-created, a learned name is never frozen into a plan pin where a block
// cannot reach it, and a learned name of a dropped pin can still be blocked.
// Fictional competitors and answers throughout.

const NOW = '2026-10-01T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string
let namesChanged: string[]
let rescans: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-auto-alias-blocks-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  namesChanged = []
  rescans = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onCompetitorAliasesChanged: (_id, name) => namesChanged.push(name),
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
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type Pin = { domain: string; label: string; aliases: string[] }

/** Publish revision 1, whose one market (`regional`) pins `pins`. */
function publishMarket(pins: Pin[]): void {
  const plan = measurementPlanV2Schema.parse({
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
}

function learned(name: string): CompetitorAutoAlias {
  return {
    name, directPairs: 3, cooccurrences: 3, namingAnswers: 3, precision: 1, lift: 8, nameCasedAnswers: 3, runs: 3,
    firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-03T00:00:00.000Z', addedAt: '2026-09-04T00:00:00.000Z',
  }
}

function track(domain: string, extra: Partial<typeof competitors.$inferInsert> = {}): void {
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, provenance: 'cli', createdAt: NOW, ...extra }).run()
}

function storeMarketNames(domain: string, names: { autoAliases?: CompetitorAutoAlias[]; blockedAliases?: string[] }): void {
  db.insert(marketCompetitorNames).values({
    id: crypto.randomUUID(), projectId, domain, autoAliases: names.autoAliases ?? [], blockedAliases: names.blockedAliases ?? [], createdAt: NOW, updatedAt: NOW,
  }).run()
}

/**
 * Three sweeps whose answers each pair "TuneSpoke" with spoketuneworks.example
 * in a named link, next to two answers that do neither: enough evidence for
 * detection to store the name.
 */
function seedTuneSpoke(): void {
  db.insert(queries).values({ id: 'tune-query', projectId, query: 'bike tune-up', createdAt: NOW }).run()
  for (const day of [1, 2, 3]) {
    const runId = crypto.randomUUID()
    const at = `2026-09-0${day}T00:00:00.000Z`
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at }).run()
    const answers = [
      { text: 'For tune-ups, book with [TuneSpoke](https://spoketuneworks.example/book) today.', cited: ['spoketuneworks.example'] },
      { text: 'Check your tire pressure before every ride.', cited: ['ridersguide.example'] },
      { text: 'Check your tire pressure before every ride.', cited: ['ridersguide.example'] },
    ]
    for (const answer of answers) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId: 'tune-query', provider: 'gemini', citationState: 'not-cited', answerMentioned: false,
        answerText: answer.text, citedDomains: answer.cited, createdAt: at,
      }).run()
    }
  }
}

let idempotencyCounter = 0
const pinCompetitor = (payload: Record<string, unknown>) => app.inject({
  method: 'POST',
  url: '/api/v1/projects/rotorwise/measurement-plan/draft/actions/pin-competitor',
  headers: { 'idempotency-key': `pin-${++idempotencyCounter}` },
  payload: { expectedActiveRevision: 1, groupKey: 'regional', ...payload },
})
/** The pending draft's pin of `domain` in the `regional` market. */
const draftPin = (domain: string) => {
  const draft = db.select().from(measurementPlanDrafts).where(eq(measurementPlanDrafts.projectId, projectId)).get()!
  const authoring = JSON.parse(draft.authoringJson) as { groups: { stableKey: string; competitors: { domain: string; label: string; aliases: string[] }[] }[] }
  return authoring.groups.find(group => group.stableKey === 'regional')!.competitors.find(competitor => competitor.domain === domain)!
}
const block = (domain: string, aliases: string[], action: 'block' | 'unblock' = 'block') =>
  app.inject({ method: 'POST', url: `/api/v1/projects/rotorwise/competitors/${domain}/aliases/${action}`, payload: { aliases } })
const addCompetitors = (domains: string[]) =>
  app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: domains } })
const removeCompetitors = (domains: string[]) =>
  app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: domains } })
const trackedRow = (domain: string) =>
  db.select().from(competitors).where(and(eq(competitors.projectId, projectId), eq(competitors.domain, domain))).get()
const marketRow = (domain: string) =>
  db.select().from(marketCompetitorNames).where(and(eq(marketCompetitorNames.projectId, projectId), eq(marketCompetitorNames.domain, domain))).get()
const audits = (action: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all()
const applyNow = async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitor-auto-aliases', headers: { 'user-agent': 'operator-console/1.0' } })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as CompetitorAutoAliasDetectionDto
}

describe('a new plan pin takes only curated names', () => {
  it('never copies a tracked competitor\'s auto-detected name into the pin', async () => {
    publishMarket([])
    track('alpharotor.example', { aliases: ['Alpha Rotor Co'], autoAliases: [learned('Alphawing')] })
    const pinned = await pinCompetitor({ domain: 'alpharotor.example' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    // A plan pin's names are frozen when it publishes: an auto name there
    // could never be blocked or expire again.
    expect(draftPin('alpharotor.example').aliases).toEqual(['Alpha Rotor Co'])
  })

  it('never copies the names learned for an untracked domain into the pin; readers still layer them', async () => {
    publishMarket([])
    // gearloft.example was pinned by an earlier revision and learned "LoftGear".
    storeMarketNames('gearloft.example', { autoAliases: [learned('LoftGear')] })
    const pinned = await pinCompetitor({ domain: 'gearloft.example', label: 'Gearloft' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(draftPin('gearloft.example').aliases).toEqual(['Gearloft'])
    expect(readMarketCompetitorNames(db, projectId).get('gearloft.example')).toEqual(['LoftGear'])
  })
})

describe('blocking a name the plan\'s own pin carries', () => {
  it('refuses a name of the active revision\'s pin of that competitor, naming the markets', async () => {
    publishMarket([{ domain: 'alpharotor.example', label: 'Alpha', aliases: ['Alphawing'] }])
    track('alpharotor.example', { autoAliases: [learned('Alphawing'), learned('Alpha Rotorworks')] })
    const refused = await block('alpharotor.example', ['Alphawing'])
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { domain: 'alpharotor.example', pinned: ['Alphawing'], marketKeys: ['regional'] },
    })
    expect(refused.json().error.message).toContain('measurement draft')
    expect(trackedRow('alpharotor.example')!.blockedAliases).toEqual([])
    // A name the pin does not carry blocks as before.
    const blocked = await block('alpharotor.example', ['Alpha Rotorworks'])
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({ autoAliases: [{ name: 'Alphawing' }], blockedAliases: ['Alpha Rotorworks'] })
  })

  it('refuses a name the pending draft gives that competitor\'s pin', async () => {
    publishMarket([])
    track('alpharotor.example', { autoAliases: [learned('Alphawing')] })
    const pinned = await pinCompetitor({ domain: 'alpharotor.example', label: 'Alpha', aliases: ['Alphawing'] })
    expect(pinned.statusCode, pinned.body).toBe(200)
    const refused = await block('alpharotor.example', ['alphawing'])
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.details).toMatchObject({ pinned: ['alphawing'], marketKeys: ['regional'] })
  })
})

describe('blocked names outlive the competitor row', () => {
  beforeEach(async () => {
    expect((await addCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect((await block('alpharotor.example', ['Alphawing'])).statusCode).toBe(200)
    rescans = []
  })

  it('a remove and re-add keeps the blocked names', async () => {
    expect((await removeCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')).toBeUndefined()
    expect(marketRow('alpharotor.example')).toMatchObject({ autoAliases: [], blockedAliases: ['Alphawing'] })
    // Nothing reads a row with no learned names as market names.
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())

    expect((await addCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')!.blockedAliases).toEqual(['Alphawing'])
    expect(rescans).toEqual(['rotorwise'])
  })

  it('a removal by row id keeps them too', async () => {
    const id = trackedRow('alpharotor.example')!.id
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/projects/rotorwise/competitors/${id}` })
    expect(removed.statusCode, removed.body).toBe(204)
    expect(marketRow('alpharotor.example')).toMatchObject({ blockedAliases: ['Alphawing'] })
    expect((await addCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')!.blockedAliases).toEqual(['Alphawing'])
  })

  it('a replacing write that drops and re-adds the domain keeps them', async () => {
    const replace = (domains: string[]) =>
      app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: domains } })
    expect((await replace(['rimdoctor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')).toBeUndefined()
    expect((await replace(['rimdoctor.example', 'alpharotor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')!.blockedAliases).toEqual(['Alphawing'])
    expect(trackedRow('rimdoctor.example')!.blockedAliases).toEqual([])
  })

  it('an unblock made while tracked is kept through a remove and re-add', async () => {
    expect((await removeCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect((await addCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect((await block('alpharotor.example', ['Alphawing'], 'unblock')).statusCode).toBe(200)
    expect((await removeCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect(marketRow('alpharotor.example')).toMatchObject({ blockedAliases: [] })
    expect((await addCompetitors(['alpharotor.example'])).statusCode).toBe(200)
    expect(trackedRow('alpharotor.example')!.blockedAliases).toEqual([])
  })
})

it('promoting a competitor only a market pinned keeps the names blocked for it', async () => {
  publishMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }])
  expect((await block('gearloft.example', ['Loft Junk'])).statusCode).toBe(200)
  expect(marketRow('gearloft.example')).toMatchObject({ blockedAliases: ['Loft Junk'] })
  expect((await addCompetitors(['gearloft.example'])).statusCode).toBe(200)
  expect(trackedRow('gearloft.example')!.blockedAliases).toEqual(['Loft Junk'])
})

it('detection never re-applies a blocked name after the competitor is removed and added again', async () => {
  seedTuneSpoke()
  expect((await addCompetitors(['spoketuneworks.example'])).statusCode).toBe(200)
  expect((await applyNow()).competitors[0]!.added).toEqual(['TuneSpoke'])
  expect((await block('spoketuneworks.example', ['TuneSpoke'])).statusCode).toBe(200)

  expect((await removeCompetitors(['spoketuneworks.example'])).statusCode).toBe(200)
  expect((await addCompetitors(['spoketuneworks.example'])).statusCode).toBe(200)
  // The add asks for a rescan; the rescan is this pass.
  const rescanned = await applyNow()
  expect(rescanned.competitors[0]).toMatchObject({ domain: 'spoketuneworks.example', autoAliases: [], blockedAliases: ['TuneSpoke'], added: [] })
  expect(trackedRow('spoketuneworks.example')!.autoAliases).toEqual([])
})

describe('a learned name of a pin a later revision dropped', () => {
  it('can still be blocked, which removes it from every reader', async () => {
    publishMarket([])
    storeMarketNames('gearloft.example', { autoAliases: [learned('LoftGear')] })
    expect(readMarketCompetitorNames(db, projectId).get('gearloft.example')).toEqual(['LoftGear'])

    const blocked = await block('gearloft.example', ['LoftGear'])
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({ domain: 'gearloft.example', marketKeys: [], autoAliases: [], blockedAliases: ['LoftGear'] })
    expect(marketRow('gearloft.example')).toMatchObject({ autoAliases: [], blockedAliases: ['LoftGear'] })
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
    expect(namesChanged).toEqual(['rotorwise'])
    expect(audits('competitors.aliases-blocked')).toHaveLength(1)

    const unblocked = await block('gearloft.example', ['LoftGear'], 'unblock')
    expect(unblocked.statusCode, unblocked.body).toBe(200)
    expect(unblocked.json()).toMatchObject({ blockedAliases: [] })
    expect(rescans).toEqual(['rotorwise'])
  })

  it('a domain with no stored names and no pin is still unknown', async () => {
    publishMarket([])
    expect((await block('nobody.example', ['Nobody'])).statusCode).toBe(404)
  })
})

describe('POST /competitor-auto-aliases audits who asked', () => {
  it('records the request beside the system pass row when names change, and nothing for a no-op', async () => {
    seedTuneSpoke()
    track('spoketuneworks.example')
    await applyNow()
    expect(audits('competitors.auto-aliases-updated').map(row => row.actor)).toEqual(['system'])
    const requested = audits('competitors.auto-aliases-apply-requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ actor: 'api', userAgent: 'operator-console/1.0' })
    expect(JSON.parse(requested[0]!.diff!)).toMatchObject({
      changes: [{ domain: 'spoketuneworks.example', added: ['TuneSpoke'], removed: [] }],
      scan: { runs: 3, snapshots: 9 },
    })

    await applyNow()
    expect(audits('competitors.auto-aliases-apply-requested')).toHaveLength(1)
  })

  it('records the request principal', async () => {
    await app.close()
    app = Fastify()
    app.addHook('onRequest', async (request) => {
      request.principal = { kind: 'api-key', id: 'key_ops', name: 'ops', scopes: ['*'], viaCookie: false }
    })
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
    seedTuneSpoke()
    track('spoketuneworks.example')
    await applyNow()
    expect(audits('competitors.auto-aliases-apply-requested')[0]).toMatchObject({ actor: 'api-key:key_ops', credentialId: 'key_ops' })
  })
})
