import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  QUERY_CLASS_BY_FOCUS,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
  type QueryTrackingPreviewResponse,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const NOW = '2026-10-14T00:00:00.000Z'
const PROJECT = 'acme'
const PROJECT_ID = 'project-acme'
const ROOT_KEY = 'cnry_tracking_type_mismatches_root'
const ALPHA = { label: 'alpha', city: 'Alpha', region: 'AA', country: 'US' }
const CONTEXT = { providers: ['openai'], models: { openai: 'gpt-test' }, location: ALPHA }
/** What a hand-picked addition sends: it names its own search location and engines. */
const CONTEXTS = [{ providers: ['openai'], models: { openai: 'gpt-test' }, location: 'alpha' }]

let directory: string
let db: DatabaseClient
let app: FastifyInstance

type Pairing = { queryId: string; targetKey: string; queryClass: 'branded' | 'non-brand'; market?: string; source?: 'server' }

/**
 * Acme Homes, four locations stored under their full names:
 * - Lakeshore holds Harbor Point and River Point. `q-lake` is its Non-brand market query and `q-harbor` Harbor's Branded one.
 * - Hilltop holds Summit Lofts alone, where the type alone decides the Subject: `q-hill` is the market's, `q-summit` the location's.
 * - Lone Pine is in no market. `q-pick` is hand-picked for Harbor and Lone Pine.
 * `q-old` breaks the rule already: a Lakeshore market query the server typed Branded before the rule was reported.
 * Every other type was set by an operator.
 */
function seedPortfolio(): void {
  const texts: Record<string, string> = {
    'q-lake': 'best homes in lakeshore',
    'q-harbor': 'acme harbor point reviews',
    'q-hill': 'best homes hilltop',
    'q-summit': 'acme summit lofts reviews',
    'q-pick': 'homes with a garden',
    'q-old': 'lakeshore homes with parking',
  }
  const pairings: Pairing[] = [
    { queryId: 'q-lake', targetKey: 'harbor', queryClass: 'non-brand', market: 'lakeshore' },
    { queryId: 'q-lake', targetKey: 'river', queryClass: 'non-brand', market: 'lakeshore' },
    { queryId: 'q-harbor', targetKey: 'harbor', queryClass: 'branded', market: 'lakeshore' },
    { queryId: 'q-hill', targetKey: 'summit', queryClass: 'non-brand', market: 'hilltop' },
    { queryId: 'q-summit', targetKey: 'summit', queryClass: 'branded', market: 'hilltop' },
    { queryId: 'q-pick', targetKey: 'harbor', queryClass: 'non-brand' },
    { queryId: 'q-pick', targetKey: 'lone', queryClass: 'non-brand' },
    { queryId: 'q-old', targetKey: 'harbor', queryClass: 'branded', market: 'lakeshore', source: 'server' },
    { queryId: 'q-old', targetKey: 'river', queryClass: 'branded', market: 'lakeshore', source: 'server' },
  ]
  const edge = ({ queryId, targetKey }: Pairing) => ({ executionNodeKey: `n-${queryId}`, targetKey, queryId })
  const provisional = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'acmehomes.example', ownedHosts: ['acmehomes.example'], names: ['Acme Homes'] } },
    targets: [['harbor', 'Acme Harbor Point'], ['river', 'Acme River Point'], ['summit', 'Acme Summit Lofts'], ['lone', 'Acme Lone Pine']]
      .map(([stableKey, label]) => ({
        stableKey, label, aliases: [label],
        urlMatchers: [{ kind: 'prefix', host: 'acmehomes.example', pathPrefix: `/${stableKey}`, pathCase: 'insensitive' }],
        mentionNotApplicable: false, discoveryIdentity: null,
      })),
    groups: [],
    querySnapshots: Object.entries(texts).map(([queryId, queryText]) => ({
      queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    })),
    assignments: pairings.map(pairing => ({ ...edge(pairing), queryClass: pairing.queryClass, classificationSource: pairing.source ?? 'operator' })),
    executionNodes: Object.entries(texts).map(([queryId, queryText]) => ({
      stableKey: `n-${queryId}`, queryId, queryText, context: CONTEXT, expectedSnapshots: 1,
    })),
    usageEdges: pairings.map(edge),
    reportingScopes: [['hilltop', 'Hilltop'], ['lakeshore', 'Lakeshore']].map(([stableKey, label]) => ({
      stableKey, label, kind: 'market', usageEdges: pairings.filter(pairing => pairing.market === stableKey).map(edge),
    })),
    compiledChecksum: '0'.repeat(64),
  })
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(provisional)).digest('hex')
  const plan = measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(queries).values(Object.entries(texts).map(([id, query]) => ({ id, projectId: PROJECT_ID, query, provenance: null, createdAt: NOW }))).run()
}

