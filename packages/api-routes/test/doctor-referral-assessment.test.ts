import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, trafficSources, aiReferralEventsHourly, gaAiReferrals, gaTrafficSummaries } from '@ainyc/canonry-db'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'

const CHECK = 'report.ai-referral-bursts'

describe('report.ai-referral-bursts doctor diagnostic', () => {
  let db: ReturnType<typeof createClient>
  const date = '2026-08-01T00:00:00.000Z'
  const project = { id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.com' }
  const run = () => runChecks({ db, project, reportMonth: '2026-08' }, ALL_CHECKS, { checkIds: [CHECK] })
  const referral = (overrides: Partial<typeof aiReferralEventsHourly.$inferInsert> = {}) => {
    db.insert(aiReferralEventsHourly).values({ projectId: 'project', sourceId: 'source', tsHour: date, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: '/', status: 200, sessionsOrHits: 119, organicSessionsOrHits: 119, createdAt: date, updatedAt: date, ...overrides }).run()
  }
  beforeEach(() => {
    db = createClient(':memory:'); migrate(db)
    db.insert(projects).values({ ...project, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Source', status: 'connected', createdAt: date, updatedAt: date }).run()
    referral()
  })
  afterEach(() => db.$client.close())

  it('skips projects with no server traffic source rather than degrading their doctor report', async () => {
    db.delete(trafficSources).run()
    const report = await run()
    expect(report.checks[0]).toMatchObject({ id: CHECK, title: 'AI referral burst evidence', status: 'skipped', code: 'report.ai-referral-bursts.not-configured', notificationPolicy: 'silent' })
    expect(report.summary.warn).toBe(0)
  })

  it('treats a project whose every traffic source is archived as not configured', async () => {
    db.update(trafficSources).set({ status: 'archived', archivedAt: date }).where(eq(trafficSources.id, 'source')).run()
    db.insert(trafficSources).values({ id: 'retired', projectId: 'project', sourceType: 'vercel', displayName: 'Retired', status: 'archived', archivedAt: date, createdAt: date, updatedAt: date }).run()
    const report = await run()
    // The stored 119-hit burst would warn if an archived source counted as configured.
    expect(report.checks[0]).toMatchObject({ status: 'skipped', code: 'report.ai-referral-bursts.not-configured' })
    expect(report.summary).toMatchObject({ warn: 0, skipped: 1 })
    // A paused source is still configured, as `traffic.source.connected` reads it.
    db.update(trafficSources).set({ status: 'paused', archivedAt: null }).where(eq(trafficSources.id, 'source')).run()
    expect((await run()).checks[0]).toMatchObject({ status: 'warn', code: 'report.ai-referral-bursts.bursts' })
  })

  it('shows a high observed quotient without declaring automation or paging', async () => {
    db.insert(gaAiReferrals).values({ id: 'ga', projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sessions: 10, users: 1, syncedAt: date }).run()
    const report = await run()
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({ id: CHECK, notificationPolicy: 'silent', status: 'warn', code: 'report.ai-referral-bursts.bursts', summary: expect.stringContaining('2026-08: 119 suspected hits in 1 candidate group.') })
    expect(report.checks[0]?.details).toMatchObject({ months: [{ month: '2026-08', candidateGroups: 1, comparison: { observedRatio: 11.9, observedRatioAboveThreshold: true, status: 'unavailable', reasons: expect.arrayContaining(['server-coverage-unproven', 'ga-time-zone-unknown']) } }] })
    expect(report.checks[0]?.remediation).toContain('traffic referral-assessment')
    expect(report.checks[0]?.remediation).toContain('cannot verify')
  })

  it('grades only the closed month on report days, so a burst in the new month waits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime('2026-09-02T12:00:00Z')
      // The closed month's burst moves into the new month; August has none left.
      db.update(aiReferralEventsHourly).set({ tsHour: '2026-09-01T10:00:00.000Z' }).run()
      const reportDay = await runChecks({ db, project }, ALL_CHECKS, { checkIds: [CHECK] })
      expect(reportDay.checks[0]).toMatchObject({ status: 'ok', code: 'report.ai-referral-bursts.no-bursts', summary: expect.stringContaining('bursts in 2026-08.') })
      expect(reportDay.checks[0]?.details).toMatchObject({ months: [
        { month: '2026-08', graded: true, suspected: { total: 0 } },
        { month: '2026-09', graded: false, suspected: { total: 119 } },
      ] })
      // After day 3 the new month is the report month and its burst counts.
      vi.setSystemTime('2026-09-04T12:00:00Z')
      expect((await runChecks({ db, project }, ALL_CHECKS, { checkIds: [CHECK] })).checks[0]).toMatchObject({ status: 'warn', code: 'report.ai-referral-bursts.bursts' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts candidate groups, not hours: two paths in one hour are two groups', async () => {
    referral({ landingPathNormalized: '/pricing', sessionsOrHits: 150, organicSessionsOrHits: 150 })
    const report = await run()
    expect(report.checks[0]?.summary).toContain('2026-08: 269 suspected hits in 2 candidate groups.')
    expect(report.checks[0]?.details).toMatchObject({ months: [{ month: '2026-08', candidateGroups: 2, suspected: { total: 269 } }] })
    expect(report.checks[0]?.details).not.toHaveProperty('months.0.candidateHours')
  })

  it('distinguishes absent GA evidence from a synced window with no AI sessions and does not emit infinity', async () => {
    const missing = await run()
    expect(missing.checks[0]?.details).toMatchObject({ months: [{ comparison: { gaSessions: null, gaObservation: 'missing', observedRatio: null } }] })
    // The latest GA sync queried the whole month and stored no AI row: GA4 omits zero rows.
    db.insert(gaTrafficSummaries).values({ id: 'summary', projectId: 'project', periodStart: '2026-07-20', periodEnd: '2026-09-02', totalSessions: 400, totalOrganicSessions: 150, totalUsers: 310, syncedAt: '2026-09-02T06:00:00.000Z' }).run()
    const zero = await run()
    expect(zero.checks[0]?.details).toMatchObject({ months: [{ comparison: { gaSessions: 0, gaObservation: 'observed-zero', observedRatio: null, observedRatioAboveThreshold: null, reasons: expect.arrayContaining(['ga-observed-zero', 'ga-coverage-unproven']) } }] })
    expect(zero.checks[0]?.status).toBe('warn')
  })

  it('passes, keeping the descriptive quotient, when no hour qualifies as a burst', async () => {
    db.update(aiReferralEventsHourly).set({ sessionsOrHits: 40, organicSessionsOrHits: 40 }).run()
    db.insert(gaAiReferrals).values({ id: 'ga', projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sessions: 10, users: 1, syncedAt: date }).run()
    const report = await run()
    // A 4x quotient is above the default threshold of 3, yet it is not a
    // warning: coverage is unproven, so only a burst is worth reviewing.
    expect(report.checks[0]).toMatchObject({ status: 'ok', code: 'report.ai-referral-bursts.no-bursts', remediation: null, details: { months: [{ month: '2026-08', candidateGroups: 0, suspected: { total: 0 }, comparison: { observedRatio: 4, observedRatioAboveThreshold: true, status: 'unavailable' } }] } })
    expect(report.summary).toMatchObject({ ok: 1, warn: 0 })
  })

  it('reports a missing project context as skipped', async () => {
    // The runner never selects a project check without a project, so call it directly.
    const check = ALL_CHECKS.find(candidate => candidate.id === CHECK)!
    expect(await check.run({ db, project: null, reportMonth: '2026-08' })).toMatchObject({ status: 'skipped', code: 'report.ai-referral-bursts.no-project' })
  })
})
