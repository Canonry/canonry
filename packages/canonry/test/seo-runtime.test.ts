import { afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { queries, seoBudgets, seoJobs, seoTasks } from '@canonry/canonry-db'
import type { SeoMarketRanking, SeoTask } from '@canonry/canonry-contracts'
import type { SeoInstallConfig } from '@canonry/canonry-config'
import { SeoRuntime } from '../src/seo-runtime.js'
import { createSeoHarness, seoProfileFixture } from '../../api-routes/test/seo-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.unstubAllGlobals(); vi.useRealTimers() })
async function setup(dailyLimit = 1_000_000, read?: (config: SeoInstallConfig) => SeoInstallConfig, fingerprint?: () => string) {
  const config: SeoInstallConfig = { enabled: true, fundingMode: 'hosted', policy: { maxRunCostMicros: 100_000, accountDailyLimitMicros: 1_000_000, accountMonthlyLimitMicros: 1_000_000, projectMonthlyLimitMicros: 1_000_000 }, connections: { primary: { provider: 'dataforseo', label: 'SEO data', enabled: true, login: 'operator@example.com', password: 'test-secret' } } }
  config.policy.accountDailyLimitMicros = dailyLimit
  const h = createSeoHarness({ getSeoRuntime: () => runtime.getRuntime(), onSeoRunRequested: () => runtime.wake() })
  const runtime = new SeoRuntime(h.db, () => read ? read(config) : config, fingerprint)
  cleanups.push(async () => { await runtime.stop(); await h.close() })
  const base = '/api/v1/projects/alpha/seo'
  const saved = await h.app.inject({ method: 'PUT', url: `${base}/profiles/main`, payload: seoProfileFixture })
  expect(saved.statusCode, saved.body).toBe(200)
  const intent = (await h.app.inject({ method: 'POST', url: `${base}/refresh-intents`, payload: { profileId: 'main' } })).json()
  const accepted = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'runtime-one' } })
  expect(accepted.statusCode, accepted.body).toBe(202)
  return { ...h, runtime, config, id: accepted.json().id as string, base }
}
const success = () => Response.json({ status_code: 20000, tasks: [{ id: 'remote-1', status_code: 20000, cost: 0.01212, result: [{ location_code: 2840, language_code: 'en', items: [{ keyword: 'solar installer', keyword_info: { search_volume: 0, cpc: null }, keyword_properties: { keyword_difficulty: 25 } }] }] }] })

