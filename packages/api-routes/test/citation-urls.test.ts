import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, queries, querySnapshots, runs } from '@canonry/canonry-db'
import { canonicalCitedUrl, citationUrlsResponseSchema, type CitationState } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const DAY = 86_400_000
const now = Date.now()
const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()
const NAMED = 'Acme Tank is thick and not see-through.'
const NOT_NAMED = 'Most white tanks are sheer.'

describe('canonicalCitedUrl', () => {
  it.each([
    ['https://www.reddit.com/r/womensfashion/comments/1jsvlt9/tank_air/?utm_source=openai', 'https://reddit.com/r/womensfashion/comments/1jsvlt9'],
    ['https://old.reddit.com/r/womensfashion/comments/1JSVLT9', 'https://reddit.com/r/womensfashion/comments/1jsvlt9'],
    ['http://www.youtube.com/watch?v=mxqBK5TdsmA&utm_medium=x#t=3', 'https://youtube.com/watch?v=mxqBK5TdsmA'],
    ['https://www.lemon8-app.com/@kylie/7449128686017643054?region=us', 'https://lemon8-app.com/@kylie/7449128686017643054?region=us'],
    ['https://example.com/a/', 'https://example.com/a'],
    ['https://www.reddit.com/r/AskNYC/comments/ABC/x/?share_id=xyz&rdt=123', 'https://reddit.com/r/asknyc/comments/abc'],
    ['https://example.com/a?srsltid=AfmBOo&gclid=1&page=2', 'https://example.com/a?page=2'],
    ['https://www.youtube.com/watch?v=abc&si=share', 'https://youtube.com/watch?v=abc'],
  ])('writes %s as %s', (input, expected) => {
    expect(canonicalCitedUrl(input)).toBe(expected)
  })

  it('refuses a value that is not an http(s) URL', () => {
    expect(canonicalCitedUrl('reddit.com')).toBeNull()
    expect(canonicalCitedUrl('ftp://example.com/a')).toBeNull()
  })
})

