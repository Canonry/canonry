import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, runs, querySnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import {
  ensureCurrentQueryBasketRevision,
  latestQueryBasketRevision,
  queryBasketMembers,
} from '../src/query-basket.js'
import { queueRunIfProjectIdle } from '../src/run-queue.js'

// The trend chart read 0% mention on two of three engines for a whole window
// while those engines were, in fact, mentioning the brand. Nothing was broken in
// the providers: analytics was normalizing the bucket to "queries that existed
// before this bucket started", a date proxy for measurement-set membership. A
// branded query added mid-window failed that test, its real mentions were
// dropped from the denominator AND the numerator, and the chart said 0% with no
// indication the set had moved.
//
// The proxy is wrong in more ways than that one. A rename is a delete plus an
// insert, so it reads as a brand new query. A remove-then-re-add detaches a
// query from its own history. Eligibility silently shifts whenever bucket
// boundaries move. And nothing anywhere recorded which set was actually measured,
// so none of this was visible after the fact.
//
// These tests pin the replacement: membership is a recorded fact, compared by
// query identity, and a change of set is an event rather than an inference.

function harness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basket-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: 'basket-site', displayName: 'Basket', canonicalDomain: 'example.com',
    ownedDomains: '[]', country: 'US', language: 'en', tags: '[]', labels: '{}',
    providers: '["gemini","openai","claude"]', locations: '[]', defaultLocation: null,
    configSource: 'api', configRevision: 1, createdAt: now, updatedAt: now,
  } as never).run()
  return { db, projectId, tmpDir }
}

const addQuery = (db: ReturnType<typeof createClient>, projectId: string, text: string, createdAt: string) => {
  const id = crypto.randomUUID()
  db.insert(queries).values({ id, projectId, query: text, createdAt }).run()
  return id
}

describe('query basket versioning', () => {
  it('does not mint a new revision when the query set has not changed', () => {
    // Revision numbers have to count real changes. If every run minted one, a
    // "basket changed" marker would fire on every sweep and mean nothing.
    const { db, projectId } = harness()
    addQuery(db, projectId, 'best roof coatings', '2026-07-01T00:00:00.000Z')

    const first = ensureCurrentQueryBasketRevision(db, projectId, '2026-07-01T01:00:00.000Z')
    const second = ensureCurrentQueryBasketRevision(db, projectId, '2026-07-02T01:00:00.000Z')
    const third = ensureCurrentQueryBasketRevision(db, projectId, '2026-07-03T01:00:00.000Z')

    expect(first!.revision).toBe(1)
    expect(second!.revision).toBe(1)
    expect(third!.revision).toBe(1)
  })

  it('mints a revision when a query is added, and again when one is removed', () => {
    const { db, projectId } = harness()
    addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    expect(ensureCurrentQueryBasketRevision(db, projectId)!.revision).toBe(1)

    const bId = addQuery(db, projectId, 'query b', '2026-07-02T00:00:00.000Z')
    expect(ensureCurrentQueryBasketRevision(db, projectId)!.revision).toBe(2)

    db.delete(queries).where(eq(queries.id, bId)).run()
    expect(ensureCurrentQueryBasketRevision(db, projectId)!.revision).toBe(3)
    expect(latestQueryBasketRevision(db, projectId)!.members).toEqual(['query a'])
  })

  it('treats a removed-then-re-added query as the SAME member, not a new one', () => {
    // The date rule cannot do this: re-adding mints a fresh `created_at`, so the
    // query looks brand new and detaches from its own history. Membership by
    // normalized text is what makes a re-add a no-op.
    const { db, projectId } = harness()
    addQuery(db, projectId, 'roof coating cost', '2026-07-01T00:00:00.000Z')
    const rev1 = ensureCurrentQueryBasketRevision(db, projectId)!

    db.delete(queries).where(eq(queries.projectId, projectId)).run()
    ensureCurrentQueryBasketRevision(db, projectId)
    // Re-added months later, different id, different created_at, same question.
    addQuery(db, projectId, '  Roof Coating Cost  ', '2026-09-01T00:00:00.000Z')
    const readded = ensureCurrentQueryBasketRevision(db, projectId)!

    expect(readded.checksum).toBe(rev1.checksum)
    expect(readded.members).toEqual(rev1.members)
  })

  it('depends on the set, not on insert order', () => {
    const { db, projectId } = harness()
    addQuery(db, projectId, 'zebra', '2026-07-01T00:00:00.000Z')
    addQuery(db, projectId, 'apple', '2026-07-02T00:00:00.000Z')
    const forward = ensureCurrentQueryBasketRevision(db, projectId)!

    const other = harness()
    addQuery(other.db, other.projectId, 'apple', '2026-07-05T00:00:00.000Z')
    addQuery(other.db, other.projectId, 'zebra', '2026-07-06T00:00:00.000Z')
    const reverse = ensureCurrentQueryBasketRevision(other.db, other.projectId)!

    expect(forward.checksum).toBe(reverse.checksum)
  })

  it('does not version a project with no queries', () => {
    // Stamping an empty basket would make "no queries configured yet" look like
    // a deliberate measurement set of size zero.
    const { db, projectId } = harness()
    expect(ensureCurrentQueryBasketRevision(db, projectId)).toBeNull()
    expect(queryBasketMembers(db, projectId)).toEqual([])
  })
})