describe('durable SEO runtime with the real upstream adapter', () => {
  it('reuses unchanged configuration and pauses accepted work across a failed reload until repair', async () => {
    let revision = 'original'
    let unreadable = false
    const read = vi.fn((config: SeoInstallConfig) => {
      if (unreadable) throw new SyntaxError('Configuration is temporarily unreadable')
      return structuredClone(config)
    })
    const fetch = vi.fn().mockImplementation(success); vi.stubGlobal('fetch', fetch)
    const h = await setup(1_000_000, read, () => revision)
    await h.app.inject({ url: `${h.base}/context` })
    await h.app.inject({ url: `${h.base}/status` })
    const unchangedReads = read.mock.calls.length
    revision = 'being-edited'; unreadable = true
    h.runtime.start()
    expect((await h.app.inject({ url: `${h.base}/context` })).json().available).toBe(false)
    await h.runtime.stop()
    expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('queued')
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[12120, 0], [12120, 0], [12120, 0]])
    expect(fetch).not.toHaveBeenCalled()
    expect(unchangedReads).toBe(1)
    unreadable = false; revision = 'repaired'
    h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('completed'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retains the exact successful response across storage failure and shutdown without another paid call', async () => {
    const fetch = vi.fn().mockImplementation(success); vi.stubGlobal('fetch', fetch)
    const h = await setup()
    h.db.$client.exec("CREATE TRIGGER refuse_seo_receipt BEFORE UPDATE OF actual_micros ON seo_tasks BEGIN SELECT RAISE(FAIL, 'Storage temporarily unavailable'); END")
    h.runtime.start()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await h.runtime.stop()
    expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('running')
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[12120, 0], [12120, 0], [12120, 0]])
    h.db.$client.exec('DROP TRIGGER refuse_seo_receipt')
    h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('completed'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(h.db.select().from(seoTasks).get()).toMatchObject({ actualMicros: 12120, receipts: [{ remoteTaskId: 'remote-1', statusCode: 20000, costMicros: 12120 }], results: { keywordMetrics: [{ keyword: 'solar installer', searchVolume: 0, keywordDifficulty: 25 }] } })
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 12120], [0, 12120], [0, 12120]])
  })

  it('settles an explicit free request refusal without blocking the next refresh', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status_code: 40200, cost: 0, tasks: [] })).mockImplementation(success)
    vi.stubGlobal('fetch', fetch)
    const h = await setup(); h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('failed'))
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 0], [0, 0], [0, 0]])
    const intent = (await h.app.inject({ method: 'POST', url: `${h.base}/refresh-intents`, payload: { profileId: 'main' } })).json()
    const next = await h.app.inject({ method: 'POST', url: `${h.base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'after-free-refusal' } })
    expect(next.statusCode).toBe(202)
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, next.json().id)).get()?.status).toBe('completed'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('bounds shutdown even when a transport ignores abort, retaining the unknown charge hold', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, options?: RequestInit) => { signal = options?.signal ?? undefined; return new Promise<Response>(() => {}) })
    vi.stubGlobal('fetch', fetch)
    const h = await setup(); h.runtime.start()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await h.runtime.stop()
    expect(signal?.aborted).toBe(true)
    expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('reconciliation-required')
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[12120, 0], [12120, 0], [12120, 0]])
    h.runtime.start(); await h.runtime.stop()
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 2000)

  it('dispatches only after start, stores provider evidence, and settles each receipt once', async () => {
    const fetch = vi.fn().mockImplementation(success); vi.stubGlobal('fetch', fetch)
    const h = await setup()
    expect(fetch).not.toHaveBeenCalled()
    expect(h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)).toEqual([12120, 12120, 12120])
    h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('completed'))
    h.runtime.wake()
    expect(fetch).toHaveBeenCalledTimes(1)
    const rows = (await h.app.inject({ url: `${h.base}/keyword-metrics?profileId=main` })).json()
    expect(rows.items[0]).toMatchObject({ keyword: 'solar installer', searchVolume: 0, cpcUsd: null, keywordDifficulty: 25 })
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 12120], [0, 12120], [0, 12120]])
  })

  it('moves yesterday’s queued hold under the current cap and dispatches later projects without blocking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const fetch = vi.fn().mockImplementation(success); vi.stubGlobal('fetch', fetch)
    const h = await setup(12120)
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    h.config.policy.accountDailyLimitMicros = 50_000
    const account = h.runtime.getRuntime()!.connections[0]!.adapter.accountKey
    // Stored prior work has already consumed today's capacity, independently of the queued job.
    h.db.insert(seoBudgets).values({ scope: `account-day:${account}`, period: '2026-10-22', spentMicros: 12120 }).run()
    h.db.update(seoBudgets).set({ spentMicros: 12120 }).where(and(eq(seoBudgets.scope, `account-month:${account}`), eq(seoBudgets.period, '2026-10'))).run()
    const beta = '/api/v1/projects/beta/seo'
    expect((await h.app.inject({ method: 'PUT', url: `${beta}/profiles/main`, payload: seoProfileFixture })).statusCode).toBe(200)
    const intent = (await h.app.inject({ method: 'POST', url: `${beta}/refresh-intents`, payload: { profileId: 'main' } })).json()
    const accepted = await h.app.inject({ method: 'POST', url: `${beta}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'today-second-project' } })
    expect(accepted.statusCode, accepted.body).toBe(202)
    h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).all().map(row => row.status)).toEqual(['completed', 'completed']))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(h.db.select().from(seoBudgets).where(eq(seoBudgets.scope, `account-day:${account}`)).all().map(row => [row.period, row.reservedMicros, row.spentMicros])).toEqual([['2026-10-21', 0, 0], ['2026-10-22', 0, 36360]])
    expect(h.db.select().from(seoBudgets).where(eq(seoBudgets.scope, `account-month:${account}`)).get()).toMatchObject({ reservedMicros: 0, spentMicros: 36360 })
    expect(h.db.select().from(seoBudgets).where(eq(seoBudgets.scope, 'project-month:alpha')).get()).toMatchObject({ reservedMicros: 0, spentMicros: 12120 })
    expect(h.db.select().from(seoBudgets).where(eq(seoBudgets.scope, 'project-month:beta')).get()).toMatchObject({ reservedMicros: 0, spentMicros: 12120 })
  })

  it.each(['ceiling', 'daily', 'monthly', 'project', 'catalog', 'account'] as const)('cancels undispatched work when the accepted %s no longer applies', async changed => {
    const fetch = vi.fn().mockImplementation(success); vi.stubGlobal('fetch', fetch)
    const h = await setup()
    if (changed === 'ceiling') h.config.policy.maxRunCostMicros = 100
    else if (changed === 'daily') h.config.policy.accountDailyLimitMicros = 100
    else if (changed === 'monthly') h.config.policy.accountMonthlyLimitMicros = 100
    else if (changed === 'project') h.config.policy.projectMonthlyLimitMicros = 100
    else if (changed === 'account') h.config.connections.primary!.login = 'different-account@example.com'
    else h.db.update(seoTasks).set({ catalogRevision: 'previous-release-catalog' }).run()
    h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('cancelled'))
    expect(fetch).not.toHaveBeenCalled()
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 0], [0, 0], [0, 0]])
  })

  it('records an unexpected charge without clamping it and blocks further account admission', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status_code: 20000, tasks: [{ id: 'overage', status_code: 20000, cost: 0.5, result: [{ items: [] }] }] }))
    vi.stubGlobal('fetch', fetch)
    const h = await setup(); h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('reconciliation-required'))
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 500000], [0, 500000], [0, 500000]])
    const intent = (await h.app.inject({ method: 'POST', url: `${h.base}/refresh-intents`, payload: { profileId: 'main' } })).json()
    const blocked = await h.app.inject({ method: 'POST', url: `${h.base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'after-overage' } })
    expect(blocked.statusCode).toBe(400)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves uncertain paid submissions through repeated wakeups without resubmitting', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket disconnected')); vi.stubGlobal('fetch', fetch)
    const h = await setup(); h.runtime.start()
    await vi.waitFor(() => expect(h.db.select().from(seoJobs).where(eq(seoJobs.id, h.id)).get()?.status).toBe('reconciliation-required'))
    h.runtime.wake(); h.runtime.wake()
    await h.runtime.stop()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[12120, 0], [12120, 0], [12120, 0]])
  })
})

// A Google results page for one search, and what comes back when Google itself errors on it (status 40101).
const ranked = (keyword: string) => Response.json({ status_code: 20000, cost: 0.002, tasks: [{ id: `serp-${keyword}`, status_code: 20000, cost: 0.002, result: [{
  keyword, type: 'organic', se_domain: 'google.com', location_code: 2840, language_code: 'en', datetime: '2026-10-25 17:10:11 +00:00', item_types: ['organic'],
  se_results_count: 1000, pages_count: 1, items_count: 1, items: [{ type: 'organic', rank_group: 3, rank_absolute: 3, domain: 'www.alpha.com', url: 'https://www.alpha.com/solar' }],
}] }] })
const googleError = (keyword: string, cost = 0) => Response.json({ status_code: 20000, cost, tasks: [{ id: `serp-${keyword}`, status_code: 40101, cost, result: null }] })

describe('market-rankings retries with the real upstream adapter', () => {
  /** A market-rankings refresh of two tracked queries at depth 10 (2,000 microUSD a search), answered by `answer`. */
  async function rankingRefresh(answer: (keyword: string, attempt: number) => Response, policy: Partial<SeoInstallConfig['policy']> = {}) {
    const config: SeoInstallConfig = { enabled: true, fundingMode: 'hosted', policy: { maxRunCostMicros: 100_000, accountDailyLimitMicros: 1_000_000, accountMonthlyLimitMicros: 1_000_000, projectMonthlyLimitMicros: 1_000_000, ...policy }, connections: { primary: { provider: 'dataforseo', label: 'SEO data', enabled: true, login: 'operator@example.com', password: 'test-secret' } } }
    const attempts = new Map<string, number>()
    const searched = (init?: RequestInit) => (JSON.parse(String(init?.body)) as Array<{ keyword: string }>)[0]!.keyword
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const keyword = searched(init)
      const attempt = (attempts.get(keyword) ?? 0) + 1
      attempts.set(keyword, attempt)
      return answer(keyword, attempt)
    })
    vi.stubGlobal('fetch', fetch)
    const h = createSeoHarness({ getSeoRuntime: () => runtime.getRuntime(), onSeoRunRequested: () => runtime.wake() })
    const runtime = new SeoRuntime(h.db, () => config)
    cleanups.push(async () => { await runtime.stop(); await h.close() })
    const now = new Date().toISOString()
    h.db.insert(queries).values([{ id: 'q1', projectId: 'alpha', query: 'solar installer', createdAt: now }, { id: 'q2', projectId: 'alpha', query: 'home battery', createdAt: now }]).run()
    const base = '/api/v1/projects/alpha/seo'
    const saved = await h.app.inject({ method: 'PUT', url: `${base}/profiles/markets`, payload: {
      ...seoProfileFixture, name: 'Market rankings', capabilities: ['market-rankings'], keywords: [], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }],
      scope: { kind: 'project' }, rankings: { locations: [], depth: 10, device: 'mobile', searchText: 'query' },
    } })
    expect(saved.statusCode, saved.body).toBe(200)
    const intent = (await h.app.inject({ method: 'POST', url: `${base}/refresh-intents`, payload: { profileId: 'markets' } })).json()
    const accepted = await h.app.inject({ method: 'POST', url: `${base}/sync`, payload: { quoteToken: intent.token, idempotencyKey: 'rankings' } })
    expect(accepted.statusCode, accepted.body).toBe(202)
    const id = accepted.json().id as string
    return {
      ...h, runtime, fetch, id,
      searched: () => fetch.mock.calls.map(([, init]) => searched(init)),
      status: () => h.db.select().from(seoJobs).where(eq(seoJobs.id, id)).get()?.status,
      holds: () => h.db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros]),
      detail: async () => (await h.app.inject({ url: `${base}/runs/${id}` })).json(),
      listed: async () => (await h.app.inject({ url: `${base}/runs?profileId=markets` })).json().runs[0],
      rows: async () => (await h.app.inject({ url: `${base}/market-rankings?profileId=markets` })).json().items as SeoMarketRanking[],
    }
  }
  const byText = (tasks: SeoTask[]) => tasks.map(task => [task.searchText, task.status, task.retried]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  it('sends a search Google errored on once more after every first attempt, and the retry decides its row', async () => {
    const h = await rankingRefresh((keyword, attempt) => keyword === 'home battery' && attempt === 1 ? googleError(keyword) : ranked(keyword))
    h.runtime.start()
    await vi.waitFor(() => expect(h.status()).toBe('completed'), { timeout: 5000 })
    expect(h.searched()).toHaveLength(3)
    expect(h.searched().slice(0, 2).sort()).toEqual(['home battery', 'solar installer'])
    expect(h.searched()[2]).toBe('home battery')
    // The search reads once, as its retry ended.
    const detail = await h.detail()
    expect(detail).toMatchObject({ status: 'completed', taskCount: 2, completedTasks: 2, failedTasks: 0 })
    expect(byText(detail.tasks)).toEqual([['home battery', 'completed', true], ['solar installer', 'completed', false]])
    expect(await h.listed()).toMatchObject({ taskCount: 2, completedTasks: 2, failedTasks: 0 })
    expect((await h.rows()).map(row => [row.searchText, row.searchStatus, row.rankOrganic])).toEqual([['home battery', 'completed', 3], ['solar installer', 'completed', 3]])
    // The error was free; each page that came back cost 2,000.
    expect(h.holds()).toEqual([[0, 4000], [0, 4000], [0, 4000]])
  })

  it('retries a search only once', async () => {
    const h = await rankingRefresh(keyword => keyword === 'home battery' ? googleError(keyword) : ranked(keyword))
    h.runtime.start()
    await vi.waitFor(() => expect(h.status()).toBe('partial'), { timeout: 5000 })
    expect(h.searched().filter(keyword => keyword === 'home battery')).toHaveLength(2)
    const detail = await h.detail()
    expect(detail).toMatchObject({ status: 'partial', taskCount: 2, completedTasks: 1, failedTasks: 1 })
    expect(byText(detail.tasks)).toEqual([['home battery', 'failed', true], ['solar installer', 'completed', false]])
    expect((await h.rows()).map(row => [row.searchText, row.searchStatus])).toEqual([['home battery', 'failed'], ['solar installer', 'completed']])
    expect(h.holds()).toEqual([[0, 2000], [0, 2000], [0, 2000]])
  })

  it('does not retry past the host spending limits', async () => {
    // A charged error leaves no room under a 4,000 daily limit for another 2,000 search.
    const h = await rankingRefresh(keyword => keyword === 'home battery' ? googleError(keyword, 0.002) : ranked(keyword), { accountDailyLimitMicros: 4000 })
    h.runtime.start()
    await vi.waitFor(() => expect(h.status()).toBe('partial'), { timeout: 5000 })
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.db.select().from(seoTasks).all()).toHaveLength(2)
    expect(h.holds()).toEqual([[0, 4000], [0, 4000], [0, 4000]])
  })

  it('prices a queued retry again before sending it, and withdraws it when the price changed', async () => {
    // Both first attempts error, so each earns a retry. While the second is in flight the pricing catalog
    // moves on under the first one's queued retry, which then must not be sent on its old reservation.
    const h = await rankingRefresh(keyword => {
      if (h.fetch.mock.calls.length === 2) h.db.update(seoTasks).set({ catalogRevision: 'superseded' }).where(eq(seoTasks.status, 'queued')).run()
      return googleError(keyword)
    })
    h.runtime.start()
    await vi.waitFor(() => expect(h.status()).toBe('cancelled'), { timeout: 5000 })
    expect(h.searched()).toHaveLength(2)
    expect(h.db.select().from(seoTasks).all().filter(task => task.retryOf !== null).map(task => task.status)).toEqual(['cancelled', 'cancelled'])
    // The errors were free, and the withdrawn retries hold nothing.
    expect(h.holds()).toEqual([[0, 0], [0, 0], [0, 0]])
  })
})
