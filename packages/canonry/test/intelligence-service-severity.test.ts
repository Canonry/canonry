/**
 * IntelligenceService severity tiering — verifies that the pure
 * classifier in @ainyc/canonry-intelligence is wired into analyzeAndPersist
 * so the persisted insight rows carry traffic-aware and recurrence-aware
 * severity instead of the legacy hardcoded 'high'.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  queries,
  querySnapshots,
  insights,
  gscQueryDailyTotals,
  gscSearchData,
} from '@ainyc/canonry-db'
import { IntelligenceService } from '../src/intelligence-service.js'

function createTempDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

interface SeededRegression {
  projectId: string
  queryId: string
  previousRunId: string
  currentRunId: string
}

function seedRegressionScenario(
  db: ReturnType<typeof createClient>,
  opts: { gscImpressions?: number
  gscDate?: string
  skipAccurateGsc?: boolean; priorRegressions?: number } = {},
): SeededRegression {
  const now = new Date()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'sev',
    displayName: 'Sev',
    canonicalDomain: 'sev.example.com',
    country: 'US',
    language: 'en',
    providers: ['gemini'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'foo query',
    createdAt: now.toISOString(),
  }).run()

  const previousRunId = crypto.randomUUID()
  const currentRunId = crypto.randomUUID()
  const previousAt = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  db.insert(runs).values({
    id: previousRunId,
    projectId,
    status: 'completed',
    createdAt: previousAt,
    finishedAt: previousAt,
  }).run()
  db.insert(runs).values({
    id: currentRunId,
    projectId,
    status: 'completed',
    createdAt: now.toISOString(),
    finishedAt: now.toISOString(),
  }).run()

  // Previous run: cited
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: previousRunId,
    queryId,
    provider: 'gemini',
    model: 'test',
    citationState: 'cited',
    citedDomains: ['sev.example.com'],
    competitorOverlap: [],
    createdAt: previousAt,
  }).run()
  // Current run: not-cited (regression)
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: currentRunId,
    queryId,
    provider: 'gemini',
    model: 'test',
    citationState: 'not-cited',
    citedDomains: [],
    competitorOverlap: [],
    createdAt: now.toISOString(),
  }).run()

  if (opts.gscImpressions !== undefined) {
    // Severity reads gsc_query_daily_totals, not gsc_search_data. The latter is
    // keyed by page as well as query, so summing it counts one SERP impression
    // once per ranking page. The date is inside the severity window, which is
    // anchored on the newest published GSC day.
    const gscDate = opts.gscDate ?? '2026-04-01'
    if (!opts.skipAccurateGsc) db.insert(gscQueryDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: currentRunId,
      date: gscDate,
      query: 'foo query',
      impressions: opts.gscImpressions,
      clicks: 0,
      position: '10',
      syncedAt: now.toISOString(),
      createdAt: now.toISOString(),
    }).run()
    // A page-fanned row for the same query on the same day. If severity ever
    // reverts to gsc_search_data this doubles the impressions and the tier
    // assertions below fail, which is the point of seeding it.
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: currentRunId,
      date: gscDate,
      query: 'foo query',
      page: '/foo',
      impressions: opts.gscImpressions,
      clicks: 0,
      ctr: '0',
      position: '10',
      createdAt: now.toISOString(),
    }).run()
  }

  // Pre-existing regression insights for recurrence signal
  for (let i = 0; i < (opts.priorRegressions ?? 0); i++) {
    const oldRunId = crypto.randomUUID()
    const oldAt = new Date(now.getTime() - (i + 2) * 24 * 60 * 60_000).toISOString()
    db.insert(runs).values({
      id: oldRunId,
      projectId,
      status: 'completed',
      createdAt: oldAt,
      finishedAt: oldAt,
    }).run()
    db.insert(insights).values({
      id: crypto.randomUUID(),
      projectId,
      runId: oldRunId,
      type: 'regression',
      severity: 'high',
      title: 'Lost gemini citation for "foo query"',
      query: 'foo query',
      provider: 'gemini',
      recommendation: null,
      cause: null,
      dismissed: false,
      createdAt: oldAt,
    }).run()
  }

  return { projectId, queryId, previousRunId, currentRunId }
}

function persistedSeverity(db: ReturnType<typeof createClient>, runId: string): string | undefined {
  const row = db.select({ severity: insights.severity, type: insights.type })
    .from(insights)
    .where(eq(insights.runId, runId))
    .all()
    .find(r => r.type === 'regression')
  return row?.severity
}

import { eq } from 'drizzle-orm'

describe('IntelligenceService — regression severity tiering', () => {
  it('persists "critical" when both high traffic and recurrence are present', () => {
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, {
      gscImpressions: 500,
      priorRegressions: 3,
    })

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('critical')
  })

  it('persists "high" when only one signal qualifies (high traffic, no history)', () => {
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, { gscImpressions: 500 })

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('high')
  })

  it('persists "medium" when traffic is moderate and no recurrence', () => {
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, { gscImpressions: 25 })

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('medium')
  })

  it('falls back to page-summed impressions when the accurate table has no row for that day', () => {
    // readLatestGscDataDate anchors on the watermark, the property table or the
    // dimensioned table, never on gsc_query_daily_totals, so a project can look
    // connected while the accurate table lags the window. An empty fallback
    // would report zero impressions for every query and tier every regression
    // DOWN, which is the direction the fixed 100/10 thresholds are least able
    // to survive. 500 page-summed impressions must still reach "high".
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, {
      gscImpressions: 500,
      skipAccurateGsc: true,
    })

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('high')
  })

  it('persists "low" when neither traffic nor recurrence qualify', () => {
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, { gscImpressions: 0 })

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('low')
  })

  it('persists "low" when no GSC data exists but history confirms it is a one-off (recurrence=0)', () => {
    // Scenario seeds a previous run with no prior regression — history is
    // available and reports "no recurrence", so we trust that signal even
    // without GSC traffic data.
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db) // no GSC, prior run is clean

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('low')
  })

  it('returns the tiered severity to the caller (so RunCoordinator/webhooks see it)', () => {
    // RunCoordinator and dispatchInsightWebhooks classify by the AnalysisResult
    // returned from analyzeAndPersist. If the return value still carried the
    // legacy 'high' severity, persisted 'critical' regressions would never fire
    // insight.critical webhooks and 'low' regressions would still announce as
    // 'high' to Aero.
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, {
      gscImpressions: 500,
      priorRegressions: 3,
    })

    const result = new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(result).not.toBeNull()
    const regression = result!.insights.find(i => i.type === 'regression')
    expect(regression).toBeDefined()
    expect(regression!.severity).toBe('critical')
    // The persisted row carries the same severity.
    expect(persistedSeverity(db, currentRunId)).toBe('critical')

    // One prior two-location group counts once, even with duplicate current
    // group receipts. At eight locations, two qualifying old groups must
    // remain inside the five-group window despite forty newer sibling rows.
    const scenarios = [
      { locationCount: 2, priorGroups: 2, regressionDays: [2], expectedSeverity: 'high' },
      { locationCount: 8, priorGroups: 5, regressionDays: [4, 5], expectedSeverity: 'critical' },
    ]
    for (const scenario of scenarios) {
      const groupedDb = createTempDb('intel-sev-group-')
      const { projectId: groupedProject, queryId, previousRunId, currentRunId: groupedCurrent } = seedRegressionScenario(groupedDb, {
        gscImpressions: 500,
      })
      groupedDb.update(projects).set({
        locations: Array.from({ length: scenario.locationCount }, (_, i) => ({ label: `loc${i}`, city: 'Orlando', region: 'Florida', country: 'US' })),
      }).where(eq(projects.id, groupedProject)).run()
      groupedDb.update(runs).set({ location: 'loc0' }).where(eq(runs.id, previousRunId)).run()
      groupedDb.update(runs).set({ location: 'loc0' }).where(eq(runs.id, groupedCurrent)).run()
      const anchor = groupedDb.select().from(runs).where(eq(runs.id, groupedCurrent)).get()!
      for (let day = 0; day <= scenario.priorGroups; day++) {
        const at = new Date(Date.parse(anchor.createdAt) - day * 24 * 60 * 60_000).toISOString()
        for (let location = 0; location < scenario.locationCount; location++) {
          let groupedRunId: string
          if (location === 0 && day === 0) groupedRunId = groupedCurrent
          else if (location === 0 && day === 1) groupedRunId = previousRunId
          else {
            groupedRunId = crypto.randomUUID()
            groupedDb.insert(runs).values({
              id: groupedRunId, projectId: groupedProject, kind: 'answer-visibility',
              status: 'completed', trigger: 'manual', location: `loc${location}`, createdAt: at, finishedAt: at,
            }).run()
          }
          // Existing current/previous snapshots come from the real regression seed.
          if (!(location === 0 && (day === 0 || day === 1))) groupedDb.insert(querySnapshots).values({
            id: crypto.randomUUID(), runId: groupedRunId, queryId,
            provider: 'gemini', model: 'test', citationState: 'cited',
            citedDomains: ['sev.example.com'], competitorOverlap: [], createdAt: at,
          }).run()
          if (scenario.regressionDays.includes(day) || (day === 0 && location > 0)) groupedDb.insert(insights).values({
            id: crypto.randomUUID(), projectId: groupedProject, runId: groupedRunId,
            type: 'regression', severity: 'high', title: 'Earlier citation loss',
            query: 'foo query', provider: 'gemini', dismissed: false, createdAt: at,
          }).run()
        }
      }
      const groupedResult = new IntelligenceService(groupedDb).analyzeAndPersist(groupedCurrent, groupedProject)
      expect(groupedResult, `${scenario.locationCount} locations`).not.toBeNull()
      expect(groupedResult!.regressions, `${scenario.locationCount} locations`).toEqual([{
        query: 'foo query', provider: 'gemini', currentRunId: groupedCurrent, previousRunId,
        previousCitationUrl: 'sev.example.com', previousPosition: undefined,
      }])
      expect(groupedResult!.insights.filter(i => i.type === 'regression')
        .map(({ query, provider, type, severity }) => ({ query, provider, type, severity })), `${scenario.locationCount} locations`).toEqual([
        { query: 'foo query', provider: 'gemini', type: 'regression', severity: scenario.expectedSeverity },
      ])
      expect(groupedDb.select({
        projectId: insights.projectId, runId: insights.runId, query: insights.query,
        provider: insights.provider, type: insights.type, severity: insights.severity,
      }).from(insights).where(eq(insights.runId, groupedCurrent)).all(), `${scenario.locationCount} locations`).toEqual([
        { projectId: groupedProject, runId: groupedCurrent, query: 'foo query', provider: 'gemini', type: 'regression', severity: scenario.expectedSeverity },
      ])
      expect(persistedSeverity(groupedDb, groupedCurrent), `${scenario.locationCount} locations`).toBe(scenario.expectedSeverity)
    }
  })

  it('counts recurrence only across answer-visibility runs (ignores intervening gsc-sync runs)', () => {
    // Without filtering by run kind, intervening sync runs would consume the
    // recurrence-lookback budget and push prior visibility regressions out of
    // the window — dropping severity from 'critical' to 'high'.
    const db = createTempDb('intel-sev-')
    const { projectId, currentRunId } = seedRegressionScenario(db, {
      gscImpressions: 500,
      priorRegressions: 3,
    })
    // Insert 4 gsc-sync runs between the previous visibility run (now-24h)
    // and the first prior regression (now-48h). Without the kind filter the
    // recurrence query would keep these and discard the 3 visibility regressions.
    const baseTime = new Date()
    for (let i = 0; i < 4; i++) {
      const at = new Date(baseTime.getTime() - (25 + i) * 60 * 60_000).toISOString()
      db.insert(runs).values({
        id: crypto.randomUUID(),
        projectId,
        kind: 'gsc-sync',
        status: 'completed',
        createdAt: at,
        finishedAt: at,
      }).run()
    }

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('critical')
  })
})