describe('GET /projects/:name/citations/urls', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  let projectId: string
  let queryIds: Record<string, string>

  function run(daysAgo: number, overrides: Partial<typeof runs.$inferInsert> = {}): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: at(daysAgo), finishedAt: at(daysAgo), ...overrides }).run()
    return id
  }
  function answer(runId: string, query: string, provider: string, citedUrls: string[] | null, opts: { named?: boolean | null; citationState?: CitationState; captureStatus?: 'complete' | 'partial' | 'failed' | null } = {}) {
    const named = opts.named === undefined ? true : opts.named
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, queryId: queryIds[query]!, provider,
      citationState: opts.citationState ?? 'not-cited', retrievalStatus: 'retrieved',
      citedDomains: [], citedUrls,
      captureStatus: opts.captureStatus === undefined ? 'complete' : opts.captureStatus,
      answerMentioned: named,
      answerText: named === null ? null : named ? NAMED : NOT_NAMED,
      createdAt: at(0),
    }).run()
  }
  async function read(query = '') {
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/acme/citations/urls${query ? `?${query}` : ''}` })
    return response
  }

  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({ id: projectId, name: 'acme', displayName: 'Acme Tank', canonicalDomain: 'acme.example', country: 'US', language: 'en', providers: ['gemini', 'openai'], createdAt: at(30), updatedAt: at(30) }).run()
    queryIds = {}
    for (const query of ['are acme tanks see through', 'best white tank']) {
      const id = crypto.randomUUID()
      db.insert(queries).values({ id, projectId, query, createdAt: at(30) }).run()
      queryIds[query] = id
    }
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('groups one page across link forms, counts answers once, and dates its first and last sweep', async () => {
    const older = run(10)
    const latest = run(1)
    answer(older, 'are acme tanks see through', 'gemini', [
      'https://www.reddit.com/r/womensfashion/comments/1hhk5j9/tank_air_tank_top/',
      // The same thread again in one answer: still one credit.
      'https://www.reddit.com/r/womensfashion/comments/1hhk5j9?utm_source=openai',
    ])
    answer(latest, 'are acme tanks see through', 'openai', ['https://old.reddit.com/r/womensfashion/comments/1hhk5j9/'], { named: false })
    answer(latest, 'best white tank', 'gemini', ['https://www.reddit.com/r/womensfashion/comments/1hhk5j9/tank_air_tank_top/'], { named: null })

    const response = await read()
    expect(response.statusCode).toBe(200)
    const body = citationUrlsResponseSchema.parse(response.json())
    expect(body.latestRun?.id).toBe(latest)
    expect(body.runCount).toBe(2)
    expect(body.answerTotal).toBe(3)
    expect(body.urls).toEqual([{
      url: 'https://reddit.com/r/womensfashion/comments/1hhk5j9',
      domain: 'reddit.com',
      category: 'forum',
      label: 'Reddit',
      answers: 3,
      answersMentioned: 1,
      answersMentionUnchecked: 1,
      providers: { gemini: 2, openai: 1 },
      queries: [{ query: 'are acme tanks see through', answers: 2 }, { query: 'best white tank', answers: 1 }],
      sweeps: 2,
      firstSeenAt: at(10),
      firstRunId: older,
      lastSeenAt: at(1),
      lastRunId: latest,
      newInLatest: false,
      citedInLatest: true,
    }])
  })

  it('marks pages only the latest sweep cites, and keeps only those with newInLatest', async () => {
    const older = run(10)
    const latest = run(1)
    answer(older, 'are acme tanks see through', 'gemini', ['https://www.reddit.com/r/womensfashion/comments/old1/a'])
    answer(latest, 'are acme tanks see through', 'gemini', [
      'https://www.reddit.com/r/womensfashion/comments/old1/a',
      'https://www.reddit.com/r/deinfluencing/comments/new1/b',
      'https://news.example/review',
    ])

    const all = citationUrlsResponseSchema.parse((await read()).json())
    expect(all.urls.find((url) => url.url.endsWith('/new1'))?.newInLatest).toBe(true)
    expect(all.urls.find((url) => url.url.endsWith('/old1'))?.newInLatest).toBe(false)

    const fresh = citationUrlsResponseSchema.parse((await read('newInLatest=true&category=forum')).json())
    expect(fresh.urls.map((url) => url.url)).toEqual(['https://reddit.com/r/deinfluencing/comments/new1'])
    expect(fresh.filters).toMatchObject({ newInLatest: true, categories: ['forum'] })

    // Inside a 7-day window the older sweep is out of scope: with no earlier
    // sweep to compare against, nothing reads as new.
    const recent = citationUrlsResponseSchema.parse((await read('window=7d&domain=reddit.com&newInLatest=true')).json())
    expect(recent.urls).toHaveLength(0)
  })

  it('leaves out answers stored before page capture, so the first captured sweep is not all new', async () => {
    const legacy = run(30)
    const firstCaptured = run(10)
    answer(legacy, 'best white tank', 'gemini', null, { captureStatus: null })
    answer(firstCaptured, 'best white tank', 'gemini', ['https://a.example/x'])
    const onlyFirst = citationUrlsResponseSchema.parse((await read()).json())
    expect(onlyFirst).toMatchObject({ answerTotal: 1, answersPagesNotCaptured: 1, sweepsWithPages: 1, runCount: 2 })
    expect(onlyFirst.urls[0]).toMatchObject({ url: 'https://a.example/x', newInLatest: false, citedInLatest: true })

    const next = run(1)
    answer(next, 'best white tank', 'gemini', ['https://a.example/x', 'https://a.example/y'], { captureStatus: 'partial' })
    const body = citationUrlsResponseSchema.parse((await read('newInLatest=true')).json())
    expect(body.urls.map((url) => url.url)).toEqual(['https://a.example/y'])
    expect(body).toMatchObject({ answersPagesIncomplete: 1, sweepsWithPages: 2 })
  })

  it('finds a page by a host written with www, m or old', async () => {
    const latest = run(1)
    answer(latest, 'best white tank', 'gemini', ['https://old.reddit.com/r/AskNYC/comments/abc/x/?share_id=1&rdt=2'])
    for (const domain of ['old.reddit.com', 'www.reddit.com', 'reddit.com']) {
      const body = citationUrlsResponseSchema.parse((await read(`domain=${domain}`)).json())
      expect(body.urls.map((url) => url.url), domain).toEqual(['https://reddit.com/r/asknyc/comments/abc'])
    }
  })

  it('treats a multi-location sweep as one sweep', async () => {
    const older = run(10)
    const latestA = run(1)
    const latestB = crypto.randomUUID()
    db.insert(runs).values({ id: latestB, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: at(1), finishedAt: at(1) }).run()
    answer(older, 'best white tank', 'gemini', ['https://forum.example/t/1'])
    answer(latestA, 'best white tank', 'gemini', ['https://forum.example/t/2'])
    answer(latestB, 'best white tank', 'gemini', ['https://forum.example/t/2'])
    const body = citationUrlsResponseSchema.parse((await read()).json())
    expect(body.runCount).toBe(2)
    // Two runs of one sweep: two answers, one sweep.
    expect(body.urls.find((url) => url.url.endsWith('/t/2'))).toMatchObject({ answers: 2, sweeps: 1, newInLatest: true })
  })

  it('leaves out probes, failed runs and engines that return no sources', async () => {
    const real = run(5)
    const probe = run(1, { trigger: 'probe' })
    const failed = run(2, { status: 'failed' })
    answer(real, 'best white tank', 'gemini', ['https://a.example/x'])
    answer(probe, 'best white tank', 'gemini', ['https://probe.example/x'])
    answer(failed, 'best white tank', 'gemini', ['https://failed.example/x'])
    answer(real, 'best white tank', 'local', ['https://local.example/x'], { citationState: 'not-measured' })
    const body = citationUrlsResponseSchema.parse((await read()).json())
    expect(body.latestRun?.id).toBe(real)
    expect(body.answerTotal).toBe(1)
    expect(body.urls.map((url) => url.url)).toEqual(['https://a.example/x'])
  })

  it('filters by provider and query class', async () => {
    const latest = run(1)
    answer(latest, 'are acme tanks see through', 'gemini', ['https://a.example/branded'])
    answer(latest, 'best white tank', 'openai', ['https://a.example/category'])
    const gemini = citationUrlsResponseSchema.parse((await read('provider=gemini')).json())
    expect(gemini.urls.map((url) => url.url)).toEqual(['https://a.example/branded'])
    const nonBrand = citationUrlsResponseSchema.parse((await read('queryClass=non-brand')).json())
    expect(nonBrand.urls.map((url) => url.url)).toEqual(['https://a.example/category'])
  })

  it('pages with a cursor bound to the filters', async () => {
    const latest = run(1)
    answer(latest, 'best white tank', 'gemini', ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'])
    answer(latest, 'are acme tanks see through', 'gemini', ['https://a.example/1'])
    const first = citationUrlsResponseSchema.parse((await read('limit=2')).json())
    expect(first.urls.map((url) => url.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
    expect(first).toMatchObject({ total: 3, returned: 2, truncated: true })
    const second = citationUrlsResponseSchema.parse((await read(`limit=2&cursor=${first.nextCursor}`)).json())
    expect(second.urls.map((url) => url.url)).toEqual(['https://a.example/3'])
    // The last page says nothing more follows.
    expect(second).toMatchObject({ nextCursor: null, truncated: false, returned: 1, total: 3 })
    expect((await read(`limit=2&provider=openai&cursor=${first.nextCursor}`)).statusCode).toBe(400)
  })

  it('sorts newest first citation first on request', async () => {
    const older = run(10)
    const latest = run(1)
    answer(older, 'best white tank', 'gemini', ['https://a.example/old'])
    answer(latest, 'best white tank', 'gemini', ['https://a.example/old', 'https://a.example/new'])
    const body = citationUrlsResponseSchema.parse((await read('sort=newest')).json())
    expect(body.urls.map((url) => url.url)).toEqual(['https://a.example/new', 'https://a.example/old'])
  })

  it('returns an empty read before any sweep', async () => {
    const body = citationUrlsResponseSchema.parse((await read()).json())
    expect(body).toMatchObject({ latestRun: null, runCount: 0, total: 0, urls: [], nextCursor: null })
  })

  it.each(['window=1y', 'category=forums', 'queryClass=brand', 'newInLatest=yes', 'sort=oldest', 'limit=0', 'limit=1001', 'domain=%20', 'cursor=nope', 'unexpected=1'])('refuses %s', async (query) => {
    const response = await read(query)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_ERROR')
  })
})
