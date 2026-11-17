import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  crawlerEventsHourly,
  createClient,
  migrate,
  projects,
  trafficSources,
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

const now = '2026-11-01T00:00:00.000Z'
const window = 'since=2026-10-01T00:00:00.000Z&until=2026-10-02T00:00:00.000Z'
const base = '/api/v1/projects/example/traffic/events'

interface EventRow { kind: string; tsHour: string; botId?: string; product?: string; pathNormalized?: string; landingPathNormalized?: string; status: number; hits: number; sourceId: string }

describe('traffic events paging, filters and groups', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>

  const hour = (h: number) => `2026-10-01T${String(h).padStart(2, '0')}:00:00.000Z`
  function crawler(h: number, botId: string, path: string, hits = 1, status = 200, sourceId = 'source') {
    db.insert(crawlerEventsHourly).values({ projectId: 'project', sourceId, tsHour: hour(h), botId, operator: 'Op', verificationStatus: 'verified', pathNormalized: path, status, hits, createdAt: now, updatedAt: now }).run()
  }
  function userFetch(h: number, botId: string, path: string, hits = 1) {
    db.insert(aiUserFetchEventsHourly).values({ projectId: 'project', sourceId: 'source', tsHour: hour(h), botId, operator: 'OpenAI', verificationStatus: 'verified', pathNormalized: path, status: 200, hits, createdAt: now, updatedAt: now }).run()
  }
  function referral(h: number, product: string, path: string, hits = 1) {
    db.insert(aiReferralEventsHourly).values({ projectId: 'project', sourceId: 'source', tsHour: hour(h), product, operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: path, status: 200, sessionsOrHits: hits, paidSessionsOrHits: 0, organicSessionsOrHits: hits, createdAt: now, updatedAt: now }).run()
  }
  const read = async (query: string) => app.inject({ method: 'GET', url: `${base}?${query}` })
  const rowKey = (row: EventRow) => [row.kind, row.tsHour, row.sourceId, row.botId ?? row.product, row.pathNormalized ?? row.landingPathNormalized, row.status].join('|')

  async function readAllPages(query: string) {
    const rows: EventRow[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const response = await read(cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query)
      expect(response.statusCode).toBe(200)
      const body = response.json()
      rows.push(...body.events)
      cursor = body.eventRows.nextCursor
      pages += 1
      expect(pages).toBeLessThan(100)
    } while (cursor)
    return { rows, pages }
  }

  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    for (const [id, name] of [['project', 'example'], ['other', 'other']] as const) {
      db.insert(projects).values({ id, name, displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    }
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: now, updatedAt: now }).run()
    db.insert(trafficSources).values({ id: 'second', projectId: 'project', sourceType: 'vercel', displayName: 'Vercel', status: 'connected', createdAt: now, updatedAt: now }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('pages through every row exactly once, newest hour first, across all three kinds', async () => {
    // Several kinds share each hour, so the order inside an hour decides
    // whether a page boundary repeats or skips a row.
    for (let h = 0; h < 6; h += 1) {
      crawler(h, 'gptbot', '/a')
      crawler(h, 'gptbot', '/b')
      crawler(h, 'bingbot', '/a')
      userFetch(h, 'openai-chatgpt-user', '/a')
      referral(h, 'ChatGPT', '/landing')
    }
    const first = (await read(`${window}&limit=4`)).json()
    expect(first.eventRows).toMatchObject({ total: 30, returned: 4, truncated: true })
    expect(typeof first.eventRows.nextCursor).toBe('string')

    const { rows, pages } = await readAllPages(`${window}&limit=4`)
    expect(pages).toBe(8)
    expect(rows).toHaveLength(30)
    expect(new Set(rows.map(rowKey)).size).toBe(30)
    const hours = rows.map((row) => row.tsHour)
    expect(hours).toEqual([...hours].sort().reverse())
    // Within one hour: crawler rows, then AI user-fetch, then AI-referral.
    expect(rows.slice(0, 5).map((row) => row.kind)).toEqual(['crawler', 'crawler', 'crawler', 'ai-user-fetch', 'ai-referral'])
  })

  it('returns no cursor when one page holds every row', async () => {
    crawler(1, 'gptbot', '/a')
    const body = (await read(`${window}&limit=5`)).json()
    expect(body.eventRows).toEqual({ total: 1, returned: 1, truncated: false, nextCursor: null })
  })

  it('says nothing more follows on the last page', async () => {
    for (let h = 0; h < 3; h += 1) crawler(h, 'gptbot', '/a')
    const first = (await read(`${window}&limit=2`)).json()
    expect(first.eventRows).toMatchObject({ total: 3, returned: 2, truncated: true })
    const last = (await read(`limit=2&cursor=${encodeURIComponent(first.eventRows.nextCursor)}`)).json()
    expect(last.eventRows).toEqual({ total: 3, returned: 1, truncated: false, nextCursor: null })
  })

  it('keeps the first page window on later pages, so new hours cannot shift a page', async () => {
    for (let h = 0; h < 4; h += 1) crawler(h, 'gptbot', '/a')
    const first = (await read(`${window}&limit=2`)).json()
    // A newer hour arrives between pages; it is inside the window but newer than the cursor.
    crawler(5, 'gptbot', '/new')
    const second = (await read(`limit=2&cursor=${encodeURIComponent(first.eventRows.nextCursor)}`)).json()
    expect(second.windowStart).toBe(first.windowStart)
    expect(second.windowEnd).toBe(first.windowEnd)
    expect(second.events.map((row: EventRow) => row.tsHour)).toEqual([hour(1), hour(0)])
  })

  it('refuses a cursor sent with different filters or a different window', async () => {
    for (let h = 0; h < 4; h += 1) crawler(h, 'gptbot', '/a')
    const cursor = encodeURIComponent((await read(`${window}&limit=2`)).json().eventRows.nextCursor)
    for (const query of [
      `${window}&limit=2&kind=crawler&cursor=${cursor}`,
      `${window}&limit=2&path=/a&cursor=${cursor}`,
      `since=2026-09-30T00:00:00.000Z&limit=2&cursor=${cursor}`,
      'cursor=not-a-cursor',
    ]) {
      const response = await read(query)
      expect(response.statusCode, query).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    }
    // Repeating the first page's explicit window is fine.
    expect((await read(`${window}&limit=2&cursor=${cursor}`)).statusCode).toBe(200)
  })

  it('narrows totals, series, rows and the echoed filters by page and agent', async () => {
    crawler(1, 'openai-searchbot', '/faq', 3)
    crawler(1, 'openai-searchbot', '/faq-old', 2)
    crawler(1, 'openai-searchbot', '/products/a', 5)
    crawler(2, 'bingbot', '/faq', 7)
    userFetch(2, 'openai-chatgpt-user', '/faq', 4)
    referral(2, 'ChatGPT', '/faq', 6)

    // /faq is the page and the pages under it; /faq-old is another page.
    const faq = (await read(`${window}&path=/faq`)).json()
    expect(faq.filters).toEqual({ kinds: ['crawler', 'ai-user-fetch', 'ai-referral'], sourceId: null, path: '/faq', agent: null })
    expect(faq.totals.crawlerHits).toBe(10)
    expect(faq.totals.aiUserFetchHits).toBe(4)
    expect(faq.totals.aiReferralHits).toBe(6)
    expect(faq.eventRows.total).toBe(4)
    expect(faq.series.points.reduce((sum: number, point: { crawlerHits: number }) => sum + point.crawlerHits, 0)).toBe(10)

    const searchBot = (await read(`${window}&agent=openai-searchbot`)).json()
    expect(searchBot.totals.crawlerHits).toBe(10)
    expect(searchBot.totals.aiUserFetchHits).toBe(0)
    expect(searchBot.totals.aiReferralHits).toBe(0)
    expect(searchBot.events.every((row: EventRow) => row.botId === 'openai-searchbot')).toBe(true)

    // On AI-referral rows the agent is the product.
    const chatgpt = (await read(`${window}&agent=ChatGPT&kind=ai-referral`)).json()
    expect(chatgpt.totals.aiReferralHits).toBe(6)
  })

  it('matches a page and the pages under it, literally and with case', async () => {
    crawler(1, 'gptbot', '/blog%_/one', 1)
    crawler(1, 'gptbot', '/blogXY/one', 1)
    crawler(1, 'gptbot', '/About', 1)
    crawler(1, 'gptbot', '/about/team', 1)
    crawler(1, 'gptbot', '/products', 1)
    crawler(1, 'gptbot', '/products/a', 1)
    crawler(1, 'gptbot', '/productsale', 1)
    const paths = async (path: string) =>
      ((await read(`${window}&path=${encodeURIComponent(path)}`)).json().events as EventRow[]).map((row) => row.pathNormalized).sort()
    expect(await paths('/blog%_')).toEqual(['/blog%_/one'])
    expect(await paths('/about')).toEqual(['/about/team'])
    expect(await paths('/products/')).toEqual(['/products', '/products/a'])
    expect((await paths('/')).length).toBe(7)
  })

  it('totals by agent and path over the whole window, most hits first, capped by limit', async () => {
    for (let h = 0; h < 10; h += 1) crawler(h, 'openai-searchbot', '/api/shopify', 10)
    crawler(3, 'bingbot', '/faq', 2)
    crawler(4, 'bingbot', '/faq', 3)
    userFetch(5, 'openai-chatgpt-user', '/faq', 4)
    referral(5, 'ChatGPT', '/faq', 1)

    const body = (await read(`${window}&groupBy=agent,path&limit=3`)).json()
    expect(body.groups).toEqual({
      by: ['agent', 'path'],
      total: 4,
      returned: 3,
      truncated: true,
      entries: [
        { kind: 'crawler', agent: 'openai-searchbot', path: '/api/shopify', hits: 100, rows: 10, firstHour: hour(0), lastHour: hour(9) },
        { kind: 'crawler', agent: 'bingbot', path: '/faq', hits: 5, rows: 2, firstHour: hour(3), lastHour: hour(4) },
        { kind: 'ai-user-fetch', agent: 'openai-chatgpt-user', path: '/faq', hits: 4, rows: 1, firstHour: hour(5), lastHour: hour(5) },
      ],
    })

    // Which bots read /faq: one call, no rows to page through.
    const faqReaders = (await read(`${window}&path=/faq&groupBy=agent`)).json()
    expect(faqReaders.groups.entries.map((group: { kind: string; agent: string; hits: number }) => [group.kind, group.agent, group.hits])).toEqual([
      ['crawler', 'bingbot', 5],
      ['ai-user-fetch', 'openai-chatgpt-user', 4],
      ['ai-referral', 'ChatGPT', 1],
    ])
    expect(faqReaders.groups.truncated).toBe(false)
  })

  it('splits groups by status and source when asked', async () => {
    crawler(1, 'gptbot', '/a', 2, 200, 'source')
    crawler(1, 'gptbot', '/a', 3, 404, 'second')
    const body = (await read(`${window}&kind=crawler&groupBy=status,source`)).json()
    expect(body.groups.entries).toEqual([
      { kind: 'crawler', status: 404, sourceId: 'second', hits: 3, rows: 1, firstHour: hour(1), lastHour: hour(1) },
      { kind: 'crawler', status: 200, sourceId: 'source', hits: 2, rows: 1, firstHour: hour(1), lastHour: hour(1) },
    ])
  })

  it('leaves groups out unless asked, and refuses an unknown group field', async () => {
    crawler(1, 'gptbot', '/a')
    expect((await read(window)).json()).not.toHaveProperty('groups')
    for (const query of ['groupBy=bot', 'groupBy=', 'path=', 'agent=%20', 'sourceId=a&sourceId=b']) {
      const response = await read(`${window}&${query}`)
      expect(response.statusCode, query).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    }
  })
})
