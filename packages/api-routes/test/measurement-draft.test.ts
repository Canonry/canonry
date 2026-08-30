import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES,
  canonicalMeasurementPlanV2Json,
  measurementDraftApplyGroupMembershipResponseSchema,
  measurementDraftCompilePreviewResponseSchema,
  measurementDraftDiffPreviewResponseSchema,
  measurementDraftMutationResponseSchema,
  measurementDraftReplaceQueryResponseSchema,
  measurementDraftPreviewAssignmentsResponseSchema,
  measurementDraftPreviewGroupMembershipResponseSchema,
  measurementDraftResponseSchema,
  measurementPlanResponseSchema,
  measurementPlanVersionResponseSchema,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  measurementPlanV2PublishResponseSchema,
  measurementSetupResponseSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  auditLog,
  createClient,
  measurementOperationReceipts,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  measurementSegments,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  schedules,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { canonicalJson, requestChecksum, sha256Hex } from '../src/measurement-draft-repo.js'

const ROOT_KEY = 'cnry_draft_root'
const NOW = '2026-08-02T00:00:00.000Z'
const PROJECT = 'northwind'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let tracked: Array<{ id: string; query: string }>
let runnableProviders: string[]

function seedKey(name: string, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: null,
    createdAt: NOW,
  }).run()
}

interface RequestOptions {
  token?: string
  payload?: unknown
  ifMatch?: string
  idempotencyKey?: string
}

let idempotencyCounter = 0

