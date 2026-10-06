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
    // An unreadable draft pins nothing rather than failing competitor writes.
    db.update(measurementPlanDrafts).set({ authoringJson: '{not json' }).where(eq(measurementPlanDrafts.projectId, projectId)).run()
    expect(readMarketCompetitorPins(db, projectId)).toEqual([
      { domain: 'boltline.example', names: ['Boltline'], markets: ['regional'] },
      { domain: 'alpha.example', names: ['Alpha'], markets: ['regional'] },
    ])
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
      'Invalid market competitor pins: zephyr.example cannot be added while "Boltline" is a curated alias of alpha.example (it is found inside "Boltline Rotors", a name of zephyr.example, so one answer would count both competitors); remove or restate that alias first',
    )
    // An overlap stored before the rule never blocks a write that leaves the pin alone...
    expect(pinError(BOLTLINE_PINNED, BOLTLINE_PINNED)).toBeNull()
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
