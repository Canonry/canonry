import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeoRepository, emptySeoResults, queries, seoTasks } from '@canonry/canonry-db'
import { SeoCapabilities, SeoProviders, type SeoAdapter, type SeoAdapterResult, type SeoProfileInput, type SeoQuote, type SeoRun } from '@canonry/canonry-contracts'
import { startScheduledSeoRefreshes } from '../src/index.js'
import { ALL_CHECKS, scheduledHealthCheckIds } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'
import type { CheckDefinition, ProjectInfo } from '../src/doctor/types.js'
import { createSeoHarness, seoProfileFixture } from './seo-fixture.js'

// Every fixture here is written by the production path: profiles and schedules
// through the API, firings through the scheduler's host callback, and outcomes
// through the repository the SEO runtime settles with. The clock is pinned so
// the dates in each message are exact.

const CHECK_ID = 'seo.data.recent-refresh'
const check: CheckDefinition = (() => {
  const registered = ALL_CHECKS.find(candidate => candidate.id === CHECK_ID)
  if (!registered) throw new Error(`${CHECK_ID} is not registered`)
  return registered
})()
const project: ProjectInfo = { id: 'alpha', name: 'alpha', canonicalDomain: 'alpha.com', displayName: 'alpha' }

let h: ReturnType<typeof createSeoHarness>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'))
  h = createSeoHarness()
})
afterEach(async () => {
  await h.close()
  vi.useRealTimers()
})

const at = (iso: string) => vi.setSystemTime(new Date(iso))
const grade = async (iso: string) => {
  at(iso)
  return check.run({ db: h.db, project })
}

async function saveProfile(id: string, overrides: Partial<SeoProfileInput> = {}) {
  const response = await h.app.inject({ method: 'PUT', url: `/api/v1/projects/alpha/seo/profiles/${id}`, payload: { ...seoProfileFixture, ...overrides } })
  expect(response.statusCode, response.body).toBe(200)
}

/** Monthly on the 2nd at 07:00 UTC unless the payload says otherwise. */
async function setSchedule(payload: Record<string, unknown> = {}): Promise<string> {
  const response = await h.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/schedule', payload: { kind: 'seo-sync', cron: '0 7 2 * *', timezone: 'UTC', ...payload } })
  expect(response.statusCode, response.body).toBeLessThan(300)
  return response.json<{ id: string }>().id
}

/** One schedule firing, as the scheduler's host callback runs it. */
function fire(occurrence: string, scheduleId: string, projectId = 'alpha', adapter: SeoAdapter = h.adapter) {
  at(occurrence)
  const runtime = {
    getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'SEO provider', adapter }], policy: h.state.policy }),
    onSeoRunRequested: (id: string) => { h.requested.push(id) },
  }
  return startScheduledSeoRefreshes(h.db, runtime, { projectId, scheduleId, occurrence: occurrence.slice(0, 16) })
}

/** The SEO runtime executing an admitted refresh's next request and storing what came back. */
/**
 * The SEO runtime executing an admitted refresh's next request and storing what came back, under
 * the host's limits. `'google-error'` is a failure the search engine itself returned, which earns a retry.
 */
function settle(runId: string, outcomeFor: SeoAdapterResult['outcome'] | ((searchText: string) => SeoAdapterResult['outcome'] | 'google-error')) {
  const repository = new SeoRepository(h.db)
  const task = repository.claim(runId, { ...h.state.policy, accountKey: h.state.accountKey })
  if (!task) throw new Error(`refresh ${runId} had nothing to claim`)
  const ended = typeof outcomeFor === 'function' ? outcomeFor(task.request.keywords[0] ?? '') : outcomeFor
  const outcome = ended === 'google-error' ? 'failed' : ended
  repository.settle(task.id, {
    outcome,
    ...(ended === 'google-error' ? { retryable: true } : {}),
    tasks: [{ remoteTaskId: task.id, statusCode: outcome === 'completed' ? 20000 : ended === 'google-error' ? 40101 : 40000, costMicros: 10 }],
    results: emptySeoResults(),
    error: outcome === 'completed' ? null : 'Some SEO provider results could not be collected.',
    fetchedAt: new Date().toISOString(),
  }, task.leaseOwner!, h.state.policy)
}

