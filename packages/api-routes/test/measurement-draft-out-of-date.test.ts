import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  apiKeys,
  createClient,
  measurementPlanDrafts,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_draft_out_of_date_root'
const NOW = '2026-10-09T00:00:00.000Z'
const PROJECT = 'northwind'
const TRACKED_SINCE = 'widget warranty terms'
const OUT_OF_DATE_MESSAGE = 'The published setup changed after this draft was started. Discard the draft, start a new one, and publish again.'

let directory: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let idempotencyCounter = 0

function request(method: 'GET' | 'POST', url: string, options: { payload?: unknown; ifMatch?: string } = {}) {
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${url}`,
    headers: {
      authorization: `Bearer ${ROOT_KEY}`,
      ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
      ...(method === 'GET' ? {} : { 'idempotency-key': `key-${++idempotencyCounter}` }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  })
}

/** One draft action that must succeed; returns the response and the draft's new ETag. */
async function draftAction(name: string, payload: unknown, ifMatch?: string) {
  const response = await request('POST', `/measurement-plan/draft/actions/${name}`, { payload, ifMatch })
  expect(response.statusCode, `${name}: ${response.body}`).toBe(200)
  return { body: response.json(), etag: response.json().etag as string }
}

/** Publishes the stored draft as the caller reviewed it, naming `expectedActiveRevision`. */
async function publishDraft(etag: string, expectedActiveRevision: number | null) {
  const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
  expect(compiled.statusCode, compiled.body).toBe(200)
  return request('POST', '/measurement-plan/draft/actions/publish', {
    payload: { expectedActiveRevision, expectedCompiledChecksum: compiled.json().compiledChecksum },
    ifMatch: etag,
  })
}

/** Revision 1: one location in one group, asked one query. */
async function publishFirstRevision(): Promise<void> {
  let { etag } = await draftAction('create', { expectedActiveRevision: null })
  ;({ etag } = await draftAction('upsert-target', {
    target: {
      stableKey: 'widgets', label: 'Widgets', status: 'included', aliases: ['Northwind Widgets'],
      urlMatchers: ['https://northwind.example/widgets/*'], source: 'manual',
    },
  }, etag))
  ;({ etag } = await draftAction('upsert-group', { group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets'], competitors: [] } }, etag))
  ;({ etag } = await draftAction('apply-assignments', { targetKey: 'widgets', queryIds: ['q-supplier'] }, etag))
  const published = await publishDraft(etag, null)
  expect(published.json(), published.body).toMatchObject({ published: true, active: { revision: 1 } })
}

/** A tracking publish through the reviewed preview and commit: adds one query for Widgets. */
async function publishTrackingChange(): Promise<void> {
  const workspace = (await request('GET', '/query-tracking')).json()
  const mutation = {
    expectedWorkspaceVersion: workspace.workspaceVersion,
    removals: [],
    additions: [{
      input: { source: 'manual', text: TRACKED_SINCE },
      audience: { targetKeys: ['widgets'] },
      contexts: workspace.defaultContexts.map((context: { location: { label: string } | null }) => ({ ...context, location: context.location?.label ?? null })),
    }],
  }
  const preview = await request('POST', '/query-tracking/preview', { payload: mutation })
  expect(preview.statusCode, preview.body).toBe(200)
  const commit = await request('POST', '/query-tracking/commit', {
    payload: { ...mutation, previewToken: preview.json().previewToken, reviewedAt: preview.json().reviewedAt },
  })
  expect(commit.json(), commit.body).toMatchObject({ committed: true, active: { revision: 2 } })
}

/** A draft started from revision 1 that adds a query, then a tracking publish to revision 2. */
async function draftLeftBehindByTracking(): Promise<string> {
  await publishFirstRevision()
  let { etag } = await draftAction('create', { expectedActiveRevision: 1 })
  ;({ etag } = await draftAction('apply-assignments', { targetKey: 'widgets', queryIds: ['q-delivery'] }, etag))
  await publishTrackingChange()
  return etag
}

async function activePlan() {
  const response = await request('GET', '/measurement-plan')
  expect(response.statusCode, response.body).toBe(200)
  const { revision, plan } = response.json().active as { revision: number; plan: { querySnapshots: Array<{ queryText: string }> } }
  return { revision, queries: plan.querySnapshots.map(query => query.queryText).sort() }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-draft-out-of-date-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'root', keyHash: hashApiKey(ROOT_KEY), keyPrefix: ROOT_KEY.slice(0, 9),
    scopes: ['*'], projectId: null, createdAt: NOW,
  }).run()
  db.insert(projects).values({
    id: 'prj_northwind', name: PROJECT, displayName: 'Northwind', canonicalDomain: 'northwind.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'], providerModels: { openai: 'gpt-test', gemini: 'gemini-test' },
    locations: [{ label: 'nyc', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'nyc',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values([
    { id: 'q-supplier', projectId: 'prj_northwind', query: 'best widget supplier', createdAt: NOW },
    { id: 'q-delivery', projectId: 'prj_northwind', query: 'widget delivery times', createdAt: NOW },
  ]).run()
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => ['gemini', 'openai'] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement draft publish: an out-of-date draft', () => {
  it('refuses a draft a tracking publish left behind, whichever revision the caller names, and keeps the tracking change', async () => {
    const etag = await draftLeftBehindByTracking()
    const draftBefore = db.select().from(measurementPlanDrafts).get()!
    expect(draftBefore.baseActiveRevision).toBe(1)

    // A CLI or MCP caller reads the active plan first, so it names revision 2. This publish used to succeed.
    const current = await publishDraft(etag, 2)
    expect(current.statusCode, current.body).toBe(409)
    expect(current.json()).toEqual({
      error: {
        code: 'MEASUREMENT_PLAN_REVISION_CONFLICT',
        message: OUT_OF_DATE_MESSAGE,
        details: { expectedActiveRevision: 2, actualActiveRevision: 2, check: 'draft-out-of-date', draftBase: 1, active: 2 },
      },
    })
    // The web names the revision it reviewed. The draft is the reason, so it gets the same check.
    const reviewed = await publishDraft(etag, 1)
    expect(reviewed.statusCode, reviewed.body).toBe(409)
    expect(reviewed.json().error).toMatchObject({
      code: 'MEASUREMENT_PLAN_REVISION_CONFLICT',
      details: { expectedActiveRevision: 1, actualActiveRevision: 2, check: 'draft-out-of-date', draftBase: 1, active: 2 },
    })

    expect(await activePlan()).toEqual({ revision: 2, queries: ['best widget supplier', TRACKED_SINCE] })
    expect(db.select().from(measurementPlanVersions).all().map(version => version.revision).sort()).toEqual([1, 2])
    expect(db.select().from(measurementPlanDrafts).all()).toEqual([draftBefore])
  })

  it('publishes once the draft is discarded and started again from the active plan, with the tracking change in it', async () => {
    const stale = await draftLeftBehindByTracking()
    const discarded = await request('POST', '/measurement-plan/draft/actions/discard', { payload: {}, ifMatch: stale })
    expect(discarded.statusCode, discarded.body).toBe(200)
    let { etag } = await draftAction('create', { expectedActiveRevision: 2 })
    ;({ etag } = await draftAction('apply-assignments', { targetKey: 'widgets', queryIds: ['q-delivery'] }, etag))

    const published = await publishDraft(etag, 2)
    expect(published.statusCode, published.body).toBe(200)
    expect(published.json()).toMatchObject({ published: true, active: { revision: 3 } })
    expect(await activePlan()).toEqual({ revision: 3, queries: ['best widget supplier', 'widget delivery times', TRACKED_SINCE] })
  })

  it('still saves a competitor pin into the out-of-date draft, which stays refused at publish', async () => {
    await draftLeftBehindByTracking()
    const pinned = await request('POST', '/measurement-plan/draft/actions/pin-competitor', {
      payload: { expectedActiveRevision: 2, groupKey: 'catalog', domain: 'rival.example', label: 'Rival' },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json()).toMatchObject({
      changed: true, draftCreated: false, groupKey: 'catalog',
      competitor: { domain: 'rival.example', label: 'Rival' },
      published: { revision: 2, competitorsChanged: false },
    })
    const draft = (await request('GET', '/measurement-plan/draft')).json().draft
    expect(draft.baseActiveRevision).toBe(1)
    expect(draft.authoring.groups[0].competitors.map((competitor: { domain: string }) => competitor.domain)).toEqual(['rival.example'])

    const refused = await publishDraft(pinned.json().etag, 2)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.details).toMatchObject({ check: 'draft-out-of-date', draftBase: 1, active: 2 })
    expect((await activePlan()).revision).toBe(2)
  })

  it('refuses a draft held across a deactivation: no plan is active, and the draft was started from revision 1', async () => {
    await publishFirstRevision()
    const { etag } = await draftAction('create', { expectedActiveRevision: 1 })
    const deactivated = await request('POST', '/measurement-plan/actions/deactivate', { payload: { expectedActiveRevision: 1 } })
    expect(deactivated.statusCode, deactivated.body).toBe(200)

    const refused = await publishDraft(etag, null)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error).toMatchObject({
      code: 'MEASUREMENT_PLAN_REVISION_CONFLICT',
      message: OUT_OF_DATE_MESSAGE,
      details: { expectedActiveRevision: null, actualActiveRevision: null, check: 'draft-out-of-date', draftBase: 1, active: null },
    })
    expect((await request('GET', '/measurement-plan')).json().active).toBeNull()
  })

  it('keeps the plain revision conflict for a current draft when the caller names another revision', async () => {
    await publishFirstRevision()
    let { etag } = await draftAction('create', { expectedActiveRevision: 1 })
    ;({ etag } = await draftAction('apply-assignments', { targetKey: 'widgets', queryIds: ['q-delivery'] }, etag))

    const refused = await publishDraft(etag, 7)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toEqual({
      error: {
        code: 'MEASUREMENT_PLAN_REVISION_CONFLICT',
        message: 'The active measurement plan changed. Reload it before publishing.',
        details: { expectedActiveRevision: 7, actualActiveRevision: 1 },
      },
    })
    // Its base is the active revision, so the same draft publishes as before once the caller names it.
    const published = await publishDraft(etag, 1)
    expect(published.statusCode, published.body).toBe(200)
    expect(published.json()).toMatchObject({ published: true, active: { revision: 2 } })
  })
})
