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
  discoverySessions,
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
  AppError,
  canonicalMeasurementPlanV2Json,
  competitorLandscapeResponseSchema,
  measurementPlanV2Schema,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { requireMarketPinsClearOfCompetitorAliases } from '../src/competitor-writes.js'
import { readMarketCompetitorPins, type MarketPinGroup } from '../src/plan-competitors.js'

// A curated alias of a tracked competitor must stay clear of the competitors
// an Advanced market pins. An Advanced read counts the project's tracked
// competitors and the market's pins together, so an alias equal to (or
// overlapping) a pin's name credits one answer to two rivals.

const NOW = '2026-10-01T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let competitorAliasHooks: string[]
let projectId: string

const PROJECT = {
  displayName: 'Rotorwise',
  canonicalDomain: 'rotorwise.example',
  aliases: ['Rotorwise Pros'],
  country: 'US',
  language: 'en',
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-competitor-alias-pins-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  competitorAliasHooks = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onCompetitorAliasesChanged: (_id, name) => competitorAliasHooks.push(name),
  })
  await app.ready()

  const created = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise', payload: PROJECT })
  expect(created.statusCode, created.body).toBe(201)
  projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
  db.insert(queries).values({ id: 'market-query', projectId, query: 'rotor repair near me', createdAt: NOW }).run()
  const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['alpha.example'] } })
  expect(added.statusCode, added.body).toBe(200)
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A v2 plan whose one market (`regional`) pins `pins`. */
function marketPlan(pins: Array<{ domain: string; label: string; aliases: string[] }>) {
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

/** Publish `plan` as revision 1 and store one answer the market measured. */
function seedMarket(plan: ReturnType<typeof marketPlan>, answerText: string) {
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

async function marketLandscape() {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/rotorwise/analytics/competitors?window=all&groupKey=regional&queryClass=non-brand',
  })
  expect(res.statusCode, res.body).toBe(200)
  return competitorLandscapeResponseSchema.parse(res.json())
}