function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token ?? ROOT_KEY}` }
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
  else if (method !== 'GET') headers['idempotency-key'] = `auto-${++idempotencyCounter}`
  return app.inject({
    method,
    url: `/api/v1/projects/${PROJECT}${url}`,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  })
}

function action(name: string, options: RequestOptions = {}) {
  return request('POST', `/measurement-plan/draft/actions/${name}`, { payload: {}, ...options })
}

/** Starts the draft and hands back the ETag every following mutation needs. */
async function createDraft(expectedActiveRevision: number | null = null): Promise<string> {
  const created = await action('create', { payload: { expectedActiveRevision } })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().etag as string
}

/** Chains actions so a test reads as a sequence rather than as ETag bookkeeping. */
class DraftSession {
  constructor(public etag: string) {}

  static async start(expectedActiveRevision: number | null = null): Promise<DraftSession> {
    return new DraftSession(await createDraft(expectedActiveRevision))
  }

  async run(name: string, payload: unknown) {
    const response = await action(name, { payload, ifMatch: this.etag })
    expect(response.statusCode, `${name}: ${response.body}`).toBe(200)
    this.etag = response.json().etag as string
    return response
  }
}

const WIDGETS_TARGET = {
  stableKey: 'widgets',
  label: 'Widgets',
  status: 'included' as const,
  aliases: ['Northwind Widgets'],
  urlMatchers: ['https://northwind.example/widgets/*'],
  source: 'manual' as const,
}

const GADGETS_TARGET = {
  stableKey: 'gadgets',
  label: 'Gadgets',
  status: 'included' as const,
  aliases: ['Northwind Gadgets'],
  urlMatchers: ['https://shop.northwind.example/gadgets/*'],
  source: 'manual' as const,
}

function queryId(text: string): string {
  const found = tracked.find(query => query.query === text)
  if (!found) throw new Error(`test query "${text}" was not seeded`)
  return found.id
}

/** A draft with one included Target and both of its questions classified. */
async function readyDraft(): Promise<DraftSession> {
  const session = await DraftSession.start()
  await session.run('upsert-target', { target: WIDGETS_TARGET })
  await session.run('apply-assignments', {
    targetKey: 'widgets',
    queryIds: [queryId('best widget supplier'), queryId('northwind widget reviews')],
  })
  return session
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-draft-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  db.insert(projects).values({
    id: 'prj_northwind',
    name: PROJECT,
    displayName: 'Northwind',
    canonicalDomain: 'northwind.example',
    ownedDomains: ['shop.northwind.example'],
    country: 'US',
    language: 'en',
    providers: ['openai', 'gemini'],
    providerModels: { openai: 'gpt-test', gemini: 'gemini-test' },
    locations: [{ label: 'nyc', city: 'New York', region: 'NY', country: 'US' }],
    defaultLocation: 'nyc',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  for (const text of ['best widget supplier', 'northwind widget reviews', 'widget delivery times']) {
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId: 'prj_northwind',
      query: text,
      createdAt: NOW,
    }).run()
  }
  tracked = db.select({ id: queries.id, query: queries.query }).from(queries).all()

  runnableProviders = ['gemini', 'openai']
  app = Fastify()
  app.register(apiRoutes, { db, getRunnableProviderNames: () => runnableProviders })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('measurement draft lifecycle', () => {
  it('creates exactly one draft per project and refuses a second', async () => {
    const empty = await request('GET', '/measurement-plan/draft')
    expect(empty.statusCode).toBe(200)
    expect(measurementDraftResponseSchema.safeParse(empty.json()).success).toBe(true)
    expect(empty.json()).toEqual({ draft: null, etag: null })

    const created = await action('create', { payload: { expectedActiveRevision: null } })
    expect(created.statusCode, created.body).toBe(200)
    expect(measurementDraftMutationResponseSchema.safeParse(created.json()).success).toBe(true)
    expect(created.json()).toMatchObject({
      etag: '"mpd_1"',
      changed: true,
      counts: { targets: 0, includedTargets: 0, assignments: 0, unclassifiedAssignments: 0, groups: 0, competitors: 0 },
    })
    expect(created.headers.etag).toBe('"mpd_1"')

    const loaded = await request('GET', '/measurement-plan/draft')
    expect(measurementDraftResponseSchema.safeParse(loaded.json()).success).toBe(true)
    expect(loaded.json().draft).toMatchObject({
      projectId: 'prj_northwind',
      schemaVersion: 2,
      baseActiveVersionId: null,
      baseActiveRevision: null,
      authoring: { targets: [], assignments: [], groups: [] },
    })

    const second = await action('create', { payload: { expectedActiveRevision: null } })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'ALREADY_EXISTS' } })
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
  })

  it('seeds the default execution context from the project configuration', async () => {
    await createDraft()
    const loaded = await request('GET', '/measurement-plan/draft')
    expect(loaded.json().draft.authoring.defaultContext).toEqual({
      providers: ['gemini', 'openai'],
      models: { gemini: 'gemini-test', openai: 'gpt-test' },
      locations: ['nyc'],
    })
  })

  it('freezes the runnable provider roster when the project uses all configured providers', async () => {
    db.update(projects).set({
      providers: [],
      providerModels: { gemini: 'gemini-test', openai: 'gpt-test', perplexity: 'sonar-test' },
    }).where(eq(projects.id, 'prj_northwind')).run()
    runnableProviders = ['perplexity', ' GEMINI ', 'gemini']

    await createDraft()
    runnableProviders = ['openai']

    const loaded = await request('GET', '/measurement-plan/draft')
    expect(loaded.json().draft.authoring.defaultContext).toEqual({
      providers: ['gemini', 'perplexity'],
      models: { gemini: 'gemini-test', perplexity: 'sonar-test' },
      locations: ['nyc'],
    })
  })
})

describe('measurement draft preconditions', () => {
  it('refuses a mutation with no If-Match and one with a stale If-Match, writing nothing either way', async () => {
    const etag = await createDraft()
    const target = {
      stableKey: 'widgets',
      label: 'Widgets',
      status: 'included',
      aliases: ['Northwind Widgets'],
      urlMatchers: ['https://northwind.example/widgets/*'],
      source: 'manual',
    }

    const before = db.select().from(measurementPlanDrafts).get()!
    const missing = await action('upsert-target', { payload: { target } })
    expect(missing.statusCode).toBe(428)
    expect(missing.json()).toMatchObject({ error: { code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED' } })

    const stale = await action('upsert-target', { payload: { target }, ifMatch: '"mpd_99"' })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({
      error: { code: 'MEASUREMENT_DRAFT_ETAG_STALE', details: { expectedEtag: '"mpd_99"', actualEtag: '"mpd_1"' } },
    })

    // A refused precondition writes nothing at all: not the authoring, not the
    // counter, not the timestamp, and not an idempotency receipt.
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(before)
    expect(db.select().from(measurementOperationReceipts)
      .where(eq(measurementOperationReceipts.operation, 'upsert-target')).all()).toEqual([])

    const accepted = await action('upsert-target', { payload: { target }, ifMatch: etag })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json()).toMatchObject({ etag: '"mpd_2"', changed: true, counts: { targets: 1, includedTargets: 1 } })
  })

  it('advances the ETag on every mutation and never repeats one when content returns to a previous value', async () => {
    let etag = await createDraft()
    const target = {
      stableKey: 'widgets',
      label: 'Widgets',
      status: 'included' as const,
      aliases: ['Northwind Widgets'],
      urlMatchers: ['https://northwind.example/widgets/*'],
      source: 'manual' as const,
    }
    etag = (await action('upsert-target', { payload: { target }, ifMatch: etag })).json().etag

    const renamed = await action('rename-target', { payload: { targetKey: 'widgets', label: 'Widget range' }, ifMatch: etag })
    expect(renamed.json().etag).toBe('"mpd_3"')

    // Content is byte-identical to the mpd_2 state, so a content hash would
    // hand back "mpd_2" and let a stale writer win. The counter must not.
    const restored = await action('rename-target', { payload: { targetKey: 'widgets', label: 'Widgets' }, ifMatch: renamed.json().etag })
    expect(restored.json().etag).toBe('"mpd_4"')

    const authoring = JSON.parse(db.select().from(measurementPlanDrafts).get()!.authoringJson)
    expect(authoring.targets[0].label).toBe('Widgets')
    expect(db.select().from(measurementPlanDrafts).get()!.etagVersion).toBe(4)
  })
})

describe('measurement draft idempotency', () => {
  it('replays a repeated key, refuses the same key with different content, and requires one at all', async () => {
    const noKey = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT}/measurement-plan/draft/actions/create`,
      headers: { authorization: `Bearer ${ROOT_KEY}` },
      payload: { expectedActiveRevision: null },
    })
    expect(noKey.statusCode).toBe(400)
    expect(noKey.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_REQUIRED' } })

    const first = await action('create', { payload: { expectedActiveRevision: null }, idempotencyKey: 'k1' })
    expect(first.statusCode).toBe(200)

    const replay = await action('create', { payload: { expectedActiveRevision: null }, idempotencyKey: 'k1' })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)

    const conflict = await action('create', { payload: { expectedActiveRevision: 3 }, idempotencyKey: 'k1' })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT' } })
  })

  it('replays a stored response even after the ETag has moved on', async () => {
    const etag = await createDraft()
    const payload = { targetKey: 'widgets', label: 'Widgets' }
    await action('upsert-target', {
      payload: {
        target: {
          stableKey: 'widgets',
          label: 'Widget range',
          status: 'included',
          aliases: [],
          urlMatchers: ['northwind.example'],
          source: 'manual',
        },
      },
      ifMatch: etag,
    })
    const renamed = await action('rename-target', { payload, ifMatch: '"mpd_2"', idempotencyKey: 'rename-1' })
    expect(renamed.statusCode, renamed.body).toBe(200)

    // The retry carries the ETag it had when it first sent, which is now
    // stale. A lost response must still be recoverable, so the receipt wins.
    const retry = await action('rename-target', { payload, ifMatch: '"mpd_2"', idempotencyKey: 'rename-1' })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual(renamed.json())
    expect(db.select().from(measurementPlanDrafts).get()!.etagVersion).toBe(3)
  })

  it('accepts only one same-ETag writer and replays the winner without a second write', async () => {
    const etag = await createDraft()
    const leftPayload = { target: WIDGETS_TARGET }
    const rightPayload = { target: GADGETS_TARGET }
    const [left, right] = await Promise.all([
      action('upsert-target', { payload: leftPayload, ifMatch: etag, idempotencyKey: 'concurrent-left' }),
      action('upsert-target', { payload: rightPayload, ifMatch: etag, idempotencyKey: 'concurrent-right' }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 412])

    const winner = left.statusCode === 200
      ? { response: left, payload: leftPayload, key: 'concurrent-left' }
      : { response: right, payload: rightPayload, key: 'concurrent-right' }
    const replay = await action('upsert-target', {
      payload: winner.payload,
      ifMatch: etag,
      idempotencyKey: winner.key,
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(winner.response.json())
    expect(db.select().from(measurementPlanDrafts).get()!.etagVersion).toBe(2)
    expect(db.select().from(auditLog).where(eq(auditLog.action, 'measurement-draft.upsert-target')).all()).toHaveLength(1)
  })
})

describe('measurement draft typed actions', () => {
  it('proposes a class by rule and never lets a later proposal overwrite the operator', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    const branded = queryId('northwind widget reviews')
    const nonBrand = queryId('best widget supplier')

    await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [branded, nonBrand] })
    const proposed = await request('GET', '/measurement-plan/draft/assignments')
    expect(proposed.json().items).toEqual(expect.arrayContaining([
      { targetKey: 'widgets', queryId: branded, queryClass: 'branded', classificationSource: 'rule' },
      { targetKey: 'widgets', queryId: nonBrand, queryClass: 'non-brand', classificationSource: 'rule' },
    ]))

    // The operator overrules the rule: this question is Branded for THIS Target.
    await session.run('classify-assignments', {
      queryClass: 'branded',
      assignments: [{ targetKey: 'widgets', queryId: nonBrand }],
    })
    const reapplied = await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [branded, nonBrand] })
    expect(reapplied.json().changed).toBe(false)

    const settled = await request('GET', '/measurement-plan/draft/assignments')
    expect(settled.json().items).toEqual(expect.arrayContaining([
      { targetKey: 'widgets', queryId: nonBrand, queryClass: 'branded', classificationSource: 'operator' },
    ]))
  })

  it('applies and removes one query selection across multiple Targets in one mutation', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    const beforeApply = Number(session.etag.match(/\d+/)?.[0])
    const queryIds = [queryId('best widget supplier'), queryId('widget delivery times')]

    const refused = await action('apply-assignments', {
      payload: { targetKeys: ['widgets', 'missing-property'], queryIds },
      ifMatch: session.etag,
    })
    expect(refused.statusCode).toBe(404)
    expect((await request('GET', '/measurement-plan/draft/assignments')).json().items).toEqual([])

    await session.run('apply-assignments', {
      targetKeys: ['widgets', 'gadgets', 'widgets'],
      queryIds,
    })
    expect(Number(session.etag.match(/\d+/)?.[0])).toBe(beforeApply + 1)
    expect((await request('GET', '/measurement-plan/draft/assignments')).json().items)
      .toEqual(expect.arrayContaining([
        { targetKey: 'widgets', queryId: queryIds[0], queryClass: 'non-brand', classificationSource: 'rule' },
        { targetKey: 'widgets', queryId: queryIds[1], queryClass: 'non-brand', classificationSource: 'rule' },
        { targetKey: 'gadgets', queryId: queryIds[0], queryClass: 'non-brand', classificationSource: 'rule' },
        { targetKey: 'gadgets', queryId: queryIds[1], queryClass: 'non-brand', classificationSource: 'rule' },
      ]))

    const beforeRemove = Number(session.etag.match(/\d+/)?.[0])
    await session.run('remove-assignment', {
      targetKeys: ['widgets', 'gadgets'],
      queryId: queryIds[0],
    })
    expect(Number(session.etag.match(/\d+/)?.[0])).toBe(beforeRemove + 1)
    const remaining = (await request('GET', '/measurement-plan/draft/assignments')).json().items
    expect(remaining).toHaveLength(2)
    expect(remaining.map((entry: { queryId: string }) => entry.queryId)).toEqual([queryIds[1], queryIds[1]])
  })

  it('replaces all prior Properties for the named questions while leaving other questions intact', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    const market = queryId('best widget supplier')
    const delivery = queryId('widget delivery times')
    await session.run('apply-assignments', {
      targetKeys: ['widgets', 'gadgets'],
      queryIds: [market, delivery],
    })

    await session.run('replace-assignments', {
      targetKeys: ['gadgets'],
      queryIds: [market],
    })

    expect((await request('GET', '/measurement-plan/draft/assignments')).json().items
      .map((entry: { targetKey: string; queryId: string }) => `${entry.targetKey}/${entry.queryId}`).sort())
      .toEqual([
        `gadgets/${delivery}`,
        `gadgets/${market}`,
        `widgets/${delivery}`,
      ].sort())
  })

  it('keeps the surviving key, its assignments and its group membership across a merge', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [queryId('best widget supplier')] })
    await session.run('apply-assignments', { targetKey: 'gadgets', queryIds: [queryId('widget delivery times')] })
    await session.run('upsert-group', { group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets', 'gadgets'] } })

    await session.run('merge-targets', { targetKey: 'widgets', mergedKeys: ['gadgets'] })
    const draft = (await request('GET', '/measurement-plan/draft')).json().draft
    expect(draft.authoring.targets.map((target: { stableKey: string }) => target.stableKey)).toEqual(['widgets'])
    expect(draft.authoring.targets[0].aliases).toEqual(expect.arrayContaining(['Northwind Widgets', 'Northwind Gadgets']))
    expect(draft.authoring.assignments.map((assignment: { targetKey: string }) => assignment.targetKey)).toEqual(['widgets', 'widgets'])
    expect(draft.authoring.groups[0].targetKeys).toEqual(['widgets'])
  })

  it('preserves the key, assignments and membership across a rebind, and replaces the stale matcher', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', {
      target: { ...WIDGETS_TARGET, urlMatchers: ['https://northwind.example/widgets'], discoveredUrl: 'https://northwind.example/widgets' },
    })
    await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [queryId('best widget supplier')] })
    await session.run('upsert-group', { group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets'] } })

    await session.run('rebind-target', {
      targetKey: 'widgets',
      discoveryIdentity: 'northwind.example|/catalog/widgets',
      discoveredUrl: 'https://northwind.example/catalog/widgets',
    })
    const draft = (await request('GET', '/measurement-plan/draft')).json().draft
    expect(draft.authoring.targets[0]).toMatchObject({
      stableKey: 'widgets',
      urlMatchers: ['https://northwind.example/catalog/widgets'],
      discoveryIdentity: 'northwind.example|/catalog/widgets',
    })
    expect(draft.authoring.assignments).toHaveLength(1)
    expect(draft.authoring.groups[0].targetKeys).toEqual(['widgets'])
  })

  it('removes an assignment without deleting the project query behind it', async () => {
    const session = await readyDraft()
    const before = db.select().from(queries).all().length
    await session.run('remove-assignment', { targetKey: 'widgets', queryId: queryId('best widget supplier') })
    expect(db.select().from(queries).all()).toHaveLength(before)

    await session.run('clear-assignments', { targetKey: 'widgets' })
    expect(db.select().from(queries).all()).toHaveLength(before)
    expect((await request('GET', '/measurement-plan/draft')).json().draft.authoring.assignments).toEqual([])
  })

  it('rejects a group payload that carries queries or execution context', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    const rejected = await action('upsert-group', {
      payload: { group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets'], providers: ['openai'] } },
      ifMatch: session.etag,
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })

  it('warns rather than silently dropping the work when an excluded Target still has assignments', async () => {
    const session = await readyDraft()
    const excluded = await session.run('exclude-target', { targetKey: 'widgets' })
    expect(excluded.json().warnings).toEqual([expect.objectContaining({ code: 'excluded-target-has-assignments' })])
    expect(excluded.json().counts).toMatchObject({ targets: 1, includedTargets: 0, assignments: 2 })
  })

  it('can exclude one Target and atomically unlink only its assignments and group memberships', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    await session.run('apply-assignments', {
      targetKeys: ['widgets', 'gadgets'],
      queryIds: [queryId('best widget supplier'), queryId('widget delivery times')],
    })
    await session.run('upsert-group', {
      group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets', 'gadgets'] },
    })
    await session.run('upsert-group', {
      group: { stableKey: 'widgets-only', label: 'Widgets only', targetKeys: ['widgets'] },
    })
    await session.run('upsert-competitor', {
      groupKey: 'catalog',
      competitor: { stableKey: 'contoso', label: 'Contoso', domain: 'contoso.example', aliases: ['Contoso'] },
    })
    const before = Number(session.etag.match(/\d+/)?.[0])
    const queryCount = db.select().from(queries).all().length

    const excluded = await session.run('exclude-target', {
      targetKey: 'widgets',
      cleanup: 'assignments-and-group-memberships',
    })

    expect(Number(session.etag.match(/\d+/)?.[0])).toBe(before + 1)
    expect(excluded.json().warnings).toEqual([])
    const authoring = (await request('GET', '/measurement-plan/draft')).json().draft.authoring
    expect(authoring.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ stableKey: 'widgets', status: 'excluded' }),
      expect.objectContaining({ stableKey: 'gadgets', status: 'included' }),
    ]))
    expect(authoring.assignments).toHaveLength(2)
    expect(new Set(authoring.assignments.map((assignment: { targetKey: string }) => assignment.targetKey)))
      .toEqual(new Set(['gadgets']))
    expect(authoring.groups).toEqual([
      expect.objectContaining({
        stableKey: 'catalog',
        targetKeys: ['gadgets'],
        competitors: [expect.objectContaining({ stableKey: 'contoso' })],
      }),
      expect.objectContaining({ stableKey: 'widgets-only', targetKeys: [], competitors: [] }),
    ])
    expect(db.select().from(queries).all()).toHaveLength(queryCount)

    const settledEtag = session.etag
    const repeated = await session.run('exclude-target', {
      targetKey: 'widgets',
      cleanup: 'assignments-and-group-memberships',
    })
    expect(repeated.json().changed).toBe(false)
    expect(session.etag).toBe(settledEtag)

    await session.run('upsert-target', { target: WIDGETS_TARGET })
    const restored = (await request('GET', '/measurement-plan/draft')).json().draft.authoring
    expect(restored.assignments).toHaveLength(2)
    expect(restored.groups.map((group: { targetKeys: string[] }) => group.targetKeys)).toEqual([['gadgets'], []])
  })

  it('replaces a complete group and competitor list in one ETag mutation', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    await session.run('upsert-group', {
      group: { stableKey: 'catalog', label: 'Old catalog', targetKeys: ['widgets'] },
    })
    await session.run('upsert-competitor', {
      groupKey: 'catalog',
      competitor: { stableKey: 'legacy', label: 'Legacy', domain: 'legacy.example', aliases: [] },
    })
    await session.run('upsert-group', {
      group: { stableKey: 'catalog', label: 'Renamed catalog', targetKeys: ['widgets', 'gadgets'] },
    })
    expect((await request('GET', '/measurement-plan/draft')).json().draft.authoring.groups[0].competitors)
      .toEqual([expect.objectContaining({ stableKey: 'legacy' })])
    const before = Number(session.etag.match(/\d+/)?.[0])
    const staleEtag = session.etag
    const group = {
      stableKey: 'catalog',
      label: 'Product catalog',
      targetKeys: ['widgets', 'gadgets'],
      competitors: [
        { stableKey: 'contoso', label: 'Contoso', domain: 'contoso.example', aliases: ['Contoso'] },
        { stableKey: 'fabrikam', label: 'Fabrikam', domain: 'fabrikam.example', aliases: ['Fabrikam'] },
      ],
    }

    await session.run('upsert-group', { group })

    expect(Number(session.etag.match(/\d+/)?.[0])).toBe(before + 1)
    expect((await request('GET', '/measurement-plan/draft')).json().draft.authoring.groups).toEqual([group])

    const stale = await action('upsert-group', {
      ifMatch: staleEtag,
      payload: { group: { ...group, competitors: [] } },
    })
    expect(stale.statusCode).toBe(412)
    expect((await request('GET', '/measurement-plan/draft')).json()).toMatchObject({
      etag: session.etag,
      draft: { authoring: { groups: [group] } },
    })

    await session.run('upsert-group', { group: { ...group, competitors: [] } })
    expect((await request('GET', '/measurement-plan/draft')).json().draft.authoring.groups[0].competitors).toEqual([])

    const validEtag = session.etag
    const invalid = await action('upsert-group', {
      ifMatch: validEtag,
      payload: { group: { ...group, competitors: [{ ...group.competitors[0], domain: 'not a host' }] } },
    })
    expect(invalid.statusCode).toBe(400)
    expect((await request('GET', '/measurement-plan/draft')).json()).toMatchObject({
      etag: validEtag,
      draft: { authoring: { groups: [{ ...group, competitors: [] }] } },
    })
  })
})

