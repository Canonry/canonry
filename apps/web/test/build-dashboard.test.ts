import { test, expect, describe } from 'vitest'

import { buildDashboard, buildProjectCommandCenter, type ProjectData } from '../src/build-dashboard.js'
import type { ApiSettings } from '../src/api.js'
import type { InsightDto } from '@ainyc/canonry-contracts'

test('buildDashboard maps Google settings into the dashboard view model', () => {
  const apiSettings: ApiSettings = {
    providers: [{
      name: 'gemini',
      configured: true,
      model: 'gemini-3-flash',
    }],
    google: {
      configured: true,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  expect(dashboard.settings.google.state).toBe('ready')
  expect(dashboard.settings.google.detail).toMatch(/configured/i)
  expect(
    dashboard.settings.selfHostNotes.some((note) => note.includes('source of truth for authentication credentials')),
  ).toBeTruthy()
  expect(dashboard.settings.bootstrapNote).toMatch(/Authentication credentials persist to local config/)
})

test('buildDashboard marks Google settings as needing config when OAuth is not configured', () => {
  const apiSettings: ApiSettings = {
    providers: [],
    google: {
      configured: false,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  expect(dashboard.settings.google.state).toBe('needs-config')
  expect(dashboard.settings.google.detail).toMatch(/not configured yet/i)
})

test('buildProjectCommandCenter preserves provider continuity while marking mixed-model history', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_1',
      name: 'citypoint',
      displayName: 'Citypoint',
      canonicalDomain: 'citypoint.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['openai'],
      configSource: 'api',
      configRevision: 2,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [
      {
        id: 'run_2',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-15T00:00:00Z',
        finishedAt: '2026-03-15T00:00:10Z',
        error: null,
        createdAt: '2026-03-15T00:00:00Z',
      },
      {
        id: 'run_1',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-14T00:00:00Z',
        finishedAt: '2026-03-14T00:00:10Z',
        error: null,
        createdAt: '2026-03-14T00:00:00Z',
      },
    ],
    keywords: [{ id: 'kw_1', keyword: 'best ai seo agency', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      keyword: 'best ai seo agency',
      runs: [
        { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
        { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'cited' },
      ],
      providerRuns: {
        openai: [
          { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
          { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'cited' },
        ],
      },
      modelRuns: {
        'openai:gpt-4o': [
          { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
        'openai:gpt-4.1': [
          { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
      },
    }],
    latestRunDetail: {
      id: 'run_2',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-15T00:00:00Z',
      finishedAt: '2026-03-15T00:00:10Z',
      error: null,
      createdAt: '2026-03-15T00:00:00Z',
      snapshots: [{
        id: 'snap_2',
        runId: 'run_2',
        keywordId: 'kw_1',
        keyword: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-4.1',
        citationState: 'cited',
        answerText: 'Citypoint is cited here.',
        citedDomains: ['citypoint.example'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        createdAt: '2026-03-15T00:00:00Z',
      }],
    },
    previousRunDetail: {
      id: 'run_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-14T00:00:00Z',
      finishedAt: '2026-03-14T00:00:10Z',
      error: null,
      createdAt: '2026-03-14T00:00:00Z',
      snapshots: [{
        id: 'snap_1',
        runId: 'run_1',
        keywordId: 'kw_1',
        keyword: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-4o',
        citationState: 'cited',
        answerText: 'Citypoint is cited here.',
        citedDomains: ['citypoint.example'],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        createdAt: '2026-03-14T00:00:00Z',
      }],
    },
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence[0]!

  expect(evidence.changeLabel).toBe('Cited for 2 runs')
  expect(evidence.historyScope).toBe('provider')
  expect(evidence.modelsSeen).toEqual(['gpt-4o', 'gpt-4.1'])
  expect(
    evidence.runHistory.map(point => point.model),
  ).toEqual(['gpt-4o', 'gpt-4.1'])
  expect(evidence.modelTransitions).toEqual([{
    runId: 'run_2',
    createdAt: '2026-03-15T00:00:00Z',
    fromModel: 'gpt-4o',
    toModel: 'gpt-4.1',
  }])
})

test('buildProjectCommandCenter keeps historical-only provider badges on their own last known state', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_history',
      name: 'history-demo',
      displayName: 'History Demo',
      canonicalDomain: 'history.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini', 'openai'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-20T00:00:00Z',
      updatedAt: '2026-03-22T00:00:00Z',
    },
    runs: [
      {
        id: 'run_1',
        projectId: 'proj_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-21T00:00:00Z',
        finishedAt: '2026-03-21T00:00:10Z',
        error: null,
        createdAt: '2026-03-21T00:00:00Z',
      },
      {
        id: 'run_2',
        projectId: 'proj_history',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-22T00:00:00Z',
        finishedAt: '2026-03-22T00:00:10Z',
        error: null,
        createdAt: '2026-03-22T00:00:00Z',
      },
    ],
    keywords: [{ id: 'kw_1', keyword: 'best ai seo agency', createdAt: '2026-03-20T00:00:00Z' }],
    competitors: [],
    timeline: [{
      keyword: 'best ai seo agency',
      runs: [
        { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'cited', transition: 'new' },
        { runId: 'run_2', createdAt: '2026-03-22T00:00:00Z', citationState: 'not-cited', transition: 'lost' },
      ],
      providerRuns: {
        gemini: [
          { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
        openai: [
          { runId: 'run_1', createdAt: '2026-03-21T00:00:00Z', citationState: 'not-cited', transition: 'new' },
          { runId: 'run_2', createdAt: '2026-03-22T00:00:00Z', citationState: 'not-cited', transition: 'not-cited' },
        ],
      },
      modelRuns: {},
    }],
    latestRunDetail: {
      id: 'run_2',
      projectId: 'proj_history',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-22T00:00:00Z',
      finishedAt: '2026-03-22T00:00:10Z',
      error: null,
      createdAt: '2026-03-22T00:00:00Z',
      snapshots: [{
        id: 'snap_2',
        runId: 'run_2',
        keywordId: 'kw_1',
        keyword: 'best ai seo agency',
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerText: null,
        citedDomains: [],
        competitorOverlap: [],
        groundingSources: [],
        searchQueries: [],
        location: null,
        createdAt: '2026-03-22T00:00:00Z',
      }],
    },
    previousRunDetail: null,
  }

  const evidence = buildProjectCommandCenter(data).visibilityEvidence
  const geminiEvidence = evidence.find(item => item.provider === 'gemini')
  const openaiEvidence = evidence.find(item => item.provider === 'openai')

  expect(geminiEvidence?.citationState).toBe('cited')
  expect(geminiEvidence?.changeLabel).toBe('First observation')
  expect(geminiEvidence?.runHistory).toHaveLength(1)
  expect(openaiEvidence?.citationState).toBe('not-cited')
})

test('buildProjectCommandCenter summarizes gap key phrases and prefers Google index coverage', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_2',
      name: 'harbor',
      displayName: 'Harbor',
      canonicalDomain: 'harbor.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini', 'openai'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [{
      id: 'run_latest',
      projectId: 'proj_2',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-15T00:00:00Z',
      finishedAt: '2026-03-15T00:00:20Z',
      error: null,
      createdAt: '2026-03-15T00:00:00Z',
    }],
    keywords: [
      { id: 'kw_gap', keyword: 'ai seo consultant', createdAt: '2026-03-10T00:00:00Z' },
      { id: 'kw_cited', keyword: 'aeo agency', createdAt: '2026-03-10T00:00:00Z' },
    ],
    competitors: [{ id: 'comp_1', domain: 'rival.example', createdAt: '2026-03-10T00:00:00Z' }],
    timeline: [
      {
        keyword: 'ai seo consultant',
        runs: [{ runId: 'run_latest', createdAt: '2026-03-15T00:00:00Z', citationState: 'not-cited', transition: 'not-cited' }],
      },
      {
        keyword: 'aeo agency',
        runs: [{ runId: 'run_latest', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'new' }],
      },
    ],
    latestRunDetail: {
      id: 'run_latest',
      projectId: 'proj_2',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      startedAt: '2026-03-15T00:00:00Z',
      finishedAt: '2026-03-15T00:00:20Z',
      error: null,
      createdAt: '2026-03-15T00:00:00Z',
      snapshots: [
        {
          id: 'snap_gap_gemini',
          runId: 'run_latest',
          keywordId: 'kw_gap',
          keyword: 'ai seo consultant',
          provider: 'gemini',
          model: 'gemini-3-flash',
          citationState: 'not-cited',
          answerText: null,
          citedDomains: [],
          competitorOverlap: ['rival.example'],
          groundingSources: [],
          searchQueries: [],
          location: null,
          createdAt: '2026-03-15T00:00:00Z',
        },
        {
          id: 'snap_gap_openai',
          runId: 'run_latest',
          keywordId: 'kw_gap',
          keyword: 'ai seo consultant',
          provider: 'openai',
          model: 'gpt-5.4',
          citationState: 'not-cited',
          answerText: null,
          citedDomains: [],
          competitorOverlap: ['rival.example'],
          groundingSources: [],
          searchQueries: [],
          location: null,
          createdAt: '2026-03-15T00:00:00Z',
        },
        {
          id: 'snap_cited_gemini',
          runId: 'run_latest',
          keywordId: 'kw_cited',
          keyword: 'aeo agency',
          provider: 'gemini',
          model: 'gemini-3-flash',
          citationState: 'cited',
          answerText: null,
          citedDomains: ['harbor.example'],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          location: null,
          createdAt: '2026-03-15T00:00:00Z',
        },
      ],
    },
    previousRunDetail: null,
    gscCoverage: {
      summary: {
        total: 10,
        indexed: 8,
        notIndexed: 2,
        deindexed: 1,
        percentage: 80,
      },
      lastInspectedAt: '2026-03-15T01:00:00Z',
      indexed: [],
      notIndexed: [],
      deindexed: [],
      reasonGroups: [],
    },
    bingCoverage: {
      summary: {
        total: 12,
        indexed: 12,
        notIndexed: 0,
        percentage: 100,
      },
      lastInspectedAt: '2026-03-15T01:00:00Z',
      indexed: [],
      notIndexed: [],
    },
  }

  const model = buildProjectCommandCenter(data)

  expect(model.gapKeyPhrases.label).toBe('Gap Key Phrases')
  expect(model.gapKeyPhrases.value).toBe('1')
  expect(model.gapKeyPhrases.delta).toBe('1 of 2 key phrases at risk')
  expect(model.gapKeyPhrases.progress).toBe(0.5)
  expect(model.indexCoverage.value).toBe('80')
  expect(model.indexCoverage.delta).toBe('Google · 8 of 10 indexed')
  expect(model.indexCoverage.tone).toBe('negative')
  expect(model.indexCoverage.description).toMatch(/deindexed/i)
})

test('buildProjectCommandCenter falls back to Bing coverage when Google coverage is unavailable', () => {
  const data: ProjectData = {
    project: {
      id: 'proj_3',
      name: 'northstar',
      displayName: 'Northstar',
      canonicalDomain: 'northstar.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['openai'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [],
    keywords: [],
    competitors: [],
    timeline: [],
    latestRunDetail: null,
    previousRunDetail: null,
    gscCoverage: null,
    bingCoverage: {
      summary: {
        total: 20,
        indexed: 15,
        notIndexed: 5,
        percentage: 75,
      },
      lastInspectedAt: '2026-03-15T01:00:00Z',
      indexed: [],
      notIndexed: [],
    },
  }

  const model = buildProjectCommandCenter(data)

  expect(model.indexCoverage.value).toBe('75')
  expect(model.indexCoverage.delta).toBe('Bing · 15 of 20 indexed')
  expect(model.indexCoverage.description).toMatch(/Bing Webmaster Tools/)
})

/* ── DB insight merge tests ──────────────────────────────────────────────── */

function makeRegressionData(): ProjectData {
  return {
    project: {
      id: 'proj_merge',
      name: 'merge-test',
      displayName: 'Merge Test',
      canonicalDomain: 'merge.example',
      ownedDomains: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: ['gemini'],
      configSource: 'api',
      configRevision: 1,
      createdAt: '2026-03-10T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    },
    runs: [
      { id: 'run_2', projectId: 'proj_merge', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: '2026-03-15T00:00:00Z', finishedAt: '2026-03-15T00:00:10Z', error: null, createdAt: '2026-03-15T00:00:00Z' },
      { id: 'run_1', projectId: 'proj_merge', kind: 'answer-visibility', status: 'completed', trigger: 'manual', startedAt: '2026-03-14T00:00:00Z', finishedAt: '2026-03-14T00:00:10Z', error: null, createdAt: '2026-03-14T00:00:00Z' },
    ],
    keywords: [{ id: 'kw_1', keyword: 'roof repair', createdAt: '2026-03-10T00:00:00Z' }],
    competitors: [],
    timeline: [{
      keyword: 'roof repair',
      runs: [
        { runId: 'run_1', createdAt: '2026-03-14T00:00:00Z', citationState: 'cited', transition: 'new' },
        { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'not-cited', transition: 'lost' },
      ],
    }],
    latestRunDetail: {
      id: 'run_2', projectId: 'proj_merge', kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      startedAt: '2026-03-15T00:00:00Z', finishedAt: '2026-03-15T00:00:10Z', error: null, createdAt: '2026-03-15T00:00:00Z',
      snapshots: [{
        id: 'snap_2', runId: 'run_2', keywordId: 'kw_1', keyword: 'roof repair', provider: 'gemini', model: null,
        citationState: 'not-cited', answerText: null, citedDomains: [], competitorOverlap: [], groundingSources: [], searchQueries: [], createdAt: '2026-03-15T00:00:00Z',
      }],
    },
    previousRunDetail: {
      id: 'run_1', projectId: 'proj_merge', kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      startedAt: '2026-03-14T00:00:00Z', finishedAt: '2026-03-14T00:00:10Z', error: null, createdAt: '2026-03-14T00:00:00Z',
      snapshots: [{
        id: 'snap_1', runId: 'run_1', keywordId: 'kw_1', keyword: 'roof repair', provider: 'gemini', model: null,
        citationState: 'cited', answerText: 'Merge example cited.', citedDomains: ['merge.example'], competitorOverlap: [], groundingSources: [], searchQueries: [], createdAt: '2026-03-14T00:00:00Z',
      }],
    },
  }
}

function makeDbInsight(overrides: Partial<InsightDto> = {}): InsightDto {
  return {
    id: 'ins_1', projectId: 'proj_merge', runId: 'run_2', type: 'regression', severity: 'high',
    title: 'Lost citation on Gemini', keyword: 'roof repair', provider: 'gemini',
    recommendation: { action: 'Audit content', reason: 'Page not re-indexed' },
    cause: { cause: 'competitor displacement', details: 'rival.com now cited' },
    dismissed: false, createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('DB insight merge with in-memory signals', () => {
  test('dbInsights null → pure in-memory insights (no merge)', () => {
    const data = makeRegressionData()
    data.dbInsights = null
    const model = buildProjectCommandCenter(data)
    // In-memory generates insight_lost for the regression
    expect(model.insights.some(i => i.id === 'insight_lost')).toBe(true)
  })

  test('DB regressions replace in-memory insight_lost', () => {
    const data = makeRegressionData()
    data.dbInsights = [makeDbInsight()]
    const model = buildProjectCommandCenter(data)
    // insight_lost should be gone, replaced by DB regression
    expect(model.insights.some(i => i.id === 'insight_lost')).toBe(false)
    expect(model.insights.some(i => i.tone === 'negative' && i.title === 'Lost citation on Gemini')).toBe(true)
  })

  test('empty DB insights (all dismissed) does not resurrect in-memory lost signal', () => {
    const data = makeRegressionData()
    data.dbInsights = [] // intelligence ran, all dismissed
    const model = buildProjectCommandCenter(data)
    // insight_lost should be stripped since DB is authoritative, stable fallback instead
    expect(model.insights.some(i => i.id === 'insight_lost')).toBe(false)
    expect(model.insights.some(i => i.id === 'insight_stable')).toBe(true)
  })

  test('non-regression in-memory signals preserved alongside DB insights', () => {
    const data = makeRegressionData()
    // Add a first-citation signal by adding a second keyword that just appeared
    data.keywords.push({ id: 'kw_2', keyword: 'best roofer', createdAt: '2026-03-10T00:00:00Z' })
    data.timeline.push({
      keyword: 'best roofer',
      runs: [
        { runId: 'run_2', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'emerging' },
      ],
    })
    data.latestRunDetail!.snapshots.push({
      id: 'snap_3', runId: 'run_2', keywordId: 'kw_2', keyword: 'best roofer', provider: 'gemini', model: null,
      citationState: 'cited', answerText: 'Best roofer cited.', citedDomains: ['merge.example'], competitorOverlap: [], groundingSources: [], searchQueries: [], createdAt: '2026-03-15T00:00:00Z',
    })
    data.dbInsights = [makeDbInsight()]
    const model = buildProjectCommandCenter(data)
    // DB regression present
    expect(model.insights.some(i => i.tone === 'negative' && i.title === 'Lost citation on Gemini')).toBe(true)
    // In-memory first-citation also present
    expect(model.insights.some(i => i.id === 'insight_first_citation')).toBe(true)
    // insight_lost removed
    expect(model.insights.some(i => i.id === 'insight_lost')).toBe(false)
  })

  test('dbInsights undefined (field not set) → pure in-memory fallback', () => {
    const data = makeRegressionData()
    // dbInsights not set at all (pre-existing ProjectData without the field)
    const model = buildProjectCommandCenter(data)
    expect(model.insights.some(i => i.id === 'insight_lost')).toBe(true)
  })
})

/* ── Run kind differentiation (#269) ──────────────────────────────────── */

describe('run kind differentiation in Command Center', () => {
  function makeProjectWithMixedRuns(): ProjectData {
    return {
      project: {
        id: 'proj_mixed',
        name: 'mixed-runs',
        displayName: 'Mixed Runs',
        canonicalDomain: 'mixed.example',
        ownedDomains: [],
        country: 'US',
        language: 'en',
        tags: [],
        labels: {},
        providers: ['gemini'],
        configSource: 'api',
        configRevision: 1,
        createdAt: '2026-03-10T00:00:00Z',
        updatedAt: '2026-03-15T00:00:00Z',
      },
      runs: [
        // gsc-sync is the absolute latest run
        {
          id: 'run_gsc',
          projectId: 'proj_mixed',
          kind: 'gsc-sync',
          status: 'completed',
          trigger: 'scheduled',
          startedAt: '2026-03-17T00:00:00Z',
          finishedAt: '2026-03-17T00:00:05Z',
          error: null,
          createdAt: '2026-03-17T00:00:00Z',
        },
        // answer-visibility run is older
        {
          id: 'run_vis',
          projectId: 'proj_mixed',
          kind: 'answer-visibility',
          status: 'completed',
          trigger: 'manual',
          startedAt: '2026-03-15T00:00:00Z',
          finishedAt: '2026-03-15T00:00:10Z',
          error: null,
          createdAt: '2026-03-15T00:00:00Z',
        },
      ],
      keywords: [{ id: 'kw_1', keyword: 'test keyword', createdAt: '2026-03-10T00:00:00Z' }],
      competitors: [],
      timeline: [{
        keyword: 'test keyword',
        runs: [
          { runId: 'run_vis', createdAt: '2026-03-15T00:00:00Z', citationState: 'cited', transition: 'new' },
        ],
      }],
      latestRunDetail: {
        id: 'run_vis',
        projectId: 'proj_mixed',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        startedAt: '2026-03-15T00:00:00Z',
        finishedAt: '2026-03-15T00:00:10Z',
        error: null,
        createdAt: '2026-03-15T00:00:00Z',
        snapshots: [{
          id: 'snap_1',
          runId: 'run_vis',
          keywordId: 'kw_1',
          keyword: 'test keyword',
          provider: 'gemini',
          model: null,
          citationState: 'cited',
          answerText: 'Test cited.',
          citedDomains: ['mixed.example'],
          competitorOverlap: [],
          groundingSources: [],
          searchQueries: [],
          createdAt: '2026-03-15T00:00:00Z',
        }],
      },
      previousRunDetail: null,
    }
  }

  test('runStatus pins to latest answer-visibility run, not gsc-sync', () => {
    const data = makeProjectWithMixedRuns()
    const model = buildProjectCommandCenter(data)

    // Run Status should reflect the visibility run, not the gsc-sync
    expect(model.runStatus.value).toBe('Healthy')
    expect(model.runStatus.description).toMatch(/Answer visibility sweep/)
    expect(model.runStatus.description).not.toMatch(/gsc-sync/)
  })

  test('runStatus delta shows sweep and sync counts', () => {
    const data = makeProjectWithMixedRuns()
    const model = buildProjectCommandCenter(data)

    expect(model.runStatus.delta).toBe('1 sweep · 1 sync')
  })

  test('visibility metrics use answer-visibility snapshots, not gsc-sync', () => {
    const data = makeProjectWithMixedRuns()
    const model = buildProjectCommandCenter(data)

    // Should show 100% visibility from the visibility run, not 0% from gsc-sync
    expect(model.visibilitySummary.value).toBe('100')
    expect(model.keywordCounts.cited).toBe(1)
  })

  test('stale visibility warning when sync is >1 day newer than visibility run', () => {
    const data = makeProjectWithMixedRuns()
    // Push the gsc-sync 2 days after visibility
    data.runs[0]!.createdAt = '2026-03-17T00:00:00Z'
    const model = buildProjectCommandCenter(data)

    expect(model.insights.some(i => i.id === 'insight_stale_visibility')).toBe(true)
    const staleInsight = model.insights.find(i => i.id === 'insight_stale_visibility')!
    expect(staleInsight.tone).toBe('caution')
    expect(staleInsight.title).toBe('Stale visibility data')
  })

  test('no stale warning when sync is within 1 day of visibility run', () => {
    const data = makeProjectWithMixedRuns()
    // gsc-sync only 1 hour after visibility
    data.runs[0]!.createdAt = '2026-03-15T01:00:00Z'
    const model = buildProjectCommandCenter(data)

    expect(model.insights.some(i => i.id === 'insight_stale_visibility')).toBe(false)
  })

  test('recentRuns shows all run kinds with proper labels', () => {
    const data = makeProjectWithMixedRuns()
    const model = buildProjectCommandCenter(data)

    const gscRun = model.recentRuns.find(r => r.id === 'run_gsc')
    const visRun = model.recentRuns.find(r => r.id === 'run_vis')

    expect(gscRun?.kindLabel).toBe('GSC sync')
    expect(gscRun?.summary).toBe('GSC sync completed')
    expect(visRun?.kindLabel).toBe('Answer visibility sweep')
    expect(visRun?.summary).toBe('Answer visibility sweep completed')
  })
})