describe('runs are stamped with the set they measure', () => {
  it('stamps a full sweep with the current revision', () => {
    const { db, projectId } = harness()
    addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')

    const result = queueRunIfProjectIdle(db, { projectId, createdAt: '2026-07-02T00:00:00.000Z' })
    expect(result.conflict).toBe(false)
    const row = db.select().from(runs).all()[0]!
    expect(row.queryBasketRevision).toBe(1)
    expect(row.measurementPlanVersionId).toBeNull()
    expect(row.measurementManifest).toBeNull()
  })

  it('leaves a SCOPED run unstamped, because it did not measure the whole basket', () => {
    // Labelling a 1-query spot check with the full basket revision would let it
    // land in a bucket as though all of them had been swept — the same
    // denominator error, arriving by a different route.
    const { db, projectId } = harness()
    addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    addQuery(db, projectId, 'query b', '2026-07-01T00:00:00.000Z')

    queueRunIfProjectIdle(db, {
      projectId,
      createdAt: '2026-07-02T00:00:00.000Z',
      queries: ['query a'],
    })
    const row = db.select().from(runs).all()[0]!
    expect(row.queryBasketRevision).toBeNull()
    expect(row.measurementPlanVersionId).toBeNull()
    expect(row.measurementManifest).toBeNull()
  })
})