function setAliases(domain: string, aliases: unknown) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/projects/rotorwise/competitors/${encodeURIComponent(domain)}/aliases`,
    payload: { aliases },
  })
}

function storedAliases(): Record<string, string[]> {
  return Object.fromEntries(db.select({ domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors).where(eq(competitors.projectId, projectId)).all()
    .map(row => [row.domain, row.aliases]))
}

function audits(action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all()
}

const BOLTLINE_PIN = { domain: 'boltline.example', label: 'Boltline', aliases: ['Boltline'] }

describe('a curated alias never names a competitor an Advanced market pins', () => {
  it('rejects an alias equal to a pin\'s name, so the market share keeps one credit per rival', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise and Boltline both repair rotors.')
    const before = await marketLandscape()
    // One answer: the project once, Boltline once, alpha.example never.
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(before.evidence.mentionCredits).toBe(2)

    const res = await setAliases('alpha.example', ['Boltline'])
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(res.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example',
      alias: 'Boltline',
      reason: 'market-competitor',
      conflictsWith: 'boltline.example',
      markets: ['regional'],
    }])
    expect(res.json().error.message).toBe(
      'Invalid competitor aliases: alpha.example: "Boltline" already identifies boltline.example, which Advanced market "regional" pins, so one answer would count both competitors',
    )

    expect(storedAliases()).toEqual({ 'alpha.example': [] })
    expect(audits('competitors.aliases-updated')).toHaveLength(0)
    expect(competitorAliasHooks).toEqual([])
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(after.evidence.mentionCredits).toBe(2)
    expect(after.pinned.map(row => [row.domain, row.mentionCount])).toEqual([['boltline.example', 1], ['alpha.example', 0]])
  })

  it('rejects an alias found inside a pin\'s name, and one containing the pin\'s domain label', async () => {
    seedMarket(marketPlan([{ domain: 'quillworks.example', label: 'Quill Rotor Co', aliases: [] }]), 'Rotorwise.')
    const inside = await setAliases('alpha.example', ['Quill Rotor'])
    expect(inside.statusCode).toBe(400)
    expect(inside.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example',
      alias: 'Quill Rotor',
      reason: 'market-competitor',
      conflictsWith: 'quillworks.example',
      conflictingName: 'Quill Rotor Co',
      markets: ['regional'],
    }])
    expect(inside.json().error.message).toBe(
      'Invalid competitor aliases: alpha.example: "Quill Rotor" is found inside "Quill Rotor Co", a name of quillworks.example, which Advanced market "regional" pins, so one answer would count both competitors',
    )
    const containing = await setAliases('alpha.example', ['QuillWorks Outlet'])
    expect(containing.statusCode).toBe(400)
    expect(containing.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example',
      alias: 'QuillWorks Outlet',
      reason: 'market-competitor',
      conflictsWith: 'quillworks.example',
      conflictingName: 'quillworks',
      markets: ['regional'],
    }])
    expect(storedAliases()).toEqual({ 'alpha.example': [] })
  })

  it('applies the rule on every writer that states aliases: POST add and apply', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise.')
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/competitors',
      payload: { competitors: [{ domain: 'gamma.example', aliases: ['Boltline'] }] },
    })
    expect(post.statusCode).toBe(400)
    expect(post.json().error.details.rejectedAliases).toEqual([{
      domain: 'gamma.example', alias: 'Boltline', reason: 'market-competitor', conflictsWith: 'boltline.example', markets: ['regional'],
    }])

    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { ...PROJECT, competitors: [{ domain: 'alpha.example', aliases: ['Boltline'] }] },
      },
    })
    expect(apply.statusCode).toBe(400)
    expect(apply.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example', alias: 'Boltline', reason: 'market-competitor', conflictsWith: 'boltline.example', markets: ['regional'],
    }])
    expect(storedAliases()).toEqual({ 'alpha.example': [] })
    expect(competitorAliasHooks).toEqual([])
  })

  it('checks the pending draft\'s pins as well as the published ones', async () => {
    seedMarket(marketPlan([]), 'Rotorwise.')
    const pin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'draft-pin' },
      payload: { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyrblade.example', label: 'Zephyr Blade' },
    })
    expect(pin.statusCode, pin.body).toBe(200)

    const res = await setAliases('alpha.example', ['Zephyr Blade'])
    expect(res.statusCode).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example', alias: 'Zephyr Blade', reason: 'market-competitor', conflictsWith: 'zephyrblade.example', markets: ['regional'],
    }])
  })

  it('accepts the pin\'s names on the tracked competitor that is the same domain', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise.')
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['offers.boltline.example'] } })
    const res = await setAliases('boltline.example', ['Boltline', 'Bolt Line Rotors'])
    expect(res.statusCode, res.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': [], 'boltline.example': ['Boltline', 'Bolt Line Rotors'] })
  })

  it('drops a stored alias that already names a pin on the next competitor write, and audits it', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise and Boltline both repair rotors.')
    // Written before the rule existed.
    db.update(competitors).set({ aliases: ['Boltline', 'Alpha Rotors'] }).where(eq(competitors.domain, 'alpha.example')).run()
    expect((await marketLandscape()).project).toMatchObject({ mentionCount: 1, shareOfVoice: 33.333333 })

    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['gamma.example'] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': ['Alpha Rotors'], 'gamma.example': [] })
    expect(JSON.parse(audits('competitors.appended').at(-1)!.diff!)).toEqual({
      added: ['gamma.example'],
      aliasChanges: [{ domain: 'alpha.example', before: ['Boltline', 'Alpha Rotors'], after: ['Alpha Rotors'] }],
      droppedCompetitorAliases: [{
        domain: 'alpha.example', alias: 'Boltline', reason: 'market-competitor', conflictsWith: 'boltline.example', markets: ['regional'],
      }],
    })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
    expect((await marketLandscape()).project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
  })
})

describe('readMarketCompetitorPins', () => {
  it('reads the active revision\'s pins and the pending draft\'s, one per registrable domain', async () => {
    expect(readMarketCompetitorPins(db, projectId)).toEqual([])
    seedMarket(marketPlan([BOLTLINE_PIN, { domain: 'www.alpha.example', label: 'Alpha', aliases: [] }]), 'Rotorwise.')
    expect(readMarketCompetitorPins(db, projectId)).toEqual([
      { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] },
      { domain: 'alpha.example', names: ['Alpha'], markets: ['regional'] },
    ])
    const pin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'reader-pin' },
      payload: { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyrblade.example', label: 'Zephyr Blade' },
    })
    expect(pin.statusCode, pin.body).toBe(200)
    expect(readMarketCompetitorPins(db, projectId)).toEqual([
      { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] },
      { domain: 'alpha.example', names: ['Alpha'], markets: ['regional'] },
      { domain: 'zephyrblade.example', names: ['Zephyr Blade'], markets: ['regional'] },
    ])
    // An unreadable draft or revision pins nothing rather than failing competitor writes.
    const draftJson = db.select().from(measurementPlanDrafts).where(eq(measurementPlanDrafts.projectId, projectId)).get()!.authoringJson
    const setDraftJson = (authoringJson: string) => db.update(measurementPlanDrafts).set({ authoringJson }).where(eq(measurementPlanDrafts.projectId, projectId)).run()
    setDraftJson('{not json')
    expect(readMarketCompetitorPins(db, projectId)).toEqual([
      { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] },
      { domain: 'alpha.example', names: ['Alpha'], markets: ['regional'] },
    ])
    setDraftJson(draftJson)
    // A published revision never changes (its parse is cached), so the
    // unreadable one is a new active revision. Revision 1's run loses its
    // answer, so revision 1 no longer counts as a superseded revision.
    db.delete(querySnapshots).where(eq(querySnapshots.runId, 'market_run')).run()
    db.insert(measurementPlanVersions).values({
      id: 'plan_unreadable', projectId, revision: 2, canonicalJson: '{not json', checksum: '9'.repeat(64),
      schemaVersion: 2, compiledChecksum: 'b'.repeat(64), createdAt: NOW,
    }).run()
    db.update(measurementPlans).set({ activeVersionId: 'plan_unreadable' }).where(eq(measurementPlans.projectId, projectId)).run()
    expect(readMarketCompetitorPins(db, projectId)).toEqual([
      { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] },
      { domain: 'alpha.example', names: ['Alpha'], markets: ['regional'] },
      { domain: 'zephyrblade.example', names: ['Zephyr Blade'], markets: ['regional'] },
    ])
    setDraftJson('{not json')
    expect(readMarketCompetitorPins(db, projectId)).toEqual([])
  })
})

describe('readMarketCompetitorPins parses each published revision once', () => {
  it('reuses a revision\'s parse on every later read, and re-reads a draft only when its text changes', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise.')
    const boltline = { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] }
    expect(readMarketCompetitorPins(db, projectId)).toEqual([boltline])

    const pin = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyrblade.example', label: 'Zephyr Blade' })
    expect(pin.statusCode, pin.body).toBe(200)
    expect(readMarketCompetitorPins(db, projectId)).toEqual([boltline, { domain: 'zephyrblade.example', names: ['Zephyr Blade'], markets: ['regional'] }])
    // The draft changes in place: new text is parsed again.
    const draftJson = storedDraft()!.authoringJson
    db.update(measurementPlanDrafts).set({ authoringJson: draftJson.replaceAll('Zephyr Blade', 'Zephyr Blades') }).where(eq(measurementPlanDrafts.projectId, projectId)).run()
    const renamed = [boltline, { domain: 'zephyrblade.example', names: ['Zephyr Blades'], markets: ['regional'] }]
    expect(readMarketCompetitorPins(db, projectId)).toEqual(renamed)

    // A published revision never changes: were it parsed again, this text
    // would pin nothing. The parse from the first read is used instead.
    db.update(measurementPlanVersions).set({ canonicalJson: '{not json' }).where(eq(measurementPlanVersions.id, 'plan_v1')).run()
    expect(readMarketCompetitorPins(db, projectId)).toEqual(renamed)
  })
})

describe('a market pin never answers to a tracked competitor\'s curated alias', () => {
  const NONE: MarketPinGroup[] = [{ stableKey: 'regional', competitors: [] }]
  const BOLTLINE_PINNED: MarketPinGroup[] = [{ stableKey: 'regional', competitors: [{ domain: 'boltline.example', label: 'boltline', aliases: [] }] }]

  function pinError(before: readonly MarketPinGroup[], after: readonly MarketPinGroup[]): AppError | null {
    try {
      requireMarketPinsClearOfCompetitorAliases(db, projectId, before, after)
      return null
    } catch (error) {
      if (error instanceof AppError) return error
      throw error
    }
  }

  it('fails a write that adds a pin a curated alias already names', async () => {
    expect((await setAliases('alpha.example', ['Boltline'])).statusCode).toBe(200)
    const error = pinError(NONE, BOLTLINE_PINNED)
    expect(error?.statusCode).toBe(400)
    expect(error?.code).toBe('VALIDATION_ERROR')
    expect(error?.message).toBe(
      'Invalid market competitor pins: boltline.example cannot be added while "Boltline" is a curated alias of alpha.example; remove or restate that alias first',
    )
    expect(error?.details).toEqual({
      rejectedAliases: [{ domain: 'boltline.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example' }],
    })
    // A v1 plan pins bare hosts: the domain label still claims the alias.
    expect(pinError(NONE, [{ stableKey: 'regional', competitors: ['https://www.boltline.example/'] }])?.details).toEqual({
      rejectedAliases: [{ domain: 'boltline.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example' }],
    })
  })

  it('fails a rename into the alias and the same pin added to another market', async () => {
    expect((await setAliases('alpha.example', ['Boltline'])).statusCode).toBe(200)
    const zephyr = (aliases: string[]): MarketPinGroup[] => [{ stableKey: 'regional', competitors: [{ domain: 'zephyr.example', label: 'Zephyr', aliases }] }]
    expect(pinError(zephyr([]), zephyr([]))).toBeNull()
    expect(pinError(zephyr([]), zephyr(['Boltline Rotors']))?.message).toBe(
      'Invalid market competitor pins: zephyr.example cannot be pinned by that name while "Boltline" is a curated alias of alpha.example (it is found inside "Boltline Rotors", a name of zephyr.example, so one answer would count both competitors); remove or restate that alias first',
    )
    // An overlap stored before the rule never blocks a write that leaves the pin alone,
    // or one that only gives it a name no alias overlaps...
    expect(pinError(BOLTLINE_PINNED, BOLTLINE_PINNED)).toBeNull()
    expect(pinError(BOLTLINE_PINNED, [{ stableKey: 'regional', competitors: [{ domain: 'boltline.example', label: 'boltline', aliases: ['Bolt Works'] }] }])).toBeNull()
    // ...but pinning it in a market that did not have it is a new pin there.
    expect(pinError(BOLTLINE_PINNED, [...BOLTLINE_PINNED, { stableKey: 'east', competitors: BOLTLINE_PINNED[0]!.competitors }])?.details).toEqual({
      rejectedAliases: [{ domain: 'boltline.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example' }],
    })
  })

  it('accepts a pin of the tracked competitor itself and a pin no alias names', async () => {
    expect((await setAliases('alpha.example', ['Alpha Rotors'])).statusCode).toBe(200)
    expect(pinError(NONE, [{ stableKey: 'regional', competitors: [{ domain: 'offers.alpha.example', label: 'Alpha Rotors', aliases: ['Alpha Rotors'] }] }])).toBeNull()
    expect(pinError(NONE, BOLTLINE_PINNED)).toBeNull()
  })
})

let idempotencyCounter = 0

function draftAction(action: string, payload: unknown, ifMatch?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/rotorwise/measurement-plan/draft/actions/${action}`,
    headers: { 'idempotency-key': `${action}-${++idempotencyCounter}`, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
    payload,
  })
}

