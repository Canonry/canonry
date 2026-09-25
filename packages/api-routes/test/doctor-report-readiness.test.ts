import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, queries, querySnapshots, runs, measurementPlans, measurementPlanVersions, gaDailyTotals, gscDailyTotals } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json, CitationStates, RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'
import type { DoctorContext } from '../src/doctor/types.js'

const NOW = '2026-09-25T12:00:00.000Z'
describe('monthly report readiness (stored evidence only)', () => {
  let db: ReturnType<typeof createClient>
  let tmp: string
  let project: NonNullable<DoctorContext['project']>
  let queryId: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-doctor-'))
    db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    project = { id: randomUUID(), name: 'client', displayName: 'Client', canonicalDomain: 'https://Client.example/' }
    db.insert(projects).values({ ...project, country: 'US', language: 'en', providers: ['perplexity'], createdAt: '2026-08-01T00:00:00.000Z', updatedAt: NOW }).run()
    queryId = randomUUID()
    db.insert(queries).values({ id: queryId, projectId: project.id, query: 'best service', createdAt: NOW }).run()
  })
  afterEach(() => { vi.useRealTimers(); db.$client.close(); fs.rmSync(tmp, { recursive: true, force: true }) })
  const report = (reportMonth?: string) => runChecks({ db, project, ...(reportMonth ? { reportMonth } : {}) }, ALL_CHECKS, { checkIds: ['report.*'] })
  function sweep(date: string, model: string | null = 'fast', opts: Partial<typeof runs.$inferInsert> = {}) {
    const id = randomUUID()
    db.insert(runs).values({ id, projectId: project.id, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.scheduled, createdAt: `${date}T12:00:00.000Z`, ...opts }).run()
    db.insert(querySnapshots).values({ id: randomUUID(), runId: id, queryId, provider: 'perplexity', model, citationState: CitationStates['not-cited'], answerMentioned: false, answerText: 'Other service', createdAt: `${date}T12:00:00.000Z` }).run()
    return id
  }
  it('registers three default checks with an explicit silent notification policy', async () => {
    const result = await report()
    expect(result.checks.map(c => c.id)).toEqual(['report.sweeps', 'report.models', 'report.daily-data'])
    expect(result.checks.map(c => c.notificationPolicy)).toEqual(['silent', 'silent', 'silent'])
  })
  it('does not clear missing monthly evidence with a probe, failed run, or spot check', async () => {
    sweep('2026-09-10', 'fast', { trigger: RunTriggers.probe })
    sweep('2026-09-11', 'fast', { status: RunStatuses.failed })
    sweep('2026-09-12', 'fast', { measurementScope: { groups: [], targets: ['one'], queries: [], resolvedTargets: ['one'] } })
    expect((await report()).checks.find(c => c.id === 'report.sweeps')).toMatchObject({ status: 'warn', details: { months: [{ month: '2026-09', eligibleRunIds: [], daysRemaining: 5 }] } })
    const eligible = sweep('2026-09-20')
    expect((await report()).checks.find(c => c.id === 'report.sweeps')).toMatchObject({ status: 'ok', details: { months: [{ eligibleRunIds: [eligible] }] } })
  })
  it('uses snapshot model evidence for Simple projects and retains unknown evidence', async () => {
    sweep('2026-08-16', 'sonar')
    sweep('2026-09-15', 'fast')
    expect((await report()).checks.find(c => c.id === 'report.models')).toMatchObject({ status: 'warn', details: { months: [{ month: '2026-09', providers: [{ provider: 'perplexity', status: 'model-discontinuous', fromModels: ['sonar'], toModels: ['fast'], firstObservedAt: '2026-09-15T12:00:00.000Z' }] }] } })
    sweep('2026-09-17', null)
    expect((await report()).checks.find(c => c.id === 'report.models')).toMatchObject({ status: 'warn', details: { months: [{ providers: [{ status: 'model-unknown' }] }] } })
  })
  it('passes stable snapshot models and blocks a mixed-model month', async () => {
    sweep('2026-08-16', 'fast')
    sweep('2026-09-15', 'fast')
    expect((await report()).checks.find(c => c.id === 'report.models')).toMatchObject({ status: 'ok', details: { months: [{ providers: [{ status: 'included' }] }] } })
    sweep('2026-08-17', 'sonar')
    expect((await report()).checks.find(c => c.id === 'report.models')).toMatchObject({ status: 'warn', details: { months: [{ providers: [{ status: 'model-discontinuous', fromModels: ['fast', 'sonar'], toModels: ['fast'] }] }] } })
  })
  it('dates a mixed month from the new model observation rather than the unchanged model', async () => {
    sweep('2026-08-16', 'sonar')
    sweep('2026-09-01', 'sonar')
    sweep('2026-09-15', '  fast  ')
    expect((await report()).checks.find(c => c.id === 'report.models')).toMatchObject({ status: 'warn', details: { months: [{ providers: [{ fromModels: ['sonar'], toModels: ['fast', 'sonar'], firstObservedAt: '2026-09-15T12:00:00.000Z' }] }] } })
  })
  it('passes daily coverage when every mature date was observed, including zeros', async () => {
    for (let day = 1; day <= 22; day++) db.insert(gaDailyTotals).values({ id: randomUUID(), projectId: project.id, date: `2026-09-${String(day).padStart(2, '0')}`, sessions: 0, users: 0, syncedAt: NOW, createdAt: NOW }).run()
    expect((await report()).checks.find(c => c.id === 'report.daily-data')).toMatchObject({ status: 'ok', details: { months: [{ sources: [{ observedDays: 22, observedZeroDays: 22, unknownDays: 0, unknownRanges: [], pendingDays: 8 }] }] } })
  })
  it('retains the closed month through report day and accepts an explicit historical month', async () => {
    vi.setSystemTime('2026-10-03T12:00:00Z')
    expect((await report()).checks.find(c => c.id === 'report.sweeps')).toMatchObject({ details: { months: [{ month: '2026-09' }, { month: '2026-10' }] } })
    expect((await report('2026-08')).checks.find(c => c.id === 'report.sweeps')).toMatchObject({ details: { months: [{ month: '2026-08' }] } })
  })
  it('labels absent daily rows unknown, preserves observed zero, and excludes source latency', async () => {
    db.insert(gaDailyTotals).values({ id: randomUUID(), projectId: project.id, date: '2026-09-01', sessions: 0, users: 0, syncedAt: NOW, createdAt: NOW }).run()
    db.insert(gaDailyTotals).values({ id: randomUUID(), projectId: project.id, date: '2026-09-15', sessions: 3, users: 2, syncedAt: NOW, createdAt: NOW }).run()
    db.insert(gscDailyTotals).values({ id: randomUUID(), projectId: project.id, date: '2026-09-01', clicks: 0, impressions: 0, position: '0', createdAt: NOW }).run()
    const daily = (await report()).checks.find(c => c.id === 'report.daily-data')
    expect(daily).toMatchObject({ status: 'warn', details: { months: [{ sources: [
      { source: 'ga', observedDays: 2, observedZeroDays: 1, confirmedMissingDays: 0, unknownDays: 20, unknownRanges: [{ start: '2026-09-02', end: '2026-09-14' }, { start: '2026-09-16', end: '2026-09-22' }], pendingDays: 8 },
      { source: 'gsc', observedDays: 1, observedZeroDays: 1, confirmedMissingDays: 0, unknownDays: 21, pendingDays: 8 },
    ] }] } })
    expect(daily?.remediation).toContain('canonry ga sync client --days')
    expect(daily?.summary).toMatch(/unknown/i)
  })
  it('validates the entire frozen Advanced manifest, including reused nodes, classes, and providers', async () => {
    const plan = measurementPlanV2Fixture()
    const versionId = randomUUID()
    db.insert(measurementPlanVersions).values({ id: versionId, projectId: project.id, revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(measurementPlans).values({ projectId: project.id, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
    const runId = randomUUID()
    const manifest = buildMeasurementPlanV2Manifest(plan)
    db.insert(runs).values({ id: runId, projectId: project.id, kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW, measurementPlanVersionId: versionId, measurementManifest: manifest }).run()
    let lastId = ''
    for (const slot of manifest.expectedSlots) {
      lastId = randomUUID()
      db.insert(querySnapshots).values({ id: lastId, runId, queryId: null, queryText: slot.queryText, provider: slot.provider, model: 'example-model', answerText: 'Other properties', answerMentioned: false, citationState: CitationStates['not-cited'], measurementExecutionId: slot.executionId, requestedContext: slot.context, supportedContext: { status: 'applied', resolved: slot.context }, location: slot.context?.label ?? null, createdAt: NOW }).run()
    }
    const read = async () => (await report()).checks.find(c => c.id === 'report.sweeps')
    expect(await read()).toMatchObject({ status: 'ok', details: { months: [{ eligibleRunIds: [runId], runs: [{ expected: 4, answered: 4, targetKeys: ['bayside', 'harbor'], queryClasses: ['non-brand', 'branded'], providers: ['gemini', 'openai'] }] }] } })
    db.delete(querySnapshots).where(eq(querySnapshots.id, lastId)).run()
    expect(await read()).toMatchObject({ status: 'warn', details: { months: [{ eligibleRunIds: [], runs: [{ expected: 4, answered: 3 }] }] } })
    db.update(runs).set({ measurementManifest: { schemaVersion: 1, expectedSlots: manifest.expectedSlots.slice(0, 3) } }).where(eq(runs.id, runId)).run()
    expect(await read()).toMatchObject({ status: 'warn', details: { months: [{ runs: [{ reason: 'unreadable-evidence' }] }] } })
  })
  it('resets the default report window only after day 3', async () => {
    vi.setSystemTime('2026-10-04T00:00:00Z')
    expect((await report()).reportMonths).toEqual(['2026-10'])
  })
  it('does not clear Simple readiness when a configured query or provider has no answer', async () => {
    sweep('2026-09-20')
    db.insert(queries).values({ id: randomUUID(), projectId: project.id, query: 'second category', createdAt: NOW }).run()
    expect((await report()).checks.find(c => c.id === 'report.sweeps')).toMatchObject({ status: 'warn', details: { months: [{ runs: [{ expected: 2, answered: 1, reason: 'current-basket' }] }] } })
  })
  it('does not claim onboarding days or delayed source dates are missing', async () => {
    const context = { db, project, reportMonth: '2026-09', googleConnectionStore: {
      getConnection: (_domain: string, type: string) => type === 'ga4' ? { createdAt: '2026-09-24T00:00:00Z' } : undefined,
    } } as DoctorContext
    const result = await runChecks(context, ALL_CHECKS, { checkIds: ['report.daily-data'] })
    expect(result.checks[0]).toMatchObject({ status: 'skipped', details: { months: [{ sources: [{ beforeConnectionDays: 22, pendingDays: 8, unknownDays: 0 }] }] } })
  })
  it('executes new checks without calling providers', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls forbidden'))
    try { const result = await report(); expect(result.checks.some(check => check.code.endsWith('runtime-error'))).toBe(false); expect(fetch).not.toHaveBeenCalled() } finally { fetch.mockRestore() }
  })
  it('skips daily integrations without stored evidence or a connection', async () => {
    expect((await report()).checks.find(c => c.id === 'report.daily-data')).toMatchObject({ status: 'skipped', code: 'report.daily-data.not-connected' })
  })
})
