import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, trafficSources, aiReferralEventsHourly, gaAiReferrals } from '@ainyc/canonry-db'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'

describe('report.ai-referral-ratio doctor diagnostic', () => {
  let db: ReturnType<typeof createClient>
  const date = '2026-08-01T00:00:00.000Z'
  const project = { id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.com' }
  beforeEach(() => {
    db = createClient(':memory:'); migrate(db)
    db.insert(projects).values({ ...project, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Source', status: 'connected', createdAt: date, updatedAt: date }).run()
    db.insert(aiReferralEventsHourly).values({ projectId: 'project', sourceId: 'source', tsHour: date, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: '/', status: 200, sessionsOrHits: 119, organicSessionsOrHits: 119, createdAt: date, updatedAt: date }).run()
  })
  afterEach(() => db.$client.close())

  it('skips projects with no server traffic source rather than degrading their doctor report', async () => {
    db.delete(trafficSources).run()
    const report = await runChecks({ db, project, reportMonth: '2026-08' }, ALL_CHECKS, { checkIds: ['report.ai-referral-ratio'] })
    expect(report.checks[0]).toMatchObject({ status: 'skipped', code: 'report.ai-referral-ratio.not-configured', notificationPolicy: 'silent' })
    expect(report.summary.warn).toBe(0)
  })

  it('shows a high observed quotient without declaring automation or paging', async () => {
    db.insert(gaAiReferrals).values({ id: 'ga', projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sessions: 10, users: 1, syncedAt: date }).run()
    const report = await runChecks({ db, project, reportMonth: '2026-08' }, ALL_CHECKS, { checkIds: ['report.ai-referral-ratio'] })
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({ id: 'report.ai-referral-ratio', notificationPolicy: 'silent', status: 'warn', code: 'report.ai-referral-ratio.coverage-unknown' })
    expect(report.checks[0]?.details).toMatchObject({ months: [{ month: '2026-08', comparison: { observedRatio: 11.9, observedRatioAboveThreshold: true, status: 'unavailable', reasons: expect.arrayContaining(['server-coverage-unproven', 'ga-time-zone-unknown']) } }] })
    expect(report.checks[0]?.remediation).toContain('traffic referral-assessment')
    expect(report.checks[0]?.remediation).toContain('cannot verify')
  })

  it('distinguishes absent GA evidence from explicit zero and does not emit infinity', async () => {
    const missing = await runChecks({ db, project, reportMonth: '2026-08' }, ALL_CHECKS, { checkIds: ['report.ai-referral-ratio'] })
    expect(missing.checks[0]?.details).toMatchObject({ months: [{ comparison: { gaSessions: null, gaObservation: 'missing', observedRatio: null } }] })
    db.insert(gaAiReferrals).values({ id: 'zero', projectId: 'project', date: '2026-08-01', source: 'chatgpt.com', medium: 'referral', sessions: 0, users: 0, syncedAt: date }).run()
    const zero = await runChecks({ db, project, reportMonth: '2026-08' }, ALL_CHECKS, { checkIds: ['report.ai-referral-ratio'] })
    expect(zero.checks[0]?.details).toMatchObject({ months: [{ comparison: { gaSessions: 0, gaObservation: 'observed-zero', observedRatio: null } }] })
    expect(zero.checks[0]?.status).toBe('warn')
  })
})