function storedDraft() {
  return db.select({ authoringJson: measurementPlanDrafts.authoringJson, etagVersion: measurementPlanDrafts.etagVersion })
    .from(measurementPlanDrafts).where(eq(measurementPlanDrafts.projectId, projectId)).get() ?? null
}

/** A legacy v1 plan whose one market (`regional`) pins `hosts`. */
function v1Plan(hosts: string[]) {
  return {
    schemaVersion: 1,
    targets: [{
      stableKey: 'market-target',
      label: 'Market Target',
      urls: [{ kind: 'prefix', host: 'rotorwise.example', pathPrefix: '/', pathCase: 'insensitive' }],
      aliases: [],
    }],
    groups: [{ stableKey: 'regional', label: 'Regional', targetKeys: ['market-target'], competitors: hosts }],
    targetQuerySelections: [{ targetKey: 'market-target', queryIds: ['market-query'] }],
  }
}

describe('every market pin writer refuses a pin that answers to a curated alias', () => {
  const BOLTLINE_CLAIM = { domain: 'boltline.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example' }

  it('refuses the Advanced pin after the alias, so the market keeps one credit per rival', async () => {
    seedMarket(marketPlan([]), 'Rotorwise and Boltline both repair rotors.')
    expect((await setAliases('alpha.example', ['Boltline'])).statusCode).toBe(200)
    const before = await marketLandscape()
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(before.evidence.mentionCredits).toBe(2)

    const pin = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'boltline.example', label: 'Boltline' })
    expect(pin.statusCode, pin.body).toBe(400)
    expect(pin.json().error.code).toBe('VALIDATION_ERROR')
    expect(pin.json().error.details).toEqual({ rejectedAliases: [BOLTLINE_CLAIM] })
    expect(pin.json().error.message).toBe(
      'Invalid market competitor pins: boltline.example cannot be added while "Boltline" is a curated alias of alpha.example; remove or restate that alias first',
    )
    expect(storedDraft()).toBeNull()
    expect(audits('measurement-draft.pin-competitor')).toHaveLength(0)
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(after.evidence.mentionCredits).toBe(2)
  })

  it('refuses a new pin and a new pin name on an existing draft, leaving the draft as it was', async () => {
    seedMarket(marketPlan([]), 'Rotorwise.')
    expect((await setAliases('alpha.example', ['Boltline'])).statusCode).toBe(200)
    const zephyr = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyr.example', label: 'Zephyr' })
    expect(zephyr.statusCode, zephyr.body).toBe(200)
    const draft = storedDraft()

    const added = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'boltline.example', label: 'Boltline' })
    expect(added.statusCode, added.body).toBe(400)
    expect(added.json().error.details).toEqual({ rejectedAliases: [BOLTLINE_CLAIM] })
    const renamed = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyr.example', label: 'Boltline Rotors' })
    expect(renamed.statusCode, renamed.body).toBe(400)
    expect(renamed.json().error.details).toEqual({
      rejectedAliases: [{ domain: 'zephyr.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example', conflictingName: 'Boltline Rotors' }],
    })
    expect(renamed.json().error.message).toBe(
      'Invalid market competitor pins: zephyr.example cannot be pinned by that name while "Boltline" is a curated alias of alpha.example (it is found inside "Boltline Rotors", a name of zephyr.example, so one answer would count both competitors); remove or restate that alias first',
    )
    expect(storedDraft()).toEqual(draft)
  })

  it('refuses a draft competitor or group upsert that adds such a pin, and passes an edit that keeps the pins', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise.')
    // Written before the rule existed.
    db.update(competitors).set({ aliases: ['Boltline'] }).where(eq(competitors.domain, 'alpha.example')).run()
    const created = await draftAction('create', { expectedActiveRevision: 1 })
    expect(created.statusCode, created.body).toBe(200)
    // The old overlap never blocks an edit that leaves the pin alone.
    const relabelled = await draftAction('upsert-group', { group: { stableKey: 'regional', label: 'Regional West', targetKeys: ['market-target'] } }, created.json().etag)
    expect(relabelled.statusCode, relabelled.body).toBe(200)
    const etag = relabelled.json().etag
    const draft = storedDraft()

    const competitor = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-quill', label: 'Boltline Quill', domain: 'quill.example', aliases: [] },
    }, etag)
    expect(competitor.statusCode, competitor.body).toBe(400)
    expect(competitor.json().error.details).toEqual({
      rejectedAliases: [{ domain: 'quill.example', alias: 'Boltline', reason: 'claimed-by-alias', conflictsWith: 'alpha.example', conflictingName: 'Boltline Quill' }],
    })
    const group = await draftAction('upsert-group', {
      group: { stableKey: 'east', label: 'East', targetKeys: ['market-target'], competitors: [{ stableKey: 'competitor-boltline', ...BOLTLINE_PIN }] },
    }, etag)
    expect(group.statusCode, group.body).toBe(400)
    expect(group.json().error.details).toEqual({ rejectedAliases: [BOLTLINE_CLAIM] })
    expect(storedDraft()).toEqual(draft)
  })

  it('refuses a legacy v1 publish that pins such a competitor by host', async () => {
    expect((await setAliases('alpha.example', ['Boltline'])).statusCode).toBe(200)
    const publish = (hosts: string[]) => app.inject({
      method: 'PUT',
      url: '/api/v1/projects/rotorwise/measurement-plan',
      payload: { expectedActiveRevision: null, plan: v1Plan(hosts) },
    })
    const refused = await publish(['https://www.boltline.example/'])
    expect(refused.statusCode, refused.body).toBe(400)
    expect(refused.json().error.details).toEqual({ rejectedAliases: [BOLTLINE_CLAIM] })
    expect(db.select().from(measurementPlanVersions).all()).toEqual([])
    expect((await publish(['zephyr.example'])).statusCode).toBe(201)
  })
})

