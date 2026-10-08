import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditLog,
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
import { apiRoutes, readMarketCompetitorNames } from '../src/index.js'
import { marketNameChanges } from '../src/market-competitor-names.js'

// `competitorIdentityChangedAt` must move whenever an Advanced market
// landscape is restated by a names change, not only when a tracked
// competitor's names change: a published revision that renames a pin the
// active revision already had (active pins reinterpret every stored answer of
// the market), and a write that claims or releases a name learned for a
// competitor only a market pins (`readMarketCompetitorNames`): a project
// update, an apply, a competitor route or a market pin write.

const NOW = '2026-10-01T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-identity-changed-markets-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
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

const gearloftMentions = async () => (await marketLandscape()).pinned.find(row => row.domain === 'gearloft.example')?.mentionCount

function latestAudit(action: string) {
  return db.select().from(auditLog)
    .where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.createdAt))
    .get()!
}

function revisionCreatedAt(revision: number) {
  return db.select({ createdAt: measurementPlanVersions.createdAt }).from(measurementPlanVersions)
    .where(and(eq(measurementPlanVersions.projectId, projectId), eq(measurementPlanVersions.revision, revision)))
    .get()!.createdAt
}

function putProject(aliases: string[]) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/projects/rotorwise',
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', aliases },
  })
}

function storeLearnedName() {
  db.insert(marketCompetitorNames).values({
    id: 'gearloft_names', projectId, domain: 'gearloft.example', autoAliases: [learned('LoftGear')], blockedAliases: [], createdAt: NOW, updatedAt: NOW,
  }).run()
}

describe('competitorIdentityChangedAt on an Advanced market', () => {
  it('moves when a published revision renames a pin the active revision already had', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    expect((await marketLandscape()).competitorIdentityChangedAt).toBeNull()
    expect(await gearloftMentions()).toBe(0)

    const created = await draftAction('create', { expectedActiveRevision: 1 })
    expect(created.statusCode, created.body).toBe(200)
    const upserted = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-gearloft.example', label: 'Gearloft', domain: 'gearloft.example', aliases: ['LoftGear'] },
    }, created.json().etag)
    expect(upserted.statusCode, upserted.body).toBe(200)
    // The draft edits a pin the active revision already has: the landscape
    // still reads the active pin, so nothing is restated yet.
    expect(await gearloftMentions()).toBe(0)
    expect((await marketLandscape()).competitorIdentityChangedAt).toBeNull()

    const published = await publishDraft(upserted.json().etag)
    expect(published.statusCode, published.body).toBe(200)
    expect(await gearloftMentions()).toBe(1)
    const renamedAt = revisionCreatedAt(2)
    expect((await marketLandscape()).competitorIdentityChangedAt).toBe(renamedAt)
    // The project-wide readers carry the same time.
    const metrics = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/metrics' })
    expect(metrics.statusCode, metrics.body).toBe(200)
    expect(metrics.json().competitorIdentityChangedAt).toBe(renamedAt)
  })

  it('stays null for a publish that only adds a pin, or that changes a label\'s casing', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    const created = await draftAction('create', { expectedActiveRevision: 1 })
    const recased = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-gearloft.example', label: 'GearLoft', domain: 'gearloft.example', aliases: [] },
    }, created.json().etag)
    expect(recased.statusCode, recased.body).toBe(200)
    const added = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-kestrel', label: 'Kestrel', domain: 'kestrelrotor.example', aliases: [] },
    }, recased.json().etag)
    expect(added.statusCode, added.body).toBe(200)
    const published = await publishDraft(added.json().etag)
    expect(published.statusCode, published.body).toBe(200)
    expect(revisionCreatedAt(2)).toBeTruthy()
    expect((await marketLandscape()).competitorIdentityChangedAt).toBeNull()
  })

  it('moves when a project edit claims, and again when it releases, a market-only competitor\'s learned name', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    storeLearnedName()
    expect(await gearloftMentions()).toBe(1)
    expect((await marketLandscape()).competitorIdentityChangedAt).toBeNull()

    // An edit that touches no competitor name records none.
    expect((await putProject(['Rotor Wise'])).statusCode).toBe(200)
    expect(latestAudit('project.updated').diff).toBeNull()
    expect((await marketLandscape()).competitorIdentityChangedAt).toBeNull()

    const claimed = await putProject(['LoftGear'])
    expect(claimed.statusCode, claimed.body).toBe(200)
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
    expect(await gearloftMentions()).toBe(0)
    const claimedAudit = latestAudit('project.updated')
    expect(JSON.parse(claimedAudit.diff!)).toEqual({
      marketNameChanges: [{ domain: 'gearloft.example', before: ['LoftGear'], after: [] }],
    })
    expect((await marketLandscape()).competitorIdentityChangedAt).toBe(claimedAudit.createdAt)

    const released = await putProject([])
    expect(released.statusCode, released.body).toBe(200)
    expect(await gearloftMentions()).toBe(1)
    const releasedAudit = latestAudit('project.updated')
    expect(JSON.parse(releasedAudit.diff!)).toEqual({
      marketNameChanges: [{ domain: 'gearloft.example', before: [], after: ['LoftGear'] }],
    })
    expect((await marketLandscape()).competitorIdentityChangedAt).toBe(releasedAudit.createdAt)
  })

  it('moves when an apply claims a market-only competitor\'s learned name', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    storeLearnedName()
    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', aliases: ['LoftGear'] },
      },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(await gearloftMentions()).toBe(0)
    const replaced = latestAudit('competitors.replaced')
    expect(JSON.parse(replaced.diff!)).toMatchObject({
      marketNameChanges: [{ domain: 'gearloft.example', before: ['LoftGear'], after: [] }],
    })
    expect((await marketLandscape()).competitorIdentityChangedAt).toBe(replaced.createdAt)

    // Applying the same spec again changes nothing.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', aliases: ['LoftGear'] },
      },
    })
    expect(again.statusCode, again.body).toBe(200)
    expect(JSON.parse(latestAudit('competitors.replaced').diff!)).not.toHaveProperty('marketNameChanges')
    expect((await marketLandscape()).competitorIdentityChangedAt).toBe(replaced.createdAt)
  })
})

