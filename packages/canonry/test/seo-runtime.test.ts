import { afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { seoBudgets, seoJobs, seoTasks } from '@canonry/canonry-db'
import type { SeoInstallConfig } from '@canonry/canonry-config'
import { SeoRuntime } from '../src/seo-runtime.js'
import { createSeoHarness, seoProfileFixture } from '../../api-routes/test/seo-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.unstubAllGlobals(); vi.useRealTimers() })
async function setup(dailyLimit = 1_000_000) {
  const config: SeoInstallConfig = { enabled: true, fundingMode: 'hosted', policy: { maxRunCostMicros: 100_000, accountDailyLimitMicros: 1_000_000, accountMonthlyLimitMicros: 1_000_000, projectMonthlyLimitMicros: 1_000_000 }, connections: { primary: { provider: 'dataforseo', label: 'SEO data', enabled: true, login: 'operator@example.com', password: 'test-secret' } } }
  config.policy.accountDailyLimitMicros = dailyLimit
  const h = createSeoHarness({ getSeoRuntime: () => runtime.getRuntime(), onSeoRunRequested: () => runtime.wake() })
  const runtime = new SeoRuntime(h.db, () => config)
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