describe('apply and project PUT plan with the market pins before their transaction', () => {
  it('apply reports a stated alias that names a pin ahead of its other validation', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise.')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { ...PROJECT, qualifiedAliases: ['Rotorwise Repair'], competitors: [{ domain: 'alpha.example', aliases: ['Boltline'] }] },
      },
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.message).toBe(
      'Invalid competitor aliases: alpha.example: "Boltline" already identifies boltline.example, which Advanced market "regional" pins, so one answer would count both competitors',
    )
    expect(res.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example', alias: 'Boltline', reason: 'market-competitor', conflictsWith: 'boltline.example', markets: ['regional'],
    }])
    expect(storedAliases()).toEqual({ 'alpha.example': [] })
  })

  it('a project PUT that changes only unrelated identity drops a stored alias a pin names, audited, as its transaction does', async () => {
    seedMarket(marketPlan([BOLTLINE_PIN]), 'Rotorwise and Boltline both repair rotors.')
    // Written before the rule existed.
    db.update(competitors).set({ aliases: ['Boltline', 'Alpha Rotors'] }).where(eq(competitors.domain, 'alpha.example')).run()
    expect((await marketLandscape()).project).toMatchObject({ mentionCount: 1, shareOfVoice: 33.333333 })

    const res = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise', payload: { ...PROJECT, ownedDomains: ['rotorwise-repair.example'] } })
    expect(res.statusCode, res.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': ['Alpha Rotors'] })
    expect(JSON.parse(audits('project.updated').at(-1)!.diff!)).toEqual({
      droppedCompetitorAliases: [{
        domain: 'alpha.example', alias: 'Boltline', reason: 'market-competitor', conflictsWith: 'boltline.example', markets: ['regional'],
      }],
    })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
    expect((await marketLandscape()).project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
  })
})