describe('measurement draft previews', () => {
  it('previews and atomically applies reviewed CSV group membership', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    const csv = 'property,group\nWidgets,Dallas\nGadgets,Dallas'
    const before = db.select().from(measurementPlanDrafts).get()!

    const preview = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
      payload: { csv },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(measurementDraftPreviewGroupMembershipResponseSchema.safeParse(preview.json()).success).toBe(true)
    expect(preview.json()).toMatchObject({
      draftEtag: session.etag,
      counts: { matchedRows: 2, groupsReady: 1, needsAttention: 0, addedMemberships: 2 },
      rows: [
        { dataRow: 1, status: 'matched', targetKey: 'widgets', groupKey: 'group-dallas' },
        { dataRow: 2, status: 'matched', targetKey: 'gadgets', groupKey: 'group-dallas' },
      ],
    })
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(before)

    const applied = await action('apply-group-membership', {
      ifMatch: session.etag,
      payload: {
        csv,
        sourceChecksum: preview.json().sourceChecksum,
        previewChecksum: preview.json().previewChecksum,
        acceptedRows: [1, 2],
      },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(measurementDraftApplyGroupMembershipResponseSchema.safeParse(applied.json()).success).toBe(true)
    expect(applied.json()).toMatchObject({
      changed: true,
      appliedRows: 2,
      addedMemberships: 2,
      unchangedMemberships: 0,
      counts: { groups: 1 },
    })
    expect((await request('GET', '/measurement-plan/draft')).json().draft.authoring.groups).toEqual([{
      stableKey: 'group-dallas',
      label: 'Dallas',
      targetKeys: ['widgets', 'gadgets'],
      competitors: [],
    }])
  })

  it('rejects stale CSV previews and oversized CSV fields without changing the draft', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    const csv = 'property,group\nWidgets,Dallas'
    const preview = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
      payload: { csv },
    })
    const before = db.select().from(measurementPlanDrafts).get()!
    const stale = await action('apply-group-membership', {
      ifMatch: session.etag,
      payload: {
        csv,
        sourceChecksum: preview.json().sourceChecksum,
        previewChecksum: '0'.repeat(64),
        acceptedRows: [1],
      },
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { importCode: 'preview-checksum-mismatch' } } })
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(before)

    const tooLarge = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
      payload: { csv: `property,group\n${'a'.repeat(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES)},Dallas` },
    })
    expect(tooLarge.statusCode, tooLarge.body).toBe(413)
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(before)
  })

  it('rate-limits each expensive preview per authenticated caller', async () => {
    await readyDraft()
    const assignmentPayload = {
      targetKeys: ['widgets'],
      queryIds: [queryId('widget delivery times')],
    }
    const groupPayload = { csv: 'property,group\nWidgets,Dallas' }

    for (let index = 0; index < 30; index += 1) {
      const response = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
        payload: assignmentPayload,
      })
      expect(response.statusCode, response.body).toBe(200)
    }

    const limited = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
      payload: assignmentPayload,
    })
    expect(limited.statusCode, limited.body).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    expect(limited.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })

    for (let index = 0; index < 30; index += 1) {
      const response = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
        payload: groupPayload,
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const groupLimited = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
      payload: groupPayload,
    })
    expect(groupLimited.statusCode, groupLimited.body).toBe(429)
    expect(groupLimited.headers['retry-after']).toBeDefined()

    const secondKey = 'cnry_draft_second'
    seedKey('second', secondKey, ['*'])
    const independent = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
      token: secondKey,
      payload: assignmentPayload,
    })
    expect(independent.statusCode, independent.body).toBe(200)
    const independentGroup = await request('POST', '/measurement-plan/draft/actions/preview-group-membership', {
      token: secondKey,
      payload: groupPayload,
    })
    expect(independentGroup.statusCode, independentGroup.body).toBe(200)
  })

  it('previews a server-resolved audience with exact assignment and provider impact without writing', async () => {
    const session = await readyDraft()
    await session.run('upsert-target', { target: GADGETS_TARGET })
    await session.run('upsert-group', {
      group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets', 'gadgets'] },
    })
    const delivery = queryId('widget delivery times')
    const beforeDraft = db.select().from(measurementPlanDrafts).get()!
    const beforeAudits = db.select().from(auditLog).all()
    const beforeReceipts = db.select().from(measurementOperationReceipts).all()

    const preview = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
      payload: { groupKeys: ['catalog'], queryIds: [delivery] },
    })

    expect(preview.statusCode, preview.body).toBe(200)
    expect(measurementDraftPreviewAssignmentsResponseSchema.safeParse(preview.json()).success).toBe(true)
    expect(preview.headers.etag).toBe(session.etag)
    expect(preview.json()).toEqual(expect.objectContaining({
      draftEtag: session.etag,
      groups: [{ groupKey: 'catalog', label: 'Catalog', memberCount: 2 }],
      resolvedTargetKeys: ['gadgets', 'widgets'],
      overlapCount: 0,
      assignments: { requested: 2, added: 2, alreadyPresent: 0 },
      execution: { addedNodes: 1, addedProviderCalls: 2, fullRunNodes: 3, fullRunProviderCalls: 6 },
    }))
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(beforeDraft)
    expect(db.select().from(auditLog).all()).toEqual(beforeAudits)
    expect(db.select().from(measurementOperationReceipts).all()).toEqual(beforeReceipts)

    await session.run('apply-assignments', { groupKeys: ['catalog'], queryIds: [delivery] })
    expect((await request('GET', '/measurement-plan/draft/assignments')).json().items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ targetKey: 'widgets', queryId: delivery }),
        expect.objectContaining({ targetKey: 'gadgets', queryId: delivery }),
      ]))
  })

  it('previews assignment execution even when an unrelated group competitor needs review', async () => {
    const session = await readyDraft()
    await session.run('upsert-group', {
      group: {
        stableKey: 'dallas',
        label: 'Dallas',
        targetKeys: ['widgets'],
        competitors: [{
          stableKey: 'northwind',
          label: 'Northwind',
          domain: 'northwind.example',
          aliases: [],
        }],
      },
    })
    const compile = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(compile.json()).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([expect.objectContaining({ ruleId: 'competitor-matches-project' })]),
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
      payload: { groupKeys: ['dallas'], queryIds: [queryId('widget delivery times')] },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ assignments: { requested: 1 } })
  })

  it('reports 58 Property assignments as four provider calls for a 29-Property group', async () => {
    const session = await readyDraft()
    const targetKeys = ['widgets']
    for (let index = 2; index <= 29; index += 1) {
      const stableKey = `property-${String(index).padStart(2, '0')}`
      targetKeys.push(stableKey)
      await session.run('upsert-target', {
        target: {
          stableKey,
          label: `Property ${index}`,
          status: 'included',
          aliases: [`Property ${index}`],
          urlMatchers: [`https://northwind.example/${stableKey}`],
          source: 'manual',
        },
      })
    }
    await session.run('upsert-group', {
      group: { stableKey: 'dallas', label: 'Dallas', targetKeys },
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/preview-assignments', {
      payload: {
        groupKeys: ['dallas'],
        queryIds: [queryId('best widget supplier'), queryId('northwind widget reviews')],
      },
    })

    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      resolvedTargetKeys: expect.arrayContaining(targetKeys),
      assignments: { requested: 58, added: 56, alreadyPresent: 2 },
      execution: { addedNodes: 0, addedProviderCalls: 0, fullRunNodes: 2, fullRunProviderCalls: 4 },
    })
  })

  it('applies the 5,000 ceiling after group expansion and refuses preview and mutation atomically', async () => {
    const etag = await createDraft()
    const row = db.select().from(measurementPlanDrafts).get()!
    const targetKeys = Array.from({ length: 1_700 }, (_, index) => `property-${index + 1}`)
    const authoring = {
      defaultContext: { providers: ['gemini', 'openai'], locations: ['nyc'] },
      targets: targetKeys.map((stableKey, index) => ({
        stableKey,
        label: `Property ${index + 1}`,
        status: 'included',
        aliases: [],
        urlMatchers: [`https://northwind.example/${stableKey}`],
        source: 'manual',
      })),
      assignments: [],
      groups: [{ stableKey: 'big', label: 'Big', targetKeys, competitors: [] }],
    }
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()
    const payload = { groupKeys: ['big'], queryIds: tracked.map(query => query.id) }

    const preview = await request('POST', '/measurement-plan/draft/actions/preview-assignments', { payload })
    const applied = await action('apply-assignments', { payload, ifMatch: etag })

    expect(preview.statusCode, preview.body).toBe(400)
    expect(applied.statusCode, applied.body).toBe(400)
    expect(preview.json().error.message).toBe(applied.json().error.message)
    expect(preview.json().error.message).toContain('5,100 assignments')
    expect(preview.json().error.message).toContain('5,000 limit')
    expect(JSON.parse(db.select().from(measurementPlanDrafts).get()!.authoringJson).assignments).toEqual([])
  })

  it('compiles the stored draft, carries the compiled checksum and writes nothing', async () => {
    const session = await readyDraft()
    const before = db.select().from(measurementPlanDrafts).get()!

    const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(compiled.statusCode, compiled.body).toBe(200)
    expect(measurementDraftCompilePreviewResponseSchema.safeParse(compiled.json()).success).toBe(true)
    expect(compiled.json()).toMatchObject({
      ok: true,
      compiledChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      counts: { includedTargets: 1, assignments: 2, unclassifiedAssignments: 0 },
    })
    expect(compiled.json().plan.executionNodes).toHaveLength(2)
    expect(compiled.json().plan.executionNodes[0].context).toMatchObject({
      providers: ['gemini', 'openai'],
      models: { gemini: 'gemini-test', openai: 'gpt-test' },
      location: { label: 'nyc' },
    })

    const diffed = await request('POST', '/measurement-plan/draft/actions/diff-preview', { payload: {} })
    expect(diffed.statusCode, diffed.body).toBe(200)
    expect(measurementDraftDiffPreviewResponseSchema.safeParse(diffed.json()).success).toBe(true)
    expect(diffed.json()).toMatchObject({
      ok: true,
      compiledChecksum: compiled.json().compiledChecksum,
      diff: { activeRevision: null, targets: { added: ['widgets'], removed: [], changed: [], unchanged: [] } },
    })

    // Neither preview may touch the draft, so neither may move the ETag.
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(before)
    expect((await request('GET', '/measurement-plan/draft')).json().etag).toBe(session.etag)
  })

  it('compiles the same content to the same checksum whatever order it was authored in', async () => {
    const first = await readyDraft()
    const checksum = (await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })).json().compiledChecksum
    await first.run('discard', {})

    const second = await DraftSession.start()
    await second.run('upsert-target', { target: WIDGETS_TARGET })
    await second.run('apply-assignments', { targetKey: 'widgets', queryIds: [queryId('northwind widget reviews')] })
    await second.run('apply-assignments', { targetKey: 'widgets', queryIds: [queryId('best widget supplier')] })
    expect((await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })).json().compiledChecksum).toBe(checksum)
  })

  it('reports every fixable problem as a typed check instead of compiling', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: { ...WIDGETS_TARGET, urlMatchers: ['https://not-northwind.example/widgets/*'] } })
    const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(compiled.json()).toMatchObject({ ok: false, compiledChecksum: null })
    expect(compiled.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'target-url-matcher-unowned', severity: 'fail', path: ['targets', 0, 'urlMatchers', 0] }),
    ]))
  })

  it('blocks publish when included sitemap Targets claim the same normalized alias', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', {
      target: { ...WIDGETS_TARGET, source: 'sitemap', aliases: ['Northwind Widgets'] },
    })
    await session.run('upsert-target', {
      target: { ...GADGETS_TARGET, source: 'sitemap', aliases: ['northwind-widgets'] },
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      ok: false,
      compiledChecksum: null,
      checks: expect.arrayContaining([expect.objectContaining({
        ruleId: 'target-alias-ambiguous',
        severity: 'fail',
        path: ['targets', 1, 'aliases', 0],
      })]),
    })

    const publish = await action('publish', {
      payload: { expectedActiveRevision: null, expectedCompiledChecksum: 'a'.repeat(64) },
      ifMatch: session.etag,
    })
    expect(publish.statusCode, publish.body).toBe(400)
    expect(publish.json().error.details.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'target-alias-ambiguous', severity: 'fail' }),
    ]))
    expect(db.select().from(measurementPlanVersions).all()).toEqual([])
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
  })

  it('allows a normalized sitemap alias collision when only one Target is included', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', {
      target: { ...WIDGETS_TARGET, source: 'sitemap', aliases: ['Northwind Widgets'] },
    })
    await session.run('upsert-target', {
      target: { ...GADGETS_TARGET, status: 'excluded', source: 'sitemap', aliases: ['northwind-widgets'] },
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true, plan: { targets: [{ stableKey: 'widgets' }] } })
    expect(preview.json().checks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'target-alias-ambiguous' }),
    ]))
  })

  it('allows aliases with distinct scorer token sequences', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', {
      target: { ...WIDGETS_TARGET, source: 'sitemap', aliases: ['North Park'] },
    })
    await session.run('upsert-target', {
      target: { ...GADGETS_TARGET, source: 'sitemap', aliases: ['Northpark'] },
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ ok: true })
    expect(preview.json().checks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'target-alias-ambiguous' }),
    ]))
  })
})