describe('analytics uses the basket instead of query creation dates', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(async () => {
    const ctx = harness()
    db = ctx.db
    projectId = ctx.projectId
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })

  afterEach(async () => { await app.close() })

  /** One completed sweep covering `texts`, every one mentioned on every provider. */
  function sweep(at: string, texts: Array<{ id: string; text: string }>, revision: number | null) {
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      location: null, startedAt: at, finishedAt: at, error: null,
      queryBasketRevision: revision, createdAt: at,
    } as never).run()
    for (const q of texts) {
      for (const provider of ['gemini', 'openai', 'claude']) {
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(), runId, queryId: q.id, queryText: q.text, provider,
          model: `${provider}-model`, citationState: 'cited', answerMentioned: true,
          answerText: 'Example.com is a good option.', citedDomains: ['example.com'],
          competitorOverlap: [], location: null, rawResponse: '{}', createdAt: at,
        } as never).run()
      }
    }
  }

  const metrics = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/basket-site/analytics/metrics?window=all` })
    return res.json()
  }

  it('counts a query added mid-window, instead of reading 0% while it was mentioned', async () => {
    // The reported bug, end to end. Two queries measured from July 1; a branded
    // query added July 15 and swept July 20 with mentions on all three engines.
    const a = addQuery(db, projectId, 'roof coating contractors', '2026-07-01T00:00:00.000Z')
    const b = addQuery(db, projectId, 'best roof coating', '2026-07-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-01T00:00:00.000Z')
    sweep('2026-07-01T09:00:00.000Z', [{ id: a, text: 'roof coating contractors' }, { id: b, text: 'best roof coating' }], 1)

    const c = addQuery(db, projectId, 'acme coatings reviews', '2026-07-15T12:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-15T12:00:00.000Z')
    sweep('2026-07-20T09:00:00.000Z', [
      { id: a, text: 'roof coating contractors' },
      { id: b, text: 'best roof coating' },
      { id: c, text: 'acme coatings reviews' },
    ], 2)

    const body = await metrics()
    const last = body.buckets.at(-1)

    // Under the date rule this bucket kept only a and b: `c` was created
    // 2026-07-15T12:00Z and the bucket starts 2026-07-15T00:00Z, so it failed
    // `created_at < bucketStart` and its three real mentions vanished.
    expect(last.queryCount).toBe(3)
    expect(last.mentionedCount).toBe(9)
    expect(last.mentionRate).toBe(1)
    expect(last.basketRevision).toBe(2)
    // Every provider is present, rather than two of them reading zero.
    expect(Object.keys(last.byProvider).sort()).toEqual(['claude', 'gemini', 'openai'])
    expect(last.byProvider.claude.mentionRate).toBe(1)
  })

  it('does not penalise an early bucket for queries that did not exist yet', async () => {
    // The July 1 bucket only ever swept two queries. It must report those two,
    // not three-with-a-third-missing, or adding a query would retroactively
    // crater every historical point.
    const a = addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    const b = addQuery(db, projectId, 'query b', '2026-07-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-01T00:00:00.000Z')
    sweep('2026-07-01T09:00:00.000Z', [{ id: a, text: 'query a' }, { id: b, text: 'query b' }], 1)

    const c = addQuery(db, projectId, 'query c', '2026-07-15T12:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-15T12:00:00.000Z')
    sweep('2026-07-20T09:00:00.000Z', [
      { id: a, text: 'query a' }, { id: b, text: 'query b' }, { id: c, text: 'query c' },
    ], 2)

    const body = await metrics()
    expect(body.buckets[0].queryCount).toBe(2)
    expect(body.buckets[0].mentionRate).toBe(1)
    expect(body.buckets[0].basketRevision).toBe(1)
  })

  it('never silently shrinks the swept set, which is what produced the 0% readings', async () => {
    // The regression guard. Under the date rule a bucket could quietly measure
    // fewer queries than the sweep actually covered, and nothing said so. With
    // the basket, everything swept is by construction a basket member, so the
    // comparable set and the swept set must agree exactly. If this ever fails,
    // a headline has become a subset again.
    const a = addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    const b = addQuery(db, projectId, 'query b', '2026-07-14T00:00:00.000Z')
    const c = addQuery(db, projectId, 'query c', '2026-07-19T23:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-19T23:30:00.000Z')
    // All three swept together, including two created inside their own bucket.
    sweep('2026-07-01T09:00:00.000Z', [{ id: a, text: 'query a' }], 1)
    sweep('2026-07-20T09:00:00.000Z', [
      { id: a, text: 'query a' }, { id: b, text: 'query b' }, { id: c, text: 'query c' },
    ], 1)

    const body = await metrics()
    const last = body.buckets.at(-1)
    expect(last.queryCount).toBe(3)
    expect(last.total).toBe(9)
    expect(last.mentionRate).toBe(1)
  })

  it('surfaces a basket change as an event with what moved', async () => {
    const a = addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-01T00:00:00.000Z')
    sweep('2026-07-01T09:00:00.000Z', [{ id: a, text: 'query a' }], 1)
    addQuery(db, projectId, 'query b', '2026-07-15T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-15T00:00:00.000Z')

    const body = await metrics()
    expect(body.referenceBasketRevision).toBe(2)
    expect(body.basketChanges).toHaveLength(1)
    expect(body.basketChanges[0]).toMatchObject({
      revision: 2, at: '2026-07-15T00:00:00.000Z', added: ['query b'], removed: [],
    })
  })

  it('falls back to the date rule for a project with no recorded basket', async () => {
    // Projects that have not run since versioning shipped have no basket. They
    // must keep the behaviour they had rather than silently changing shape the
    // moment this deploys.
    const a = addQuery(db, projectId, 'query a', '2026-07-01T00:00:00.000Z')
    const c = addQuery(db, projectId, 'query c', '2026-07-15T12:00:00.000Z')
    sweep('2026-07-01T09:00:00.000Z', [{ id: a, text: 'query a' }], null)
    sweep('2026-07-20T09:00:00.000Z', [{ id: a, text: 'query a' }, { id: c, text: 'query c' }], null)

    const body = await metrics()
    expect(body.referenceBasketRevision).toBeNull()
    expect(body.basketChanges).toEqual([])
    const last = body.buckets.at(-1)
    // `query c` created 2026-07-15T12:00Z, bucket starts 2026-07-15T00:00Z, so
    // the old heuristic still drops it. Preserved deliberately.
    expect(last.queryCount).toBe(1)
    expect(last.basketRevision).toBeNull()
  })
})

describe('deleted-query history rejoins through the basket', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(async () => {
    const ctx = harness()
    db = ctx.db
    projectId = ctx.projectId
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })

  afterEach(async () => { await app.close() })

  function sweep(at: string, texts: Array<{ id: string; text: string }>, revision: number | null) {
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      location: null, startedAt: at, finishedAt: at, error: null,
      queryBasketRevision: revision, createdAt: at,
    } as never).run()
    for (const q of texts) {
      for (const provider of ['gemini', 'openai', 'claude']) {
        db.insert(querySnapshots).values({
          id: crypto.randomUUID(), runId, queryId: q.id, queryText: q.text, provider,
          model: `${provider}-model`, citationState: 'cited', answerMentioned: true,
          answerText: 'Example.com is a good option.', citedDomains: ['example.com'],
          competitorOverlap: [], location: null, rawResponse: '{}', createdAt: at,
        } as never).run()
      }
    }
  }

  const metrics = async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/basket-site/analytics/metrics?window=all` })
    return res.json()
  }

  it('recovers the history of a query that was deleted and re-added', async () => {
    // Deleting a query nulls query_id on its historical snapshots, and the
    // metrics route used to drop those rows before analytics saw them. So a
    // cleanup that removed and re-added a question erased months of real
    // measurements from the chart. Identity by text is what makes the old rows
    // recoverable: same question, same history.
    const a = addQuery(db, projectId, 'acme coatings reviews', '2026-03-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-03-01T00:00:00.000Z')
    sweep('2026-03-05T09:00:00.000Z', [{ id: a, text: 'acme coatings reviews' }], 1)

    // The cleanup: row deleted, snapshots orphaned. Prove the orphaning
    // actually happened so this test cannot pass with intact foreign keys.
    db.delete(queries).where(eq(queries.id, a)).run()
    const orphans = db.select().from(querySnapshots).all()
    expect(orphans).toHaveLength(3)
    for (const o of orphans) expect(o.queryId).toBeNull()

    // Re-added months later under a fresh row id, then swept again.
    const b = addQuery(db, projectId, 'acme coatings reviews', '2026-07-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-07-01T00:00:00.000Z')
    sweep('2026-07-05T09:00:00.000Z', [{ id: b, text: 'acme coatings reviews' }], 2)

    const body = await metrics()
    // Both eras are on the chart: March's 3 mentions came back.
    expect(body.buckets).toHaveLength(2)
    expect(body.buckets[0]).toMatchObject({ total: 3, mentionedCount: 3, queryCount: 1 })
    expect(body.buckets.at(-1)).toMatchObject({ total: 3, mentionedCount: 3, queryCount: 1 })
    expect(body.overall.total).toBe(6)
    expect(body.overall.mentionedCount).toBe(6)
  })

  it('keeps a genuinely removed query out, orphaned history included', async () => {
    // Rejoining is by membership, not by existence of old rows. A query the
    // operator dropped from measurement stays dropped: resurfacing its history
    // would un-do the removal.
    const keep = addQuery(db, projectId, 'kept query', '2026-03-01T00:00:00.000Z')
    const drop = addQuery(db, projectId, 'dropped query', '2026-03-01T00:00:00.000Z')
    ensureCurrentQueryBasketRevision(db, projectId, '2026-03-01T00:00:00.000Z')
    sweep('2026-03-05T09:00:00.000Z', [
      { id: keep, text: 'kept query' }, { id: drop, text: 'dropped query' },
    ], 1)

    db.delete(queries).where(eq(queries.id, drop)).run()
    ensureCurrentQueryBasketRevision(db, projectId, '2026-04-01T00:00:00.000Z')

    const body = await metrics()
    expect(body.buckets[0].queryCount).toBe(1)
    expect(body.buckets[0].total).toBe(3)
    expect(body.overall.total).toBe(3)
  })

  it('leaves orphans dropped when no basket is recorded, so deploy day changes nothing', async () => {
    // Without a recorded set there is no membership to test against, and
    // guessing from text alone would resurrect every deleted query's history
    // the moment this code ships. Fall back to the old behaviour until the
    // first revision exists.
    const a = addQuery(db, projectId, 'some query', '2026-03-01T00:00:00.000Z')
    sweep('2026-03-05T09:00:00.000Z', [{ id: a, text: 'some query' }], null)
    db.delete(queries).where(eq(queries.id, a)).run()
    addQuery(db, projectId, 'some query', '2026-07-01T00:00:00.000Z')

    const body = await metrics()
    expect(body.referenceBasketRevision).toBeNull()
    expect(body.buckets).toHaveLength(0)
    expect(body.overall.total).toBe(0)
  })
})