const TUNESPOKE_PIN = { domain: 'spoketuneworks.example', label: 'TuneSpoke', aliases: ['TuneSpoke'] }

describe('a new competitor never answers to a name a market pin goes by', () => {
  const TUNESPOKE_CLAIM = {
    domain: 'tunespoke.example',
    alias: 'TuneSpoke',
    reason: 'claimed-by-alias',
    conflictsWith: 'spoketuneworks.example',
    markets: ['regional'],
  }

  it('refuses the domain on add, replace and apply, so the market keeps one credit per rival', async () => {
    seedMarket(marketPlan([TUNESPOKE_PIN]), 'Rotorwise and TuneSpoke both repair rotors.')
    const before = await marketLandscape()
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(before.evidence.mentionCredits).toBe(2)

    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(added.statusCode, added.body).toBe(400)
    expect(added.json().error.details.rejectedAliases).toEqual([TUNESPOKE_CLAIM])
    expect(added.json().error.message).toBe(
      'Invalid competitor aliases: tunespoke.example: cannot be added while "TuneSpoke" is a name of spoketuneworks.example, which Advanced market "regional" pins, so one answer would count both competitors; remove that name from the market pin first',
    )
    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['alpha.example', 'tunespoke.example'] } })
    expect(replaced.statusCode, replaced.body).toBe(400)
    expect(replaced.json().error.details.rejectedAliases).toEqual([TUNESPOKE_CLAIM])
    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { ...PROJECT, competitors: ['alpha.example', 'tunespoke.example'] },
      },
    })
    expect(applied.statusCode, applied.body).toBe(400)
    expect(applied.json().error.details.rejectedAliases).toEqual([TUNESPOKE_CLAIM])

    expect(storedAliases()).toEqual({ 'alpha.example': [] })
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(after.evidence.mentionCredits).toBe(2)
  })

  it('leaves the domain out of a discovery promote and its preview, and promotes the rest', async () => {
    seedMarket(marketPlan([TUNESPOKE_PIN]), 'Rotorwise.')
    db.insert(discoverySessions).values({
      id: 'session_pins',
      projectId,
      status: 'completed',
      competitorMap: [
        { domain: 'tunespoke.example', hits: 2, competitorType: 'direct-competitor' },
        { domain: 'gearbarn.example', hits: 2, competitorType: 'direct-competitor' },
      ],
      createdAt: NOW,
    }).run()
    const skipped = [['tunespoke.example', 'claimed-by-alias']]

    const preview = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/discover/sessions/session_pins/promote' })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().suggestedCompetitors.map((entry: { domain: string }) => entry.domain)).toEqual(['gearbarn.example'])
    expect(preview.json().skippedCompetitors.map((entry: { domain: string; reason: string }) => [entry.domain, entry.reason])).toEqual(skipped)

    const promoted = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/discover/sessions/session_pins/promote', payload: {} })
    expect(promoted.statusCode, promoted.body).toBe(200)
    expect(promoted.json().promoted.competitors).toEqual(['gearbarn.example'])
    expect(promoted.json().competitorDetails.skipped.map((entry: { domain: string; reason: string }) => [entry.domain, entry.reason])).toEqual(skipped)
    expect(storedAliases()).toEqual({ 'alpha.example': [], 'gearbarn.example': [] })
  })

  it('compares only the pin\'s curated names with a new domain, never its own domain name', async () => {
    // The pin's generated label is its domain label, and two domains are never compared.
    seedMarket(marketPlan([{ domain: 'tunespokeworks.example', label: 'tunespokeworks', aliases: [] }]), 'Rotorwise.')
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(added.statusCode, added.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': [], 'tunespoke.example': [] })
  })
})