/** Compiles the current draft and publishes it under both guards the transaction requires. */
async function publish(session: DraftSession, expectedActiveRevision: number | null) {
  const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
  expect(compiled.statusCode, compiled.body).toBe(200)
  return action('publish', {
    payload: { expectedActiveRevision, expectedCompiledChecksum: compiled.json().compiledChecksum },
    ifMatch: session.etag,
  })
}

describe('measurement draft publish', () => {
  it('publishes the reviewed content in one transaction and clears the draft', async () => {
    const session = await readyDraft()
    const published = await publish(session, null)
    expect(published.statusCode, published.body).toBe(200)
    expect(measurementPlanV2PublishResponseSchema.safeParse(published.json()).success).toBe(true)
    expect(published.json()).toMatchObject({ published: true, active: { revision: 1 } })

    const versions = db.select().from(measurementPlanVersions).all()
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      revision: 1,
      schemaVersion: 2,
      compiledChecksum: published.json().active.compiledChecksum,
      sourceDraftId: expect.any(String),
    })
    // `checksum` is document identity and `compiled_checksum` is the review
    // guard; conflating them is what §0.45 forbids.
    expect(versions[0]!.checksum).not.toBe(versions[0]!.compiledChecksum)
    expect(db.select().from(measurementPlans).all()).toHaveLength(1)
    expect(db.select().from(measurementPlanDrafts).all()).toEqual([])
    expect(db.select().from(auditLog).where(eq(auditLog.action, 'measurement-draft.published')).all()).toHaveLength(1)

    const active = await request('GET', '/measurement-plan')
    expect(active.statusCode, active.body).toBe(200)
    expect(measurementPlanResponseSchema.safeParse(active.json()).success).toBe(true)
    expect(active.json().active.plan.schemaVersion).toBe(2)
    const detail = await request('GET', '/measurement-plan/versions/1')
    expect(detail.statusCode, detail.body).toBe(200)
    expect(measurementPlanVersionResponseSchema.safeParse(detail.json()).success).toBe(true)
    expect(detail.json().version.plan.schemaVersion).toBe(2)

    // Publishing never starts a run.
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('refuses content that changed after review and preserves the draft', async () => {
    const session = await readyDraft()
    const stale = '0'.repeat(64)
    const refused = await action('publish', {
      payload: { expectedActiveRevision: null, expectedCompiledChecksum: stale },
      ifMatch: session.etag,
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: { code: 'MEASUREMENT_COMPILED_CHECKSUM_CONFLICT' } })
    expect(db.select().from(measurementPlanVersions).all()).toEqual([])
    expect(db.select().from(measurementPlans).all()).toEqual([])
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
    expect(db.select().from(measurementSegments).all()).toEqual([])
  })

  it('refuses a moved pointer and an unclassified assignment, writing nothing either way', async () => {
    const session = await readyDraft()
    const moved = await action('publish', {
      payload: { expectedActiveRevision: 7, expectedCompiledChecksum: '0'.repeat(64) },
      ifMatch: session.etag,
    })
    expect(moved.statusCode).toBe(409)
    expect(moved.json()).toMatchObject({ error: { code: 'MEASUREMENT_PLAN_REVISION_CONFLICT' } })

    await session.run('upsert-target', { target: GADGETS_TARGET })
    db.insert(queries).values({ id: 'qry_orphan', projectId: 'prj_northwind', query: 'gadget lead times', createdAt: NOW }).run()
    await session.run('apply-assignments', { targetKey: 'gadgets', queryIds: ['qry_orphan'] })
    // Force the state publish validation exists to catch.
    const row = db.select().from(measurementPlanDrafts).get()!
    const authoring = JSON.parse(row.authoringJson)
    authoring.assignments[2].queryClass = 'unclassified'
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()

    // A syntactically valid checksum, so the request reaches the recompile the
    // publish transaction performs rather than stopping at body validation.
    const refused = await action('publish', {
      payload: { expectedActiveRevision: null, expectedCompiledChecksum: 'a'.repeat(64) },
      ifMatch: session.etag,
    })
    expect(refused.statusCode, refused.body).toBe(400)
    expect(refused.json().error.details.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'assignment-unclassified', severity: 'fail' }),
    ]))
    expect(db.select().from(measurementPlanVersions).all()).toEqual([])
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
  })

  it('treats content identical to the active revision as a no-op and identical to an older one as a revert', async () => {
    const first = await readyDraft()
    expect((await publish(first, null)).json()).toMatchObject({ published: true, active: { revision: 1 } })
    const revisionOne = db.select().from(measurementPlanVersions).get()!

    // B: one more Target on top of A.
    const second = await DraftSession.start(1)
    await second.run('upsert-target', { target: GADGETS_TARGET })
    await second.run('apply-assignments', { targetKey: 'gadgets', queryIds: [queryId('widget delivery times')] })
    expect((await publish(second, 1)).json()).toMatchObject({ published: true, active: { revision: 2 } })

    // Republishing B unchanged is a no-op that returns the active revision.
    const third = await DraftSession.start(2)
    const noop = await publish(third, 2)
    expect(noop.statusCode, noop.body).toBe(200)
    expect(noop.json()).toMatchObject({ published: false, active: { revision: 2 } })
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(2)
    expect(db.select().from(measurementPlanDrafts).all()).toEqual([])

    // Back to A. Identical to revision 1, so it publishes as revision 3 rather
    // than colliding: a revert is a first-class operation (§0.1).
    const fourth = await DraftSession.start(2)
    await fourth.run('clear-assignments', { targetKey: 'gadgets' })
    await fourth.run('merge-targets', { targetKey: 'widgets', mergedKeys: ['gadgets'] })
    await fourth.run('upsert-target', { target: WIDGETS_TARGET })
    const reverted = await publish(fourth, 2)
    expect(reverted.statusCode, reverted.body).toBe(200)
    expect(reverted.json()).toMatchObject({ published: true, active: { revision: 3 } })
    expect(reverted.json().active.compiledChecksum).toBe(revisionOne.compiledChecksum)
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(3)
  })

  it('round-trips frozen heterogeneous execution contexts and query provenance from an active v2 plan', async () => {
    const initialDraft = await readyDraft()
    const initialPublish = await publish(initialDraft, null)
    expect(initialPublish.statusCode, initialPublish.body).toBe(200)

    const sourceQueryId = queryId('best widget supplier')
    const sourceQueryText = 'best widget supplier'
    const version = db.select().from(measurementPlanVersions).get()!
    const active = measurementPlanV2Schema.parse(JSON.parse(version.canonicalJson))
    const originalAssignment = active.assignments.find(assignment => assignment.queryId === sourceQueryId)!
    const namedContext = active.executionNodes.find(node => node.stableKey === originalAssignment.executionNodeKey)!.context
    const nullContext = { providers: ['openai'] as const, models: {}, location: null }
    const executionKey = (context: typeof namedContext) => `execution-${sha256Hex(canonicalJson({
      queryId: sourceQueryId,
      location: context.location
        ? [context.location.label, context.location.city, context.location.region, context.location.country].join('\u0000')
        : '',
      providers: [...context.providers].sort(),
      models: context.models,
    }))}`
    const namedKey = executionKey(namedContext)
    const nullKey = executionKey(nullContext)
    const plan = measurementPlanV2Schema.parse({
      ...active,
      querySnapshots: active.querySnapshots.map(snapshot => ({
        ...snapshot,
        ...(snapshot.queryId === sourceQueryId
          ? { provenance: { source: 'discovery', sourceId: 'discovery-1', capturedAt: '1970-01-01T00:00:00.000Z' } }
          : { provenance: { source: 'research', sourceId: 'research-1', capturedAt: '1970-01-01T00:00:00.000Z' } }),
      })),
      assignments: [
        ...active.assignments.filter(assignment => assignment.queryId !== sourceQueryId),
        { ...originalAssignment, executionNodeKey: namedKey },
        { ...originalAssignment, executionNodeKey: nullKey },
      ],
      executionNodes: [
        ...active.executionNodes.filter(node => node.queryId !== sourceQueryId),
        { stableKey: namedKey, queryId: sourceQueryId, queryText: sourceQueryText, context: namedContext, expectedSnapshots: namedContext.providers.length },
        { stableKey: nullKey, queryId: sourceQueryId, queryText: sourceQueryText, context: nullContext, expectedSnapshots: nullContext.providers.length },
      ],
      usageEdges: [
        ...active.usageEdges.filter(edge => edge.queryId !== sourceQueryId),
        { executionNodeKey: namedKey, targetKey: originalAssignment.targetKey, queryId: sourceQueryId },
        { executionNodeKey: nullKey, targetKey: originalAssignment.targetKey, queryId: sourceQueryId },
      ],
      compiledChecksum: '0'.repeat(64),
    })
    const frozen = measurementPlanV2Schema.parse({
      ...plan,
      compiledChecksum: sha256Hex(measurementPlanV2ChecksumJson(plan)),
    })
    const frozenJson = canonicalMeasurementPlanV2Json(frozen)
    db.update(measurementPlanVersions).set({
      canonicalJson: frozenJson,
      checksum: sha256Hex(frozenJson),
      compiledChecksum: frozen.compiledChecksum,
    }).where(eq(measurementPlanVersions.id, version.id)).run()

    const seeded = await DraftSession.start(1)
    const loaded = await request('GET', '/measurement-plan/draft')
    const sourceAssignment = loaded.json().draft.authoring.assignments
      .find((assignment: { queryId: string }) => assignment.queryId === sourceQueryId)
    expect(sourceAssignment).toMatchObject({
      queryClass: originalAssignment.queryClass,
      classificationSource: 'operator',
      executionContexts: expect.arrayContaining([namedContext, nullContext]),
      queryProvenance: { source: 'discovery', sourceId: 'discovery-1', capturedAt: '1970-01-01T00:00:00.000Z' },
    })

    // A routine audience reapply without a context override must leave the
    // frozen list untouched; it is not permission to expand defaults.
    const reapplied = await seeded.run('apply-assignments', {
      targetKey: originalAssignment.targetKey,
      queryIds: [sourceQueryId],
    })
    expect(reapplied.json()).toMatchObject({ changed: false, etag: '"mpd_1"' })

    // A frozen active override may name a provider outside an operator's new
    // default selection. Defaults are not a provider registry, so this must
    // retain the exact old node rather than reject or remap it.
    const draftRowBeforePreview = db.select().from(measurementPlanDrafts).get()!
    const authoringWithNarrowerDefault = JSON.parse(draftRowBeforePreview.authoringJson)
    authoringWithNarrowerDefault.defaultContext.providers = ['gemini']
    authoringWithNarrowerDefault.defaultContext.models = { gemini: 'gemini-test' }
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoringWithNarrowerDefault) })
      .where(eq(measurementPlanDrafts.id, draftRowBeforePreview.id)).run()

    const preview = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(canonicalMeasurementPlanV2Json(preview.json().plan)).toBe(frozenJson)
    expect(preview.json().plan.executionNodes.map((node: { stableKey: string }) => node.stableKey).sort()).toEqual(
      frozen.executionNodes.map(node => node.stableKey).sort(),
    )

    const noOp = await publish(seeded, 1)
    expect(noOp.statusCode, noOp.body).toBe(200)
    expect(noOp.json()).toMatchObject({ published: false, active: { revision: 1, compiledChecksum: frozen.compiledChecksum } })
    expect(db.select().from(measurementPlanVersions).all()).toHaveLength(1)
  })

  it('links a cosmetic publish to the revision it supersedes and withholds the link when execution changes', async () => {
    const first = await readyDraft()
    expect((await publish(first, null)).json()).toMatchObject({ published: true, active: { revision: 1 } })
    const revisionOne = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 1)).get()!
    // A first revision supersedes nothing, so it has nothing to compare with.
    expect(revisionOne.comparableToVersionId).toBeNull()

    // A label-only rename changes the compiled checksum but not one provider
    // call, so the new revision records the one it stays comparable with.
    const second = await DraftSession.start(1)
    await second.run('upsert-target', { target: { ...WIDGETS_TARGET, label: 'Widgets Renamed' } })
    expect((await publish(second, 1)).json()).toMatchObject({ published: true, active: { revision: 2 } })
    const revisionTwo = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 2)).get()!
    expect(revisionTwo.comparableToVersionId).toBe(revisionOne.id)

    // A second label-only publish chains one step at a time: each link names
    // the revision it directly superseded.
    const third = await DraftSession.start(2)
    await third.run('upsert-target', { target: { ...WIDGETS_TARGET, label: 'Widgets Renamed Again' } })
    expect((await publish(third, 2)).json()).toMatchObject({ published: true, active: { revision: 3 } })
    const revisionThree = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 3)).get()!
    expect(revisionThree.comparableToVersionId).toBe(revisionTwo.id)

    // An ALIAS edit leaves every execution node byte-identical, but it changes
    // what stored answers MEAN: the reads re-match mention against the active
    // plan's aliases, so linking here would flip old evidence to "mentioned"
    // with zero new measurement. Meaning changes never link.
    const aliasEdit = await DraftSession.start(3)
    await aliasEdit.run('upsert-target', {
      target: { ...WIDGETS_TARGET, label: 'Widgets Renamed Again', aliases: ['Northwind Widgets', 'NW Widgets'] },
    })
    expect((await publish(aliasEdit, 3)).json()).toMatchObject({ published: true, active: { revision: 4 } })
    const aliasRevision = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 4)).get()!
    expect(aliasRevision.comparableToVersionId).toBeNull()

    // A queryClass flip is the same trap one field over: the class lives on
    // the assignment, not the execution node, and repools the basket a stored
    // answer counts against. Never linked.
    const classFlip = await DraftSession.start(4)
    await classFlip.run('classify-assignments', {
      queryClass: 'branded',
      assignments: [{ targetKey: 'widgets', queryId: queryId('best widget supplier') }],
    })
    expect((await publish(classFlip, 4)).json()).toMatchObject({ published: true, active: { revision: 5 } })
    const classRevision = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 5)).get()!
    expect(classRevision.comparableToVersionId).toBeNull()

    // Adding a Target with an assignment adds execution nodes. The prior runs
    // did not measure them, so this publish keeps today's blank-until-swept
    // semantics: no link.
    const fourth = await DraftSession.start(5)
    await fourth.run('upsert-target', { target: GADGETS_TARGET })
    await fourth.run('apply-assignments', { targetKey: 'gadgets', queryIds: [queryId('widget delivery times')] })
    expect((await publish(fourth, 5)).json()).toMatchObject({ published: true, active: { revision: 6 } })
    const revisionSix = db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.revision, 6)).get()!
    expect(revisionSix.comparableToVersionId).toBeNull()
  })

  it('replaces a query by creating a new catalog identity and transfers only its exact draft assignments', async () => {
    const session = await DraftSession.start()
    const sourceId = queryId('best widget supplier')
    const unrelatedId = queryId('widget delivery times')
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    await session.run('apply-assignments', {
      targetKey: 'widgets',
      queryIds: [sourceId, unrelatedId],
      contextOverride: { providers: ['openai'], models: { openai: 'gpt-test' }, locations: ['nyc'] },
    })
    await session.run('apply-assignments', {
      targetKey: 'gadgets',
      queryIds: [sourceId],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
    })
    await session.run('classify-assignments', {
      queryClass: 'branded',
      assignments: [{ targetKey: 'widgets', queryId: sourceId }],
    })
    await session.run('classify-assignments', {
      queryClass: 'non-brand',
      assignments: [{ targetKey: 'gadgets', queryId: sourceId }],
    })
    const before = JSON.parse(db.select().from(measurementPlanDrafts).get()!.authoringJson)
    const sourceAssignments = before.assignments.filter((assignment: { queryId: string }) => assignment.queryId === sourceId)

    const replaced = await action('replace-query', {
      payload: { queryId: sourceId, queryText: 'best luxury widget suppliers' },
      ifMatch: session.etag,
      idempotencyKey: 'replace-source-query',
    })
    expect(replaced.statusCode, replaced.body).toBe(200)
    expect(measurementDraftReplaceQueryResponseSchema.safeParse(replaced.json()).success).toBe(true)
    expect(replaced.json()).toMatchObject({ previousQueryId: sourceId, changed: true, etag: '"mpd_8"' })
    const replacementId = replaced.json().replacementQuery.id as string
    expect(replacementId).not.toBe(sourceId)
    expect(replaced.json().replacementQuery).toMatchObject({ query: 'best luxury widget suppliers', createdAt: expect.any(String) })

    // The source catalog identity and every unrelated authoring row remain.
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({ query: 'best widget supplier' })
    expect(db.select().from(queries).where(eq(queries.id, replacementId)).get()).toMatchObject({
      projectId: 'prj_northwind', query: 'best luxury widget suppliers', provenance: 'measurement-draft:replace-query',
    })
    const after = JSON.parse(db.select().from(measurementPlanDrafts).get()!.authoringJson)
    expect(after.assignments.filter((assignment: { queryId: string }) => assignment.queryId === sourceId)).toEqual([])
    expect(after.assignments.filter((assignment: { queryId: string }) => assignment.queryId === replacementId)).toEqual(
      sourceAssignments.map((assignment: Record<string, unknown>) => ({ ...assignment, queryId: replacementId })),
    )
    expect(after.assignments.find((assignment: { queryId: string }) => assignment.queryId === unrelatedId)).toEqual(
      before.assignments.find((assignment: { queryId: string }) => assignment.queryId === unrelatedId),
    )
    expect(db.select().from(auditLog).where(eq(auditLog.action, 'measurement-draft.replace-query')).all()).toHaveLength(1)
  })

  it('makes same-text replacement a true no-op and replays a successful replacement without duplicate rows', async () => {
    const sameText = await readyDraft()
    const sourceId = queryId('best widget supplier')
    const catalogBefore = db.select().from(queries).all()
    const noOp = await action('replace-query', {
      payload: { queryId: sourceId, queryText: 'best widget supplier' },
      ifMatch: sameText.etag,
      idempotencyKey: 'replace-same-text',
    })
    expect(noOp.statusCode, noOp.body).toBe(200)
    expect(noOp.json()).toMatchObject({ changed: false, etag: sameText.etag, previousQueryId: sourceId, replacementQuery: { id: sourceId } })
    expect(db.select().from(queries).all()).toEqual(catalogBefore)

    const retryDraft = sameText
    const retrySourceId = sourceId
    const first = await action('replace-query', {
      payload: { queryId: retrySourceId, queryText: 'best independent widget suppliers' },
      ifMatch: retryDraft.etag,
      idempotencyKey: 'replace-retry',
    })
    expect(first.statusCode, first.body).toBe(200)
    const replay = await action('replace-query', {
      payload: { queryId: retrySourceId, queryText: 'best independent widget suppliers' },
      ifMatch: retryDraft.etag,
      idempotencyKey: 'replace-retry',
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(db.select().from(queries).where(eq(queries.query, 'best independent widget suppliers')).all()).toHaveLength(1)
  })

  it('rechecks a receipt inside the immediate transaction before a concurrent retry sees a stale ETag', async () => {
    const session = await readyDraft()
    const sourceId = queryId('best widget supplier')
    const payload = { queryId: sourceId, queryText: 'best concurrent widget suppliers' }
    const first = await action('replace-query', {
      payload,
      ifMatch: session.etag,
      idempotencyKey: 'replace-concurrent-winner',
    })
    expect(first.statusCode, first.body).toBe(200)

    // Simulate the narrow interval after beginMutation's receipt lookup but
    // before this call acquires its transaction. The stored response matches
    // the same request, while the draft ETag has already advanced.
    const retryKey = 'replace-concurrent-retry'
    const originalTransaction = db.transaction.bind(db)
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementationOnce((callback, config) =>
      originalTransaction((tx) => {
        tx.insert(measurementOperationReceipts).values({
          projectId: 'prj_northwind',
          operation: 'replace-query',
          idempotencyKey: retryKey,
          requestChecksum: requestChecksum(payload),
          responseJson: first.body,
          statusCode: 200,
          createdAt: NOW,
          expiresAt: '2030-01-01T00:00:00.000Z',
        }).run()
        return callback(tx)
      }, config),
    )
    try {
      const replay = await action('replace-query', {
        payload,
        ifMatch: session.etag,
        idempotencyKey: retryKey,
      })
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json()).toEqual(first.json())
    } finally {
      transactionSpy.mockRestore()
    }

    expect(db.select().from(queries).where(eq(queries.query, payload.queryText)).all()).toHaveLength(1)
  })

  it('refuses stale, colliding, foreign, and unassigned sources without creating a catalog row', async () => {
    const session = await readyDraft()
    const sourceId = queryId('best widget supplier')
    const beforeQueries = db.select().from(queries).all()
    const beforeDraft = db.select().from(measurementPlanDrafts).get()!
    const stale = await action('replace-query', {
      payload: { queryId: sourceId, queryText: 'stale replacement' },
      ifMatch: '"mpd_999"',
      idempotencyKey: 'replace-stale',
    })
    expect(stale.statusCode).toBe(412)
    expect(db.select().from(queries).all()).toEqual(beforeQueries)
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(beforeDraft)
    expect(db.select().from(measurementOperationReceipts)
      .where(eq(measurementOperationReceipts.operation, 'replace-query')).all()).toEqual([])

    const collision = await action('replace-query', {
      payload: { queryId: sourceId, queryText: '  NORTHWIND WIDGET REVIEWS  ' },
      ifMatch: session.etag,
      idempotencyKey: 'replace-collision',
    })
    expect(collision.statusCode).toBe(400)
    expect(collision.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { displayToOperator: true } } })
    expect(db.select().from(queries).all()).toEqual(beforeQueries)

    const unassigned = await action('replace-query', {
      payload: { queryId: queryId('widget delivery times'), queryText: 'unassigned source' },
      ifMatch: session.etag,
      idempotencyKey: 'replace-unassigned',
    })
    expect(unassigned.statusCode).toBe(400)

    db.insert(projects).values({
      id: 'prj_other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example', ownedDomains: [],
      country: 'US', language: 'en', providers: [], providerModels: {}, locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(queries).values({ id: 'qry_foreign', projectId: 'prj_other', query: 'foreign query', createdAt: NOW }).run()
    const row = db.select().from(measurementPlanDrafts).get()!
    const foreignAuthoring = JSON.parse(row.authoringJson)
    foreignAuthoring.assignments[0].queryId = 'qry_foreign'
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(foreignAuthoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()
    const foreign = await action('replace-query', {
      payload: { queryId: 'qry_foreign', queryText: 'cannot claim foreign query' },
      ifMatch: session.etag,
      idempotencyKey: 'replace-foreign',
    })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json()).toMatchObject({ error: { details: { displayToOperator: true } } })
    expect(db.select().from(queries).where(eq(queries.query, 'cannot claim foreign query')).all()).toEqual([])
  })

  it('repairs an orphaned draft source and publishes a new revision while old evidence stays on the old query identity', async () => {
    const first = await readyDraft()
    const initial = await publish(first, null)
    expect(initial.statusCode, initial.body).toBe(200)
    const sourceId = queryId('best widget supplier')
    const versionOne = db.select().from(measurementPlanVersions).get()!
    db.insert(runs).values({
      id: 'run_old_query', projectId: 'prj_northwind', status: 'completed', measurementPlanVersionId: versionOne.id, createdAt: NOW,
    }).run()
    db.insert(querySnapshots).values({
      id: 'snap_old_query', runId: 'run_old_query', queryId: sourceId, queryText: 'best widget supplier', provider: 'openai',
      citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: NOW,
    }).run()

    const session = await DraftSession.start(1)
    const replaced = await action('replace-query', {
      payload: { queryId: sourceId, queryText: 'best premium widget supplier' },
      ifMatch: session.etag,
      idempotencyKey: 'replace-published-source',
    })
    expect(replaced.statusCode, replaced.body).toBe(200)
    session.etag = replaced.json().etag as string
    const replacementId = replaced.json().replacementQuery.id as string
    expect(db.select().from(measurementPlans).get()!.activeVersionId).toBe(versionOne.id)
    expect(db.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionOne.id)).get()!.canonicalJson)
      .toBe(versionOne.canonicalJson)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'snap_old_query')).get()).toMatchObject({
      queryId: sourceId, queryText: 'best widget supplier',
    })

    const second = await publish(session, 1)
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({ published: true, active: { revision: 2 } })
    const oldPlan = measurementPlanV2Schema.parse(JSON.parse(versionOne.canonicalJson))
    const newPlan = second.json().active.plan
    expect(oldPlan.querySnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ queryId: sourceId, queryText: 'best widget supplier' }),
    ]))
    expect(newPlan.querySnapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ queryId: replacementId, queryText: 'best premium widget supplier' }),
    ]))

    // An actual catalog orphan can still be repaired if its ID is genuinely in
    // the draft; no generic catalog rename/delete path is needed.
    const orphanDraft = await DraftSession.start(2)
    const orphanId = queryId('northwind widget reviews')
    db.delete(queries).where(eq(queries.id, orphanId)).run()
    const repaired = await action('replace-query', {
      payload: { queryId: orphanId, queryText: 'northwind premium widget reviews' },
      ifMatch: orphanDraft.etag,
      idempotencyKey: 'replace-orphan',
    })
    expect(repaired.statusCode, repaired.body).toBe(200)
    const orphanReplacementId = repaired.json().replacementQuery.id as string
    const authoring = JSON.parse(db.select().from(measurementPlanDrafts).get()!.authoringJson)
    expect(authoring.assignments.some((assignment: { queryId: string }) => assignment.queryId === orphanId)).toBe(false)
    expect(authoring.assignments.some((assignment: { queryId: string }) => assignment.queryId === orphanReplacementId)).toBe(true)
  })

  it('deletes only the active-plan pointer on deactivate', async () => {
    const session = await readyDraft()
    await publish(session, null)
    db.insert(runs).values({ id: 'run_1', projectId: 'prj_northwind', status: 'completed', createdAt: NOW }).run()
    db.insert(schedules).values({
      id: 'sch_1',
      projectId: 'prj_northwind',
      kind: 'answer-visibility',
      cronExpr: '0 9 * * *',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    const before = {
      versions: db.select().from(measurementPlanVersions).all(),
      segments: db.select().from(measurementSegments).all(),
      queries: db.select().from(queries).all(),
      runs: db.select().from(runs).all(),
      schedules: db.select().from(schedules).all(),
    }

    const wrongRevision = await request('POST', '/measurement-plan/actions/deactivate', { payload: { expectedActiveRevision: 9 } })
    expect(wrongRevision.statusCode).toBe(409)
    expect(db.select().from(measurementPlans).all()).toHaveLength(1)

    const deactivated = await request('POST', '/measurement-plan/actions/deactivate', { payload: { expectedActiveRevision: 1 } })
    expect(deactivated.statusCode, deactivated.body).toBe(200)
    expect(deactivated.json()).toEqual({ deactivated: true, previousRevision: 1 })
    expect(db.select().from(measurementPlans).all()).toEqual([])
    expect(db.select().from(measurementPlanVersions).all()).toEqual(before.versions)
    expect(db.select().from(measurementSegments).all()).toEqual(before.segments)
    expect(db.select().from(queries).all()).toEqual(before.queries)
    expect(db.select().from(runs).all()).toEqual(before.runs)
    expect(db.select().from(schedules).all()).toEqual(before.schedules)
  })
})

