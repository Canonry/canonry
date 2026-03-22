import { test, expect } from 'vitest'

import { buildDashboard, buildProjectCommandCenter, type ProjectData } from '../src/build-dashboard.js'
import type { ApiSettings } from '../src/api.js'

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