describe('a market pin is never named after a tracked competitor', () => {
  const ALPHA_NAME = { domain: 'zephyr.example', alias: 'Alpha', reason: 'other-competitor', conflictsWith: 'alpha.example' }

  it('refuses a pin whose label is a tracked competitor\'s domain label, so the market keeps one credit per rival', async () => {
    seedMarket(marketPlan([]), 'Rotorwise and Alpha both repair rotors.')
    const before = await marketLandscape()
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })

    const pin = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyr.example', label: 'Alpha' })
    expect(pin.statusCode, pin.body).toBe(400)
    expect(pin.json().error.details).toEqual({ rejectedAliases: [ALPHA_NAME] })
    expect(pin.json().error.message).toBe(
      'Invalid market competitor pins: zephyr.example cannot be added: "Alpha" already identifies the tracked competitor alpha.example, so one answer would count both competitors; pin it by another name',
    )
    expect(storedDraft()).toBeNull()

    const zephyr = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyr.example', label: 'Zephyr' })
    expect(zephyr.statusCode, zephyr.body).toBe(200)
    const draft = storedDraft()
    const renamed = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { ...zephyr.json().competitor, aliases: ['Alpha Rotor Works'] },
    }, zephyr.json().etag)
    expect(renamed.statusCode, renamed.body).toBe(400)
    expect(renamed.json().error.message).toBe(
      'Invalid market competitor pins: zephyr.example cannot be pinned by that name: "Alpha Rotor Works" contains "alpha", a name of the tracked competitor alpha.example, so one answer would count both competitors; pin it by another name',
    )
    expect(storedDraft()).toEqual(draft)
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
  })
})