describe('measurement setup state', () => {
  it('returns exactly one state in the fixed precedence', async () => {
    const simple = await request('GET', '/measurement-setup')
    expect(measurementSetupResponseSchema.safeParse(simple.json()).success).toBe(true)
    expect(simple.json()).toMatchObject({ state: 'simple', nextAction: 'start_setup', mode: 'simple', activeRevision: null })

    const session = await readyDraft()
    expect((await request('GET', '/measurement-setup')).json()).toMatchObject({
      state: 'setup_in_progress',
      nextAction: 'continue_setup',
      mode: 'draft-only',
      draft: { etag: session.etag },
    })

    await publish(session, null)
    expect((await request('GET', '/measurement-setup')).json()).toMatchObject({
      state: 'awaiting_first_run',
      nextAction: 'run_measurement',
      mode: 'active-v2',
      activeRevision: 1,
      activeSchemaVersion: 2,
    })

    const active = db.select().from(measurementPlanVersions).get()!
    db.insert(runs).values({
      id: 'run_1',
      projectId: 'prj_northwind',
      kind: RunKinds['answer-visibility'],
      status: 'completed',
      trigger: RunTriggers.manual,
      measurementScope: null,
      measurementPlanVersionId: active.id,
      createdAt: NOW,
    }).run()
    expect((await request('GET', '/measurement-setup')).json()).toMatchObject({ state: 'operational', nextAction: 'view_measurement' })

    // A draft over an active v1 is republish_required: republishing is the
    // blocking action, so it outranks setup_in_progress. The draft is present
    // here on purpose — without it the precedence is untested.
    db.update(measurementPlanVersions).set({ schemaVersion: 1 }).where(eq(measurementPlanVersions.id, active.id)).run()
    await DraftSession.start(1)
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
    expect((await request('GET', '/measurement-setup')).json()).toMatchObject({
      state: 'republish_required',
      nextAction: 'republish_setup',
      mode: 'active-v1',
      activeSchemaVersion: 1,
    })
  })

  it('requires an official full completed run before reporting the active plan operational', async () => {
    const session = await readyDraft()
    await publish(session, null)
    const active = db.select().from(measurementPlanVersions).get()!
    db.insert(runs).values([
      {
        id: 'completed-probe',
        projectId: 'prj_northwind',
        kind: RunKinds['answer-visibility'],
        status: RunStatuses.completed,
        trigger: RunTriggers.probe,
        measurementScope: null,
        measurementPlanVersionId: active.id,
        createdAt: NOW,
      },
      {
        id: 'completed-scoped-run',
        projectId: 'prj_northwind',
        kind: RunKinds['answer-visibility'],
        status: RunStatuses.completed,
        trigger: RunTriggers.manual,
        measurementScope: { groups: [], targets: ['widgets'], queries: [], resolvedTargets: ['widgets'] },
        measurementPlanVersionId: active.id,
        createdAt: NOW,
      },
    ]).run()

    const setup = await request('GET', '/measurement-setup')

    expect(setup.statusCode, setup.body).toBe(200)
    expect(setup.json()).toMatchObject({
      state: 'awaiting_first_run',
      nextAction: 'run_measurement',
      mode: 'active-v2',
    })
  })
})

