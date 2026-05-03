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
  keywords,
  querySnapshots,
  insights,
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
  keywordId: string
  previousRunId: string
  currentRunId: string
}

function seedRegressionScenario(
  db: ReturnType<typeof createClient>,
  opts: { gscImpressions?: number; priorRegressions?: number } = {},
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
    providers: '["gemini"]',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }).run()

  const keywordId = crypto.randomUUID()
  db.insert(keywords).values({
    id: keywordId,
    projectId,
    keyword: 'foo keyword',
    createdAt: now.toISOString(),
  }).run()

  const previousRunId = crypto.randomUUID()
  const currentRunId = crypto.randomUUID()
  const previousAt = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  db.insert(runs).values({
    id: previousRunId,
    projectId,
    status: 'completed',
    providers: '["gemini"]',
    createdAt: previousAt,
    finishedAt: previousAt,
  }).run()
  db.insert(runs).values({
    id: currentRunId,
    projectId,
    status: 'completed',
    providers: '["gemini"]',
    createdAt: now.toISOString(),
    finishedAt: now.toISOString(),
  }).run()

  // Previous run: cited
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: previousRunId,
    keywordId,
    provider: 'gemini',
    model: 'test',
    citationState: 'cited',
    citedDomains: JSON.stringify(['sev.example.com']),
    competitorOverlap: '[]',
    createdAt: previousAt,
  }).run()
  // Current run: not-cited (regression)
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: currentRunId,
    keywordId,
    provider: 'gemini',
    model: 'test',
    citationState: 'not-cited',
    citedDomains: '[]',
    competitorOverlap: '[]',
    createdAt: now.toISOString(),
  }).run()

  if (opts.gscImpressions !== undefined) {
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: currentRunId,
      date: '2026-04-01',
      query: 'foo keyword',
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
      providers: '["gemini"]',
      createdAt: oldAt,
      finishedAt: oldAt,
    }).run()
    db.insert(insights).values({
      id: crypto.randomUUID(),
      projectId,
      runId: oldRunId,
      type: 'regression',
      severity: 'high',
      title: 'Lost gemini citation for "foo keyword"',
      keyword: 'foo keyword',
      provider: 'gemini',
      recommendation: null,
      cause: null,
      dismissed: false,
      createdAt: oldAt,
    }).run()
  }

  return { projectId, keywordId, previousRunId, currentRunId }
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
        providers: '["gemini"]',
        createdAt: at,
        finishedAt: at,
      }).run()
    }

    new IntelligenceService(db).analyzeAndPersist(currentRunId, projectId)

    expect(persistedSeverity(db, currentRunId)).toBe('critical')
  })
})