function request(method: 'GET' | 'POST', suffix: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${suffix}`,
    headers: { authorization: `Bearer ${ROOT_KEY}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function workspace() {
  const response = await request('GET', '/query-tracking')
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

type Mutation = { additions?: unknown[]; removals?: unknown[]; edits?: unknown[] }

async function review(mutation: Mutation) {
  const payload = {
    expectedWorkspaceVersion: (await workspace()).workspaceVersion,
    additions: mutation.additions ?? [], removals: mutation.removals ?? [],
    ...(mutation.edits ? { edits: mutation.edits } : {}),
  }
  const response = await request('POST', '/query-tracking/preview', payload)
  expect(response.statusCode, response.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(response.json())
  return { preview, commit: { ...payload, previewToken: preview.previewToken, reviewedAt: preview.reviewedAt } }
}

/** Each reported row without its id: wording, Subject, the Type that Subject takes, the Type it would get, and the wording flag. */
function reported(preview: QueryTrackingPreviewResponse) {
  return preview.typeMismatches?.map(row => [row.queryText, row.focus, row.expectedQueryClass, row.queryClasses, row.brandedWording])
}

const LAKESHORE = { kind: 'market', key: 'lakeshore' }
const HARBOR = { kind: 'property', key: 'harbor' }

function toMarket(text: string, queryClass?: 'branded' | 'non-brand') {
  return { input: { source: 'manual', text }, audience: { marketKeys: ['lakeshore'] }, ...(queryClass ? { queryClass } : {}) }
}

/** What the Add queries sheet sends for a location: the location and every market it is in. */
function toHarbor(text: string, queryClass?: 'branded' | 'non-brand') {
  return { input: { source: 'manual', text }, audience: { targetKeys: ['harbor'], marketKeys: ['lakeshore'] }, ...(queryClass ? { queryClass } : {}) }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-type-mismatches-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: PROJECT_ID, name: PROJECT, displayName: 'Acme Homes', canonicalDomain: 'acmehomes.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [ALPHA], defaultLocation: 'alpha', createdAt: NOW, updatedAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['openai'] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking preview: type follows Subject', () => {
  it('states the rule once: a market query is Non-brand and a location query is Branded', () => {
    expect(QUERY_CLASS_BY_FOCUS).toEqual({ market: 'non-brand', property: 'branded' })
  })

  it('lists a market query typed Branded with every field the report carries', async () => {
    seedPortfolio()
    const { preview } = await review({ additions: [toMarket('homes near the lake', 'branded')] })

    const added = preview.tracked.find(row => row.queryText === 'homes near the lake')!
    expect([added.focus, added.queryClasses]).toEqual([LAKESHORE, ['branded']])
    expect(preview.typeMismatches).toEqual([{
      queryId: added.queryId, queryText: 'homes near the lake', focus: LAKESHORE,
      expectedQueryClass: 'non-brand', queryClasses: ['branded'], brandedWording: false,
    }])
  })

  it('lists a location query the classifier files as Non-brand because it leaves out the stored name, and not one sent as Branded', async () => {
    seedPortfolio()
    // Stored as "Acme Harbor Point": the short name alone does not read as Branded.
    const automatic = (await review({ additions: [toHarbor('harbor point pricing')] })).preview

    expect(automatic.tracked.find(row => row.queryText === 'harbor point pricing')?.assignments.map(row => row.classificationSource)).toEqual(['server'])
    expect(reported(automatic)).toEqual([['harbor point pricing', HARBOR, 'branded', ['non-brand'], false]])
    expect(reported((await review({ additions: [toHarbor('harbor point pricing', 'branded')] })).preview)).toEqual([])
    // With the stored name the classifier agrees with the Subject by itself.
    expect(reported((await review({ additions: [toHarbor('acme harbor point pricing')] })).preview)).toEqual([])
  })

  it('lists a market query whose wording names the company or one of its locations, whatever type it was given', async () => {
    seedPortfolio()

    // Sent as Non-brand: the type fits, the wording does not.
    expect(reported((await review({ additions: [toMarket('acme homes in lakeshore', 'non-brand')] })).preview))
      .toEqual([['acme homes in lakeshore', LAKESHORE, 'non-brand', ['non-brand'], true]])
    // Left to the classifier, it is typed Branded as well.
    expect(reported((await review({ additions: [toMarket('acme homes in lakeshore')] })).preview))
      .toEqual([['acme homes in lakeshore', LAKESHORE, 'non-brand', ['branded'], true]])
    // Naming one location of the market is enough.
    expect(reported((await review({ additions: [toMarket('homes like acme river point', 'non-brand')] })).preview))
      .toEqual([['homes like acme river point', LAKESHORE, 'non-brand', ['non-brand'], true]])
    expect(reported((await review({ additions: [toMarket('homes near the lake')] })).preview)).toEqual([])
  })

  it('lists nothing for a hand-picked query of either type, nor for a company-naming wording there', async () => {
    seedPortfolio()
    const handPicked = (text: string, queryClass: 'branded' | 'non-brand') => review({
      additions: [{ input: { source: 'manual', text }, audience: { targetKeys: ['harbor', 'lone'] }, contexts: CONTEXTS, queryClass }],
    })

    for (const [text, queryClass] of [['homes with a pool', 'branded'], ['homes with a pool', 'non-brand'], ['acme homes with a pool', 'non-brand']] as const) {
      const { preview } = await handPicked(text, queryClass)
      expect(preview.tracked.find(row => row.queryText === text)?.focus).toEqual({ kind: 'custom' })
      expect(preview.typeMismatches, `${text} as ${queryClass}`).toEqual([])
    }
  })

  it('lists a location query retyped Non-brand in a market of one location, where it becomes the market\'s', async () => {
    seedPortfolio()
    const { preview } = await review({ edits: [{ queryId: 'q-summit', queryClass: 'non-brand' }] })

    expect(preview.diff.reused.map(row => row.queryId)).toEqual(['q-summit'])
    // The type now fits its new Subject, and the wording still names the location.
    expect(reported(preview)).toEqual([['acme summit lofts reviews', { kind: 'market', key: 'hilltop' }, 'non-brand', ['non-brand'], true]])
    // The other way round is the rule: a market query retyped Branded there is the location's.
    expect(reported((await review({ edits: [{ queryId: 'q-hill', queryClass: 'branded' }] })).preview)).toEqual([])
  })

  it('lists a Subject change that keeps the old type, and a market query left with both types', async () => {
    seedPortfolio()
    // Market to location with the market's Non-brand sent again.
    const moved = (await review({ removals: [{ queryId: 'q-lake' }], additions: [toHarbor('best homes in lakeshore', 'non-brand')] })).preview
    expect(moved.diff.reused.map(row => row.queryId)).toEqual(['q-lake'])
    expect(reported(moved)).toEqual([['best homes in lakeshore', HARBOR, 'branded', ['non-brand'], false]])
    // Location to market with the location's Branded sent again. The wording names the location too.
    expect(reported((await review({ removals: [{ queryId: 'q-harbor' }], additions: [toMarket('acme harbor point reviews', 'branded')] })).preview))
      .toEqual([['acme harbor point reviews', LAKESHORE, 'non-brand', ['branded'], true]])
    // Branded for one of the market's two locations only.
    expect(reported((await review({ edits: [{ queryId: 'q-lake', audience: { targetKeys: ['harbor'] }, queryClass: 'branded' }] })).preview))
      .toEqual([['best homes in lakeshore', LAKESHORE, 'non-brand', ['branded', 'non-brand'], false]])
  })

  it('lists a market query reworded to name the company, which keeps its Non-brand type', async () => {
    seedPortfolio()
    const { preview } = await review({ edits: [{ queryId: 'q-lake', text: 'acme homes lakeshore' }] })

    expect(preview.tracked.find(row => row.queryText === 'acme homes lakeshore')?.queryClasses).toEqual(['non-brand'])
    expect(reported(preview)).toEqual([['acme homes lakeshore', LAKESHORE, 'non-brand', ['non-brand'], true]])
  })

  it('leaves out a query that already broke the rule until a change gives it a new Subject, type or wording', async () => {
    seedPortfolio()
    const old = (await workspace()).tracked.find(row => row.queryId === 'q-old')!
    expect([old.focus, old.queryClasses]).toEqual([LAKESHORE, ['branded']])

    // Not named by the change at all.
    expect(reported((await review({ additions: [toMarket('homes near the lake')] })).preview)).toEqual([])
    // Named again beside another line, and left exactly as it is.
    const again = (await review({ additions: [toMarket('lakeshore homes with parking'), toMarket('homes near the lake')] })).preview
    expect(again.changes?.map(change => [change.queryId, change.change, change.altered])).toContainEqual(['q-old', 'reused', false])
    expect(reported(again)).toEqual([])
    // An operator sets the type it already has: the query changes, its Subject and type do not.
    const sameType = (await review({ edits: [{ queryId: 'q-old', queryClass: 'branded' }] })).preview
    expect(sameType.changes?.map(change => [change.queryId, change.change, change.altered])).toEqual([['q-old', 'reused', true]])
    expect(reported(sameType)).toEqual([])
    // Reworded, it is a new query that takes the old type with it.
    expect(reported((await review({ edits: [{ queryId: 'q-old', text: 'lakeshore homes with a garage' }] })).preview))
      .toEqual([['lakeshore homes with a garage', LAKESHORE, 'non-brand', ['branded'], false]])
  })

  it('reports and never refuses: a listed change still publishes, and is old state afterwards', async () => {
    seedPortfolio()
    const { preview, commit } = await review({ additions: [toMarket('homes near the lake', 'branded')] })
    expect(preview.typeMismatches).toHaveLength(1)

    const published = await request('POST', '/query-tracking/commit', commit)
    expect(published.statusCode, published.body).toBe(200)
    expect(queryTrackingCommitResponseSchema.parse(published.json())).toMatchObject({ committed: true, active: { revision: 2 } })
    const stored = (await workspace()).tracked.find(row => row.queryText === 'homes near the lake')
    expect([stored?.focus, stored?.queryClasses]).toEqual([LAKESHORE, ['branded']])
    expect(reported((await review({ additions: [toMarket('homes near a park')] })).preview)).toEqual([])
  })

  it('returns an empty list for a review that changes nothing and no field for a simple site', async () => {
    db.insert(queries).values({ id: 'q-simple', projectId: PROJECT_ID, query: 'acme homes reviews', provenance: null, createdAt: NOW }).run()
    const simple = await request('POST', '/query-tracking/preview', {
      expectedWorkspaceVersion: (await workspace()).workspaceVersion, removals: [],
      additions: [{ input: { source: 'manual', text: 'best homes near me' } }],
    })
    expect(simple.statusCode, simple.body).toBe(200)
    expect(simple.json()).toMatchObject({ mode: 'simple', diff: { added: [{ queryText: 'best homes near me' }] } })
    expect(simple.json()).not.toHaveProperty('typeMismatches')

    db.delete(queries).run()
    seedPortfolio()
    const empty = (await review({})).preview
    expect(empty.diff.noOp).toBe(true)
    expect(empty.typeMismatches).toEqual([])
  })
})