describe('measurement draft collections', () => {
  it('pages a large draft deterministically without truncating it', async () => {
    const session = await DraftSession.start()
    // 194 is the low end of the range §6 names; the ordering has to be stable
    // whatever order the rows were authored in.
    const labels = Array.from({ length: 194 }, (_, index) => `Property ${String(index).padStart(3, '0')}`)
    const row = db.select().from(measurementPlanDrafts).get()!
    const authoring = JSON.parse(row.authoringJson)
    authoring.targets = [...labels].reverse().map((label, index) => ({
      stableKey: `p${String(193 - index).padStart(3, '0')}`,
      label,
      status: 'included',
      aliases: [],
      urlMatchers: ['northwind.example'],
      source: 'manual',
    }))
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()
    void session

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const query: string = cursor === null ? '?limit=50' : `?limit=50&cursor=${encodeURIComponent(cursor)}`
      const response = await request('GET', `/measurement-plan/draft/targets${query}`)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().totalEstimate).toBe(194)
      for (const target of response.json().items) seen.push(target.label)
      cursor = response.json().nextCursor
      if (cursor === null) break
    }
    expect(seen).toEqual(labels)

    const searched = await request('GET', '/measurement-plan/draft/targets?search=PROPERTY%20007')
    expect(searched.json().items.map((target: { label: string }) => target.label)).toEqual(['Property 007'])
    expect((await request('GET', '/measurement-plan/draft/targets?limit=101')).statusCode).toBe(400)
  })

  it('pages assignments and groups from the same draft', async () => {
    const session = await readyDraft()
    await session.run('upsert-group', { group: { stableKey: 'catalog', label: 'Catalog', targetKeys: ['widgets'] } })
    await session.run('upsert-competitor', {
      groupKey: 'catalog',
      competitor: { stableKey: 'rival', label: 'Rival', domain: 'rival.example', aliases: ['Rival Supply'] },
    })

    const assignments = await request('GET', '/measurement-plan/draft/assignments?limit=1')
    expect(assignments.json().items).toHaveLength(1)
    expect(assignments.json().nextCursor).toEqual(expect.any(String))

    const groups = await request('GET', '/measurement-plan/draft/groups')
    expect(groups.json().items).toEqual([expect.objectContaining({
      stableKey: 'catalog',
      competitors: [expect.objectContaining({ stableKey: 'rival', domain: 'rival.example' })],
    })])

    await session.run('remove-competitor', { groupKey: 'catalog', competitorKey: 'rival' })
    expect((await request('GET', '/measurement-plan/draft/groups')).json().items[0].competitors).toEqual([])
  })
})

