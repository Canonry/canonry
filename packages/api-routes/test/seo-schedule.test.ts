import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, runs, seoBudgets, seoJobs } from '@canonry/canonry-db'
import { RunKinds, RunStatuses, RunTriggers } from '@canonry/canonry-contracts'
import { startScheduledSeoRefreshes } from '../src/index.js'
import { createSeoHarness, seedSeoKey, seoProfileFixture } from './seo-fixture.js'

const harnesses: ReturnType<typeof createSeoHarness>[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(h => h.close())) })
const harness = (options: Parameters<typeof createSeoHarness>[0] = {}) => { const h = createSeoHarness(options); harnesses.push(h); return h }

async function saveProfile(h: ReturnType<typeof harness>, id: string, headers = {}) {
  const response = await h.app.inject({ method: 'PUT', url: `/api/v1/projects/alpha/seo/profiles/${id}`, payload: seoProfileFixture, headers })
  expect(response.statusCode, response.body).toBe(200)
}
function runtimeOptions(h: ReturnType<typeof harness>) {
  return { getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'SEO provider', adapter: h.adapter }], policy: h.state.policy }), onSeoRunRequested: (id: string) => { h.requested.push(id) } }
}
const seoRuns = (h: ReturnType<typeof harness>) => h.db.select().from(runs).where(and(eq(runs.projectId, 'alpha'), eq(runs.kind, RunKinds['seo-sync']))).all()
const reserved = (h: ReturnType<typeof harness>) => h.db.select().from(seoBudgets).all().map(row => row.reservedMicros)

// A schedule is the standing approval for paid work, so these pin what it may
// spend: one refresh per profile per occurrence, inside the same host policy.
describe('scheduled SEO refresh', () => {
  it('starts one refresh per saved profile and replays the same occurrence without paying again', async () => {
    const h = harness()
    await saveProfile(h, 'main'); await saveProfile(h, 'second')
    const occurrence = { projectId: 'alpha', scheduleId: 'sched-1', occurrence: '2026-11-02T07:00' }

    const first = startScheduledSeoRefreshes(h.db, runtimeOptions(h), occurrence)
    expect(first.map(outcome => [outcome.profileId, outcome.status])).toEqual([['main', 'started'], ['second', 'started']])
    expect(h.requested).toEqual(first.map(outcome => outcome.runId))
    expect(seoRuns(h).map(run => [run.status, run.trigger])).toEqual([[RunStatuses.queued, RunTriggers.scheduled], [RunStatuses.queued, RunTriggers.scheduled]])
    expect(h.db.select({ actor: auditLog.actor }).from(auditLog).where(eq(auditLog.action, 'seo.sync.requested')).all()).toEqual([{ actor: 'scheduler' }, { actor: 'scheduler' }])
    expect(reserved(h)).toEqual([200, 200, 200])

    const repeat = startScheduledSeoRefreshes(h.db, runtimeOptions(h), occurrence)
    expect(repeat.map(outcome => [outcome.status, outcome.runId])).toEqual(first.map(outcome => ['replayed', outcome.runId]))
    expect(h.requested).toHaveLength(2)
    expect(h.db.select().from(seoJobs).all()).toHaveLength(2)
    expect(reserved(h)).toEqual([200, 200, 200])

    const next = startScheduledSeoRefreshes(h.db, runtimeOptions(h), { ...occurrence, occurrence: '2026-12-02T07:00' })
    expect(next.map(outcome => outcome.status)).toEqual(['started', 'started'])
    expect(reserved(h)).toEqual([400, 400, 400])
    expect(h.state.executions).toBe(0)
  })

  it('records a failed run with the reason when the policy refuses, and reserves nothing', async () => {
    const h = harness()
    await saveProfile(h, 'main')
    h.state.policy.projectMonthlyLimitMicros = 50

    const [outcome] = startScheduledSeoRefreshes(h.db, runtimeOptions(h), { projectId: 'alpha', scheduleId: 'sched-1', occurrence: '2026-11-02T07:00' })
    expect(outcome).toMatchObject({ profileId: 'main', status: 'skipped', reason: 'SEO refresh is unavailable under the current policy.' })
    const [run] = seoRuns(h)
    expect(run).toMatchObject({ id: outcome!.runId, status: RunStatuses.failed, trigger: RunTriggers.scheduled, startedAt: null })
    expect(run!.error).toBe('Scheduled SEO refresh for profile "main" did not start: SEO refresh is unavailable under the current policy.')
    expect(h.db.select().from(seoJobs).all()).toEqual([])
    expect(reserved(h).every(value => value === 0)).toBe(true)
    expect(h.requested).toEqual([])
  })

  it('records why nothing started when the project has no profile or the host has no SEO source', async () => {
    const h = harness()
    const [noProfile] = startScheduledSeoRefreshes(h.db, runtimeOptions(h), { projectId: 'alpha', scheduleId: 'sched-1', occurrence: '2026-11-02T07:00' })
    expect(noProfile).toMatchObject({ profileId: null, status: 'skipped', reason: 'Save an SEO profile first.' })

    await saveProfile(h, 'main')
    const [noSource] = startScheduledSeoRefreshes(h.db, { getSeoRuntime: () => null }, { projectId: 'alpha', scheduleId: 'sched-1', occurrence: '2026-11-02T07:01' })
    expect(noSource).toMatchObject({ profileId: 'main', status: 'skipped', reason: 'SEO execution is not configured on this host.' })
    expect(seoRuns(h).map(run => run.status)).toEqual([RunStatuses.failed, RunStatuses.failed])
    expect(h.db.select().from(seoJobs).all()).toEqual([])
  })
})

describe('seo-sync schedule route', () => {
  const put = (h: ReturnType<typeof harness>, payload: Record<string, unknown>, headers = {}) =>
    h.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/schedule', payload: { kind: 'seo-sync', cron: '0 7 2 * *', ...payload }, headers })

  it('requires a saved profile and the SEO run grant to enable, but not to disable', async () => {
    const h = harness({ skipAuth: false })
    const admin = { authorization: `Bearer ${seedSeoKey(h.db, 'admin', ['*'])}` }
    const writer = { authorization: `Bearer ${seedSeoKey(h.db, 'writer', ['settings.write'])}` }
    const runner = { authorization: `Bearer ${seedSeoKey(h.db, 'runner', ['settings.write', 'seo.run'])}` }

    const noProfile = await put(h, {}, admin)
    expect(noProfile.statusCode).toBe(400)
    expect(noProfile.json().error.message).toBe('Save an SEO profile before scheduling SEO refreshes.')

    await saveProfile(h, 'main', admin)
    expect((await put(h, {}, writer)).statusCode).toBe(403)
    expect((await put(h, { providers: ['openai'] }, admin)).statusCode).toBe(400)

    const created = await put(h, {}, runner)
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ kind: 'seo-sync', cronExpr: '0 7 2 * *', enabled: true })

    const disabled = await put(h, { enabled: false, expectedUpdatedAt: created.json().updatedAt }, writer)
    expect(disabled.statusCode, disabled.body).toBe(200)
    expect(disabled.json().enabled).toBe(false)
    expect((await put(h, { enabled: true, expectedUpdatedAt: disabled.json().updatedAt }, writer)).statusCode).toBe(403)
  })
})