describe('a draft publish checks the pins it adds or renames', () => {
  async function publishDraft(etag: string) {
    const preview = await draftAction('compile-preview', {})
    expect(preview.json().ok, preview.body).toBe(true)
    return draftAction('publish', { expectedActiveRevision: 1, expectedCompiledChecksum: preview.json().compiledChecksum }, etag)
  }

  function activeVersionId(): string {
    return db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()!.activeVersionId
  }

  it('refuses a draft pin that a tracked alias stored by an older build overlaps', async () => {
    seedMarket(marketPlan([]), 'Rotorwise.')
    const pinned = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'zephyr.example', label: 'Zephyr Blade' })
    expect(pinned.statusCode, pinned.body).toBe(200)
    // Written before the rule existed.
    db.update(competitors).set({ aliases: ['Zephyr Blade'] }).where(eq(competitors.domain, 'alpha.example')).run()

    const published = await publishDraft(pinned.json().etag)
    expect(published.statusCode, published.body).toBe(400)
    expect(published.json().error.details).toEqual({
      rejectedAliases: [{ domain: 'zephyr.example', alias: 'Zephyr Blade', reason: 'claimed-by-alias', conflictsWith: 'alpha.example' }],
    })
    expect(activeVersionId()).toBe('plan_v1')
    expect(storedDraft()).not.toBeNull()
  })

  it('publishes an unrelated pin while a published pin already overlaps a tracked competitor', async () => {
    seedMarket(marketPlan([TUNESPOKE_PIN]), 'Rotorwise.')
    // Tracked before the rule existed, next to the published pin "TuneSpoke".
    db.insert(competitors).values({ id: 'tracked_tunespoke', projectId, domain: 'tunespoke.example', provenance: 'cli', createdAt: NOW }).run()
    const pinned = await draftAction('pin-competitor', { expectedActiveRevision: 1, groupKey: 'regional', domain: 'gearbarn.example', label: 'Gearbarn' })
    expect(pinned.statusCode, pinned.body).toBe(200)

    const published = await publishDraft(pinned.json().etag)
    expect(published.statusCode, published.body).toBe(200)
    expect(published.json().active.revision).toBe(2)
    expect(activeVersionId()).not.toBe('plan_v1')
  })
})

