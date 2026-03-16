import assert from 'node:assert/strict'
import test from 'node:test'

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

  assert.equal(dashboard.settings.google.state, 'ready')
  assert.match(dashboard.settings.google.detail, /configured/i)
  assert.ok(
    dashboard.settings.selfHostNotes.some((note) => note.includes('source of truth for authentication credentials')),
  )
  assert.match(dashboard.settings.bootstrapNote, /Authentication credentials persist to local config/)
})

test('buildDashboard marks Google settings as needing config when OAuth is not configured', () => {
  const apiSettings: ApiSettings = {
    providers: [],
    google: {
      configured: false,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  assert.equal(dashboard.settings.google.state, 'needs-config')
  assert.match(dashboard.settings.google.detail, /not configured yet/i)
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

  assert.equal(evidence.changeLabel, 'Cited for 2 runs')
  assert.equal(evidence.historyScope, 'provider')
  assert.deepEqual(evidence.modelsSeen, ['gpt-4o', 'gpt-4.1'])
  assert.deepEqual(
    evidence.runHistory.map(point => point.model),
    ['gpt-4o', 'gpt-4.1'],
  )
  assert.deepEqual(evidence.modelTransitions, [{
    runId: 'run_2',
    createdAt: '2026-03-15T00:00:00Z',
    fromModel: 'gpt-4o',
    toModel: 'gpt-4.1',
  }])
})