describe('competitorIdentityChangedAt after competitor and pin writes that move learned names', () => {
  const identityChangedAt = async () => (await marketLandscape()).competitorIdentityChangedAt

  function addCompetitors(domains: string[]) {
    return app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: domains } })
  }

  it('moves when an add claims a learned name, and again when the removal releases it', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    storeLearnedName()
    expect(await gearloftMentions()).toBe(1)

    // An add whose names claim no learned name records none.
    expect((await addCompetitors(['spinhaus.example'])).statusCode).toBe(200)
    expect(JSON.parse(latestAudit('competitors.appended').diff!)).not.toHaveProperty('marketNameChanges')
    expect(await identityChangedAt()).toBeNull()

    // loftgear.example's domain label is "LoftGear": it claims the learned name.
    const added = await addCompetitors(['loftgear.example'])
    expect(added.statusCode, added.body).toBe(200)
    expect(await gearloftMentions()).toBe(0)
    const appended = latestAudit('competitors.appended')
    expect(JSON.parse(appended.diff!)).toMatchObject({
      added: ['loftgear.example'],
      marketNameChanges: [{ domain: 'gearloft.example', before: ['LoftGear'], after: [] }],
    })
    expect(await identityChangedAt()).toBe(appended.createdAt)

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/rotorwise/competitors',
      payload: { competitors: ['loftgear.example'] },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await gearloftMentions()).toBe(1)
    const deleted = latestAudit('competitors.deleted')
    expect(JSON.parse(deleted.diff!)).toMatchObject({
      deleted: ['loftgear.example'],
      marketNameChanges: [{ domain: 'gearloft.example', before: [], after: ['LoftGear'] }],
    })
    expect(await identityChangedAt()).toBe(deleted.createdAt)

    // Removing a competitor that claimed nothing records nothing new.
    const row = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/competitors' }))
      .json<Array<{ id: string; domain: string }>>().find(competitor => competitor.domain === 'spinhaus.example')!
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/projects/rotorwise/competitors/${row.id}` })).statusCode).toBe(204)
    expect(JSON.parse(latestAudit('competitors.deleted').diff!)).not.toHaveProperty('marketNameChanges')
    expect(await identityChangedAt()).toBe(deleted.createdAt)
  })

  it('moves when a market-only competitor is promoted to a tracked one and its learned names drop', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    storeLearnedName()
    const promoted = await addCompetitors(['gearloft.example'])
    expect(promoted.statusCode, promoted.body).toBe(200)
    expect(readMarketCompetitorNames(db, projectId)).toEqual(new Map())
    const appended = latestAudit('competitors.appended')
    expect(JSON.parse(appended.diff!)).toMatchObject({
      marketNameChanges: [{ domain: 'gearloft.example', before: ['LoftGear'], after: [] }],
    })
    expect(await identityChangedAt()).toBe(appended.createdAt)
  })

  it('moves when a draft pin claims a learned name, and again when the discard releases it', async () => {
    seedMarket([{ domain: 'gearloft.example', label: 'Gearloft', aliases: [] }], 'Rotorwise and LoftGear both repair rotors.')
    storeLearnedName()
    const created = await draftAction('create', { expectedActiveRevision: 1 })
    expect(created.statusCode, created.body).toBe(200)
    expect(JSON.parse(latestAudit('measurement-draft.created').diff ?? '{}')).not.toHaveProperty('marketNameChanges')
    expect(await identityChangedAt()).toBeNull()

    const pinned = await draftAction('upsert-competitor', {
      groupKey: 'regional',
      competitor: { stableKey: 'competitor-loftgear', label: 'LoftGear', domain: 'loftgear.example', aliases: [] },
    }, created.json().etag)
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(await gearloftMentions()).toBe(0)
    const upserted = latestAudit('measurement-draft.upsert-competitor')
    expect(JSON.parse(upserted.diff!)).toMatchObject({
      marketNameChanges: [{ domain: 'gearloft.example', before: ['LoftGear'], after: [] }],
    })
    expect(await identityChangedAt()).toBe(upserted.createdAt)

    const discarded = await draftAction('discard', {}, pinned.json().etag)
    expect(discarded.statusCode, discarded.body).toBe(200)
    expect(await gearloftMentions()).toBe(1)
    const discardAudit = latestAudit('measurement-draft.discarded')
    expect(JSON.parse(discardAudit.diff!)).toEqual({
      marketNameChanges: [{ domain: 'gearloft.example', before: [], after: ['LoftGear'] }],
    })
    expect(await identityChangedAt()).toBe(discardAudit.createdAt)
  })
})

describe('marketNameChanges', () => {
  it('lists the domains whose learned names differ, in either direction, ignoring order', () => {
    expect(marketNameChanges(
      new Map([['alpha.example', ['Alpha One', 'Alpha']], ['beta.example', ['Beta']]]),
      new Map([['alpha.example', ['Alpha', 'Alpha One']], ['gamma.example', ['Gamma']]]),
    )).toEqual([
      { domain: 'beta.example', before: ['Beta'], after: [] },
      { domain: 'gamma.example', before: [], after: ['Gamma'] },
    ])
    expect(marketNameChanges(new Map(), new Map())).toEqual([])
  })
})