describe('a superseded revision keeps scoring the runs measured under it', () => {
  // Revision 1 (with the run) pins "TuneSpoke". Revision 2 pins "Gearloft"
  // and measured nothing. Revision 3, now active, pins nobody.
  function publishRevision(id: string, revision: number, plan: ReturnType<typeof marketPlan>) {
    db.insert(measurementPlanVersions).values({
      id,
      projectId,
      revision,
      canonicalJson: canonicalMeasurementPlanV2Json(plan),
      checksum: String(revision).repeat(64),
      schemaVersion: 2,
      compiledChecksum: plan.compiledChecksum,
      createdAt: NOW,
    }).run()
    db.update(measurementPlans).set({ activeVersionId: id }).where(eq(measurementPlans.projectId, projectId)).run()
  }

  beforeEach(() => {
    seedMarket(marketPlan([TUNESPOKE_PIN]), 'Rotorwise and TuneSpoke both repair rotors.')
    publishRevision('plan_v2', 2, marketPlan([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }]))
    publishRevision('plan_v3', 3, marketPlan([]))
  })

  it('refuses an alias its old answers would credit twice, so the share stays put, and allows one no run used', async () => {
    // Revision 3 no longer pins spoketuneworks.example, so the old answer
    // credits the project alone.
    const before = await marketLandscape()
    expect(before.project).toMatchObject({ mentionCount: 1, shareOfVoice: 100 })
    expect(before.pinned.map(row => [row.domain, row.mentionCount])).toEqual([['alpha.example', 0]])

    const res = await setAliases('alpha.example', ['TuneSpoke'])
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example',
      alias: 'TuneSpoke',
      reason: 'market-competitor',
      conflictsWith: 'spoketuneworks.example',
      markets: ['regional'],
      supersededRevision: 1,
    }])
    expect(res.json().error.message).toBe(
      'Invalid competitor aliases: alpha.example: "TuneSpoke" already identifies spoketuneworks.example, which Advanced market "regional" pinned in revision 1, whose runs still score with it, so one answer would count both competitors',
    )
    expect(storedAliases()).toEqual({ 'alpha.example': [] })
    const after = await marketLandscape()
    expect(after.project).toMatchObject({ mentionCount: 1, shareOfVoice: 100 })
    expect(after.pinned.map(row => [row.domain, row.mentionCount])).toEqual([['alpha.example', 0]])

    // Revision 2 measured nothing, so nothing is scored with its pin.
    const unscored = await setAliases('alpha.example', ['Gearloft'])
    expect(unscored.statusCode, unscored.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': ['Gearloft'] })
  })

  function measureRevision2(id: string, status: 'failed' | 'cancelled' | 'running' | 'queued') {
    db.insert(runs).values({
      id, projectId, kind: 'answer-visibility', status, trigger: 'manual', measurementPlanVersionId: 'plan_v2', createdAt: NOW,
    }).run()
  }

  it('ignores a superseded revision whose runs ended without storing an answer', async () => {
    // Nothing was scored with revision 2's pin, so nothing can count twice.
    measureRevision2('failed_run', 'failed')
    measureRevision2('cancelled_run', 'cancelled')
    expect(readMarketCompetitorPins(db, projectId).map(pin => [pin.domain, pin.supersededRevision])).toEqual([
      ['spoketuneworks.example', 1],
    ])

    const res = await setAliases('alpha.example', ['Gearloft'])
    expect(res.statusCode, res.body).toBe(200)
    expect(storedAliases()).toEqual({ 'alpha.example': ['Gearloft'] })
  })

  it('still counts a superseded revision whose run has not finished, since its answers will score with it', async () => {
    measureRevision2('running_run', 'running')

    const res = await setAliases('alpha.example', ['Gearloft'])
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([{
      domain: 'alpha.example',
      alias: 'Gearloft',
      reason: 'market-competitor',
      conflictsWith: 'gearloft.example',
      markets: ['regional'],
      supersededRevision: 2,
    }])
    expect(storedAliases()).toEqual({ 'alpha.example': [] })
  })

  it('refuses a new domain the old pin\'s name claims, and says the old runs are why', async () => {
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(added.statusCode, added.body).toBe(400)
    expect(added.json().error.details.rejectedAliases).toEqual([{
      domain: 'tunespoke.example',
      alias: 'TuneSpoke',
      reason: 'claimed-by-alias',
      conflictsWith: 'spoketuneworks.example',
      markets: ['regional'],
      supersededRevision: 1,
    }])
    expect(added.json().error.message).toBe(
      'Invalid competitor aliases: tunespoke.example: cannot be added while "TuneSpoke" is a name of spoketuneworks.example, which Advanced market "regional" pinned in revision 1, whose runs still score with it, so one answer would count both competitors',
    )
  })
})