describe('measurement query assets', () => {
  it('holds ordered references and never deletes a query when the set goes', async () => {
    const first = queryId('best widget supplier')
    const second = queryId('widget delivery times')
    const created = await request('PUT', '/measurement-query-sets/qs-core', {
      payload: { name: 'Core basket', description: null, queryIds: [second, first] },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().items.map((item: { queryId: string }) => item.queryId)).toEqual([second, first])

    const replaced = await request('PUT', '/measurement-query-sets/qs-core', {
      payload: { name: 'Core basket', description: 'reordered', queryIds: [first, second] },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json().items.map((item: { queryId: string }) => item.queryId)).toEqual([first, second])
    expect((await request('GET', '/measurement-query-sets')).json().querySets).toEqual([
      expect.objectContaining({ id: 'qs-core', itemCount: 2 }),
    ])

    const missing = await request('PUT', '/measurement-query-sets/qs-bad', {
      payload: { name: 'Bad', queryIds: ['qry_nope'] },
    })
    expect(missing.statusCode).toBe(404)

    const queriesBefore = db.select().from(queries).all()
    expect((await request('DELETE', '/measurement-query-sets/qs-core')).statusCode).toBe(204)
    expect(db.select().from(queries).all()).toEqual(queriesBefore)
    expect((await request('GET', '/measurement-query-sets/qs-core')).statusCode).toBe(404)
  })

  it('expands a template additively and reports what already existed', async () => {
    const created = await request('PUT', '/measurement-query-templates/tpl-1', {
      payload: { name: 'Supplier questions', pattern: 'best {thing} supplier', variables: ['thing'] },
    })
    expect(created.statusCode, created.body).toBe(201)

    const mismatched = await request('PUT', '/measurement-query-templates/tpl-2', {
      payload: { name: 'Broken', pattern: 'best supplier', variables: ['thing'] },
    })
    expect(mismatched.statusCode).toBe(400)

    await request('PUT', '/measurement-query-sets/qs-core', { payload: { name: 'Core basket', queryIds: [] } })
    const applied = await request('POST', '/measurement-query-templates/tpl-1/apply', {
      payload: { bindings: [{ thing: 'widget' }, { thing: 'gadget' }], querySetId: 'qs-core' },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    // "best widget supplier" is already a project query, so it is reported
    // rather than duplicated.
    expect(applied.json().existing).toEqual([{ queryId: queryId('best widget supplier'), queryText: 'best widget supplier' }])
    expect(applied.json().created).toEqual([{ queryId: expect.any(String), queryText: 'best gadget supplier' }])
    expect(db.select().from(queries).where(eq(queries.query, 'best gadget supplier')).all()).toHaveLength(1)
    expect((await request('GET', '/measurement-query-sets/qs-core')).json().items.map((item: { queryText: string }) => item.queryText))
      .toEqual(['best widget supplier', 'best gadget supplier'])

    const missingBinding = await request('POST', '/measurement-query-templates/tpl-1/apply', {
      payload: { bindings: [{ other: 'widget' }] },
    })
    expect(missingBinding.statusCode).toBe(400)

    expect((await request('DELETE', '/measurement-query-templates/tpl-1')).statusCode).toBe(204)
    expect(db.select().from(queries).where(eq(queries.query, 'best gadget supplier')).all()).toHaveLength(1)
  })
})

describe('measurement operation receipts', () => {
  it('sweeps expired receipts so the table does not grow without bound', async () => {
    const session = await readyDraft()
    db.update(measurementOperationReceipts).set({ expiresAt: '2020-01-01T00:00:00.000Z' }).run()
    expect(db.select().from(measurementOperationReceipts).all().length).toBeGreaterThan(0)

    await session.run('rename-target', { targetKey: 'widgets', label: 'Widget range' })
    const remaining = db.select().from(measurementOperationReceipts).all()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.operation).toBe('rename-target')
  })
})

describe('measurement draft compiled checksum', () => {
  /** Rewrites the stored default context, which no typed action exposes. */
  function setDefaultContext(context: unknown) {
    const row = db.select().from(measurementPlanDrafts).get()!
    const authoring = JSON.parse(row.authoringJson)
    authoring.defaultContext = context
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()
  }

  async function compiledChecksum(): Promise<string> {
    const response = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().compiledChecksum as string
  }

  it('covers provider configuration, not only the assignment list', async () => {
    await readyDraft()
    const baseline = await compiledChecksum()

    // The same questions against a different model is different work, so the
    // guard the operator reviewed has to notice it.
    setDefaultContext({ providers: ['gemini', 'openai'], models: { gemini: 'gemini-next', openai: 'gpt-test' }, locations: ['nyc'] })
    const remodelled = await compiledChecksum()
    expect(remodelled).not.toBe(baseline)

    // Same configuration, written in another order on another machine.
    setDefaultContext({ providers: ['openai', 'gemini'], models: { openai: 'gpt-test', gemini: 'gemini-next' }, locations: ['nyc'] })
    expect(await compiledChecksum()).toBe(remodelled)

    setDefaultContext({ providers: ['gemini'], models: { gemini: 'gemini-next' }, locations: ['nyc'] })
    expect(await compiledChecksum()).not.toBe(remodelled)
  })

  it('hydrates a pre-fix empty default from the runnable roster and detects roster drift', async () => {
    const session = await readyDraft()
    db.update(projects).set({ providers: [] }).where(eq(projects.id, 'prj_northwind')).run()
    setDefaultContext({ providers: [], locations: ['nyc'] })
    runnableProviders = ['openai']

    const first = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ ok: true, compiledChecksum: expect.any(String) })
    expect(first.json().plan.executionNodes.map((node: { context: { providers: string[] } }) => node.context.providers))
      .toEqual([['openai'], ['openai']])

    runnableProviders = ['gemini', 'openai']
    const second = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({ ok: true, compiledChecksum: expect.any(String) })
    expect(second.json().compiledChecksum).not.toBe(first.json().compiledChecksum)

    const stalePublish = await action('publish', {
      payload: {
        expectedActiveRevision: null,
        expectedCompiledChecksum: first.json().compiledChecksum,
      },
      ifMatch: session.etag,
    })
    expect(stalePublish.statusCode).toBe(409)
    expect(stalePublish.json()).toMatchObject({ error: { code: 'MEASUREMENT_COMPILED_CHECKSUM_CONFLICT' } })
    expect(db.select().from(measurementPlanDrafts).all()).toHaveLength(1)
  })

  it('keeps an explicit empty assignment provider override invalid', async () => {
    const session = await readyDraft()
    db.update(projects).set({ providers: [] }).where(eq(projects.id, 'prj_northwind')).run()
    setDefaultContext({ providers: [], locations: ['nyc'] })
    runnableProviders = ['openai']
    await session.run('apply-assignments', {
      targetKey: 'widgets',
      queryIds: [queryId('best widget supplier')],
      contextOverride: { providers: [] },
    })

    const preview = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      ok: false,
      compiledChecksum: null,
      checks: expect.arrayContaining([expect.objectContaining({
        ruleId: 'execution-context-no-provider',
        severity: 'fail',
        path: ['assignments', expect.any(Number), 'contextOverride', 'providers'],
      })]),
    })
  })

  it('keys an execution node on the provider map, so two contexts never collapse into one call', async () => {
    const session = await DraftSession.start()
    await session.run('upsert-target', { target: WIDGETS_TARGET })
    await session.run('upsert-target', { target: GADGETS_TARGET })
    const shared = queryId('best widget supplier')
    await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [shared] })
    // Same question, same location, a different engine: that is a second
    // provider request, not a reuse of the first.
    await session.run('apply-assignments', {
      targetKey: 'gadgets',
      queryIds: [shared],
      contextOverride: { providers: ['gemini'], models: { gemini: 'gemini-test' } },
    })

    const plan = (await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })).json().plan
    const nodes = plan.executionNodes.filter((node: { queryId: string }) => node.queryId === shared)
    expect(nodes).toHaveLength(2)
    expect(nodes.map((node: { context: { providers: string[] } }) => node.context.providers).sort())
      .toEqual([['gemini'], ['gemini', 'openai']])
    expect(new Set(nodes.map((node: { stableKey: string }) => node.stableKey)).size).toBe(2)

    // Reuse across Targets adds a usage edge; it never duplicates a call.
    await session.run('apply-assignments', { targetKey: 'gadgets', queryIds: [queryId('widget delivery times')] })
    await session.run('apply-assignments', { targetKey: 'widgets', queryIds: [queryId('widget delivery times')] })
    const reused = (await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })).json().plan
    const delivery = queryId('widget delivery times')
    expect(reused.executionNodes.filter((node: { queryId: string }) => node.queryId === delivery)).toHaveLength(1)
    expect(reused.usageEdges.filter((edge: { queryId: string }) => edge.queryId === delivery)).toHaveLength(2)
  })

  it('refuses to compile two assignments that claim the same Target and question', async () => {
    await readyDraft()
    const row = db.select().from(measurementPlanDrafts).get()!
    const authoring = JSON.parse(row.authoringJson)
    // Two rows for one pair disagreeing about the class: the compiled document
    // would say both, and nothing downstream could tell which was meant.
    authoring.assignments.push({ ...authoring.assignments[0], queryClass: 'branded', classificationSource: 'operator' })
    db.update(measurementPlanDrafts).set({ authoringJson: JSON.stringify(authoring) })
      .where(eq(measurementPlanDrafts.id, row.id)).run()

    const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    expect(compiled.json()).toMatchObject({ ok: false, compiledChecksum: null })
    expect(compiled.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'duplicate-assignment', severity: 'fail' }),
    ]))
  })

  it('does not store a replayable receipt for a publish it refused', async () => {
    const session = await readyDraft()
    const refused = await action('publish', {
      payload: { expectedActiveRevision: null, expectedCompiledChecksum: '0'.repeat(64) },
      ifMatch: session.etag,
      idempotencyKey: 'publish-1',
    })
    expect(refused.statusCode).toBe(409)
    expect(db.select().from(measurementOperationReceipts)
      .where(eq(measurementOperationReceipts.operation, 'publish')).all()).toEqual([])

    // The same key now carries the corrected request and must go through
    // rather than replay a failure that was pinned to it.
    const compiled = await request('POST', '/measurement-plan/draft/actions/compile-preview', { payload: {} })
    const accepted = await action('publish', {
      payload: { expectedActiveRevision: null, expectedCompiledChecksum: compiled.json().compiledChecksum },
      ifMatch: session.etag,
      idempotencyKey: 'publish-1',
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json()).toMatchObject({ published: true, active: { revision: 1 } })
  })
})