async function refreshByHand(profileId = 'main'): Promise<string> {
  const intent = await h.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/seo/refresh-intents', payload: { profileId } })
  expect(intent.statusCode, intent.body).toBe(200)
  const accepted = await h.app.inject({ method: 'POST', url: '/api/v1/projects/alpha/seo/sync', payload: { quoteToken: intent.json<SeoQuote>().token, idempotencyKey: `by-hand-${profileId}` } })
  expect(accepted.statusCode, accepted.body).toBe(202)
  return accepted.json<SeoRun>().id
}

describe('seo.data.recent-refresh', () => {
  it('skips a project with no enabled schedule, even one whose last firing failed', async () => {
    expect(await grade('2026-10-25T12:00:00.000Z')).toEqual({
      status: 'skipped', code: 'seo.data.not-scheduled', summary: 'No SEO refresh schedule is set for this project.', remediation: null,
    })

    await saveProfile('main')
    const scheduleId = await setSchedule()
    h.state.policy.projectMonthlyLimitMicros = 50
    expect(fire('2026-11-02T07:00:00.000Z', scheduleId)).toMatchObject([{ status: 'skipped' }])
    at('2026-11-02T08:00:00.000Z')
    await setSchedule({ enabled: false })
    // Paused schedules spend nothing and can miss no cadence.
    expect(await grade('2026-12-10T12:00:00.000Z')).toEqual({
      status: 'skipped', code: 'seo.data.not-scheduled', summary: 'The SEO refresh schedule is disabled.', remediation: null,
    })
  })

  it('is healthy while the first firing is pending and after it completes', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    expect(await grade('2026-10-26T12:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.awaiting-first-refresh', summary: 'No SEO refresh has completed yet. The first scheduled refresh is due 2026-11-02.',
    })

    const [started] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    expect(started).toMatchObject({ status: 'started' })
    expect(await grade('2026-11-02T07:05:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.awaiting-first-refresh',
      summary: 'No SEO refresh has completed yet. The first scheduled refresh, due 2026-11-02, has until 2026-11-04 to complete.',
    })

    at('2026-11-02T07:10:00.000Z')
    settle(started!.runId, 'completed')
    // Another project's failed firing never answers for this one.
    expect(fire('2026-11-02T07:20:00.000Z', 'beta-schedule', 'beta')).toMatchObject([{ status: 'skipped' }])
    expect(await grade('2026-11-10T12:00:00.000Z')).toMatchObject({
      status: 'ok',
      code: 'seo.data.fresh',
      summary: 'The last SEO refresh completed on 2026-11-02. The next scheduled refresh is due 2026-12-02.',
      remediation: null,
      details: { lastCompletedRunId: started!.runId, dueAt: '2026-12-02T07:00:00.000Z', deadlineAt: '2026-12-04T07:00:00.000Z' },
    })
  })

  it('warns with the stored reason when the latest firing failed, until a refresh completes', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    h.state.policy.projectMonthlyLimitMicros = 50
    const [skipped] = fire('2026-11-02T07:00:00.000Z', scheduleId)

    const failed = await grade('2026-11-02T12:00:00.000Z')
    expect(failed).toEqual({
      status: 'warn',
      code: 'seo.data.refresh-failed',
      summary: 'The scheduled SEO refresh on 2026-11-02 failed. Reason: Scheduled SEO refresh for profile "main" did not start: SEO refresh is unavailable under the current policy. No SEO refresh has completed yet.',
      remediation: 'Fix what the reason names, then refresh now with `canonry seo refresh-intent alpha <profile-id>` and `canonry seo sync`, or wait for the next scheduled refresh on 2026-12-02. A completed refresh of the same profile clears this warning.',
      details: expect.objectContaining({
        latestScheduledRuns: [{ id: skipped!.runId, profileId: 'main', status: 'failed', createdAt: '2026-11-02T07:00:00.000Z', reason: 'Scheduled SEO refresh for profile "main" did not start: SEO refresh is unavailable under the current policy.' }],
      }),
      alert: {
        label: 'SEO refresh failed',
        line: 'Scheduled SEO refresh for profile "main" did not start: SEO refresh is unavailable under the current policy.',
        next: 'Fix the cause, then refresh by hand or wait for the next scheduled refresh on 2026-12-02.',
      },
    })

    // The six-hourly health pass grades it, so it reaches health alerts.
    const pass = await runChecks({ db: h.db, project }, ALL_CHECKS, { checkIds: scheduledHealthCheckIds() })
    expect(pass.checks.find(result => result.id === CHECK_ID)).toMatchObject({ status: 'warn', code: 'seo.data.refresh-failed' })

    // The operator lifts the limit and refreshes by hand. Accepted is not
    // completed; only a completed refresh clears the failure.
    h.state.policy.projectMonthlyLimitMicros = 1000
    at('2026-11-03T09:00:00.000Z')
    const manual = await refreshByHand()
    expect(await grade('2026-11-03T09:05:00.000Z')).toMatchObject({ code: 'seo.data.refresh-failed' })
    at('2026-11-03T09:10:00.000Z')
    settle(manual, 'completed')
    expect(await grade('2026-11-03T10:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.fresh', summary: 'The last SEO refresh completed on 2026-11-03. The next scheduled refresh is due 2026-12-02.',
    })
  })

  it('names the reason a refresh that ran left on its requests, and grades a partial result on its own code', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    const [failed] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    at('2026-11-02T07:10:00.000Z')
    settle(failed!.runId, 'failed')
    expect(await grade('2026-11-02T12:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.refresh-failed',
      summary: 'The scheduled SEO refresh on 2026-11-02 failed. Reason: The SEO provider could not complete this task. No SEO refresh has completed yet.',
      alert: { line: 'The scheduled SEO refresh on 2026-11-02 failed: The SEO provider could not complete this task.' },
    })

    const [partial] = fire('2026-12-02T07:00:00.000Z', scheduleId)
    at('2026-12-02T07:10:00.000Z')
    settle(partial!.runId, 'partial')
    expect(await grade('2026-12-02T12:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.refresh-partial',
      summary: 'The scheduled SEO refresh on 2026-12-02 only partly completed. Reason: Some SEO results could not be collected. No SEO refresh has completed yet.',
      alert: { label: 'SEO refresh incomplete', line: 'The scheduled SEO refresh on 2026-12-02 only partly completed: Some SEO results could not be collected.' },
    })
  })

  it('counts how a market-rankings refresh\'s searches ended, since each search is one request', async () => {
    // A source that can rank tracked queries, priced like the live results-page catalog.
    const rankings: SeoAdapter = { provider: SeoProviders.dataforseo, accountKey: h.state.accountKey, capabilities: [...h.adapter.capabilities, SeoCapabilities['market-rankings']], estimate: () => ({ maxCostMicros: 100, catalogRevision: 'prices-1' }), execute: h.adapter.execute }
    await h.close()
    h = createSeoHarness({ getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'SEO provider', adapter: rankings }], policy: h.state.policy }) })
    h.db.insert(queries).values(['best solar installer', 'solar panel cost', 'home battery backup'].map((query, index) => ({ id: `q${index}`, projectId: 'alpha', query, createdAt: new Date().toISOString() }))).run()
    const profile = await h.app.inject({ method: 'PUT', url: '/api/v1/projects/alpha/seo/profiles/main', payload: {
      ...seoProfileFixture, name: 'Market rankings', capabilities: [SeoCapabilities['market-rankings']], keywords: [], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }],
      scope: { kind: 'project' }, rankings: { locations: [], depth: 50, device: 'mobile', searchText: 'query' },
    } })
    expect(profile.statusCode, profile.body).toBe(200)
    const scheduleId = await setSchedule()
    const [refresh] = fire('2026-11-02T07:00:00.000Z', scheduleId, 'alpha', rankings)
    at('2026-11-02T07:10:00.000Z')
    // Google errors on one search; its one retry, at the end of the refresh, errors again.
    const ended: Record<string, SeoAdapterResult['outcome'] | 'google-error'> = { 'best solar installer': 'completed', 'solar panel cost': 'google-error', 'home battery backup': 'partial' }
    for (let attempts = 0; attempts < 4; attempts++) settle(refresh!.runId, text => ended[text]!)
    expect(h.db.select().from(seoTasks).all()).toHaveLength(4)
    expect(await grade('2026-11-02T12:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.refresh-partial',
      summary: 'The scheduled SEO refresh on 2026-11-02 only partly completed. Reason: Of 3 searches, 1 failed and 1 returned only part of their results. The SEO provider could not complete this task. No SEO refresh has completed yet.',
    })
  })

  it('grades every profile refresh of the latest firing, not only the newest run', async () => {
    await saveProfile('main')
    await saveProfile('second')
    const scheduleId = await setSchedule()
    const [main, second] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    at('2026-11-02T07:10:00.000Z')
    settle(main!.runId, 'failed')
    settle(second!.runId, 'completed')
    expect(await grade('2026-11-02T12:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.refresh-failed',
      summary: '1 of 2 profile refreshes in the scheduled SEO refresh on 2026-11-02 did not fully complete. Reason: The SEO provider could not complete this task. The last completed SEO refresh was on 2026-11-02.',
      alert: { line: '1 of 2 profile refreshes in the scheduled SEO refresh on 2026-11-02 did not fully complete.' },
    })
  })

  it('warns when no refresh completed within two days of the firing that was due', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    const [november] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    at('2026-11-02T07:10:00.000Z')
    settle(november!.runId, 'completed')

    // The December firing never happens.
    expect(await grade('2026-12-04T06:59:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.fresh',
      summary: 'The last SEO refresh completed on 2026-11-02. The scheduled refresh due 2026-12-02 has until 2026-12-04 to complete.',
    })
    expect(await grade('2026-12-04T07:00:00.000Z')).toEqual({
      status: 'warn',
      code: 'seo.data.overdue',
      summary: 'No SEO refresh has completed since 2026-11-02. The scheduled refresh due 2026-12-02 did not complete within 2 days.',
      remediation: 'Check that the server was running on 2026-12-02 and what `canonry runs alpha --kind seo-sync` shows for that day. To refresh now, run `canonry seo refresh-intent alpha <profile-id>`, then `canonry seo sync`.',
      details: expect.objectContaining({ lastCompletedRunId: november!.runId, dueAt: '2026-12-02T07:00:00.000Z', deadlineAt: '2026-12-04T07:00:00.000Z', activeRunId: null }),
      alert: { label: 'SEO refresh overdue', line: 'No SEO refresh has completed since 2026-11-02.', next: 'Check that the server was up on 2026-12-02, then refresh by hand.' },
    })
  })

  it('points at a refresh that never finished, since scheduled firings wait for it', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    const [stuck] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    expect(await grade('2026-11-04T08:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.overdue',
      summary: 'No SEO refresh has completed since the schedule was enabled. Its first refresh, due 2026-11-02, did not complete within 2 days. A refresh started 2026-11-02 has not finished, and scheduled refreshes wait for it.',
      remediation: `Check that refresh with \`canonry seo run show alpha ${stuck!.runId}\`, and cancel it with \`canonry seo run cancel alpha ${stuck!.runId}\` if it is stuck.`,
      details: { activeRunId: stuck!.runId },
    })
  })

  it('warns when the schedule has no time it can run', async () => {
    await saveProfile('main')
    // February 31st passes cron validation, but the scheduler never fires it.
    await setSchedule({ cron: '0 7 31 2 *' })
    expect(await grade('2026-10-26T12:00:00.000Z')).toMatchObject({
      status: 'warn',
      code: 'seo.data.schedule-invalid',
      summary: 'The SEO refresh schedule has no time it can run, so no scheduled SEO refresh will start.',
      details: { cronExpr: '0 7 31 2 *', dueAt: null },
    })
  })

  it('clears a profile\'s failure only with a newer completed refresh of that same profile', async () => {
    // "wide" adds ranked keywords: two requests, over a 150 run ceiling, so the firing cannot start it.
    await saveProfile('main')
    await saveProfile('wide', { capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['ranked-keywords']], targets: [{ kind: 'domain', value: 'alpha.com', includeSubdomains: true }] })
    const scheduleId = await setSchedule()
    h.state.policy.maxRunCostMicros = 150
    const [main, wide] = fire('2026-11-02T07:00:00.000Z', scheduleId)
    expect([main?.status, wide?.status]).toEqual(['started', 'skipped'])
    at('2026-11-02T07:10:00.000Z')
    settle(main!.runId, 'completed')
    const failing = { status: 'warn', code: 'seo.data.refresh-failed', summary: expect.stringMatching(/^1 of 2 profile refreshes in the scheduled SEO refresh on 2026-11-02 did not fully complete\. Reason: Scheduled SEO refresh for profile "wide" did not start: SEO refresh is unavailable under the current policy\. /) }
    expect(await grade('2026-11-02T12:00:00.000Z')).toMatchObject(failing)

    // A manual refresh of the other profile does not make good the one that failed.
    at('2026-11-03T09:00:00.000Z')
    const otherProfile = await refreshByHand('main')
    at('2026-11-03T09:05:00.000Z')
    settle(otherProfile, 'completed')
    expect(await grade('2026-11-03T10:00:00.000Z')).toMatchObject(failing)

    // The failed profile's own refresh does.
    h.state.policy.maxRunCostMicros = 1000
    at('2026-11-04T09:00:00.000Z')
    const sameProfile = await refreshByHand('wide')
    at('2026-11-04T09:05:00.000Z')
    settle(sameProfile, 'completed')
    settle(sameProfile, 'completed')
    expect(await grade('2026-11-04T10:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.fresh', summary: 'The last SEO refresh completed on 2026-11-04. The next scheduled refresh is due 2026-12-02.',
    })
  })

  it('never counts time the schedule spent disabled as overdue', async () => {
    await saveProfile('main')
    // Created disabled on October 25 and enabled on November 25: the first enabled firing is December 2.
    await setSchedule({ enabled: false })
    at('2026-11-25T12:00:00.000Z')
    await setSchedule()
    expect(await grade('2026-11-26T12:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.awaiting-first-refresh', summary: 'No SEO refresh has completed yet. The first scheduled refresh is due 2026-12-02.',
    })
    expect(await grade('2026-12-04T07:00:00.000Z')).toMatchObject({
      status: 'warn', code: 'seo.data.overdue',
      summary: 'No SEO refresh has completed since the schedule was enabled. Its first refresh, due 2026-12-02, did not complete within 2 days.',
    })
  })

  it('starts a re-enabled schedule fresh, without the failures from before its pause', async () => {
    await saveProfile('main')
    const scheduleId = await setSchedule()
    h.state.policy.projectMonthlyLimitMicros = 50
    fire('2026-11-02T07:00:00.000Z', scheduleId)
    at('2026-11-03T09:00:00.000Z')
    await setSchedule({ enabled: false })
    at('2026-11-25T12:00:00.000Z')
    await setSchedule()
    expect(await grade('2026-11-26T12:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.awaiting-first-refresh', summary: 'No SEO refresh has completed yet. The first scheduled refresh is due 2026-12-02.',
    })
  })

  it('starts a recreated schedule fresh, without the removed schedule\'s failures', async () => {
    await saveProfile('main')
    const removed = await setSchedule()
    h.state.policy.projectMonthlyLimitMicros = 50
    fire('2026-11-02T07:00:00.000Z', removed)
    at('2026-11-03T09:00:00.000Z')
    const deleted = await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/alpha/schedule?kind=seo-sync' })
    expect(deleted.statusCode, deleted.body).toBe(204)
    await setSchedule()
    expect(await grade('2026-11-03T10:00:00.000Z')).toMatchObject({
      status: 'ok', code: 'seo.data.awaiting-first-refresh', summary: 'No SEO refresh has completed yet. The first scheduled refresh is due 2026-12-02.',
    })
  })
})
