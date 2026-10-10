import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

import { RESEARCH_COPY } from '../src/components/project/ResearchQueriesSection.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import {
  active, advancedResetLine, advancedResetNotice, installWorkspaceApi, preview, previewToken, removalDiff, removalWorkload,
  renderViewerWorkspace, renderWorkspace, reviewRemoval, workspace, workspaceVersion,
} from './support/query-tracking-fixtures.js'

// Simple projects: the Add query form, the earlier review, and the tracked list with no Query type control.

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('gives an opted-in viewer the direct query test without exposing discovery or settings', async () => {
  ;(window as unknown as { __CANONRY_CONFIG__: unknown }).__CANONRY_CONFIG__ = {
    research: { allowViewers: true, viewerDailyRunLimit: 7 },
  }
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  const project = {
    id: 'project_demo', name: 'demo', canonicalDomain: 'demo.example', ownedDomains: ['demo.example'], aliases: [],
    country: 'US', language: 'en', tags: [], labels: {}, providers: ['openai'], providerModels: {},
    locations: [], defaultLocation: null, autoExtractBacklinks: false, configSource: 'api', configRevision: 1,
  }
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (path === '/api/v1/projects/demo') return jsonResponse(project)
    if (path === '/api/v1/projects/demo/query-tracking' && method === 'GET') return jsonResponse({ mode: 'simple', workspaceVersion: 'qtw_viewer', active: null, targets: [], groups: [], markets: [], tracked: [], savedSources: { research: [], discovery: [] }, defaultContexts: [] })
    if (path === '/api/v1/projects/demo/research/runs' && method === 'GET') return jsonResponse({ runs: [], providers: [
      { name: 'openai', displayName: 'OpenAI', modelConfigurable: true, defaultModel: 'gpt-5-mini', knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini' }, { id: 'gpt-5', displayName: 'GPT-5' }] },
      { name: 'gemini', displayName: 'Gemini', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [{ id: 'gemini-2.5-flash', displayName: 'Gemini Flash' }] },
    ] })
    if (path === '/api/v1/projects/demo/research/batches' && method === 'POST') {
      return jsonResponse({ runs: [{
        id: 'research-1', projectId: project.id, status: 'queued', provider: 'openai', requestedModel: null,
        resolvedModel: 'gpt-5-mini', location: null, totalQueries: 1, completedQueries: 0, failedQueries: 0,
        error: null, initiatedBy: { kind: 'user', id: 'viewer-user', name: 'viewer', role: 'viewer' },
        startedAt: null, finishedAt: null, createdAt: '2026-09-08T12:00:00.000Z', queries: [],
      }] }, 202)
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`)
  })
  onTestFinished(restore)
  renderViewerWorkspace({ queryWorkspace: 'research', researchMode: 'find' })

  expect(await screen.findByRole('heading', { name: 'Test queries' })).toBeTruthy()
  expect(screen.queryByRole('tab', { name: 'Find queries' })).toBeNull()
  expect(await screen.findByLabelText('Answer engine')).toBeTruthy()
  expect((screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement).disabled).toBe(true)
  expect((await screen.findByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · gpt-5-mini` }) as HTMLOptionElement).selected).toBe(true)
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5' } })
  fireEvent.change(screen.getByLabelText('Answer engine'), { target: { value: 'gemini' } })
  expect((await screen.findByRole('option', { name: `${RESEARCH_COPY.inheritedModel} · gemini-2.5-flash` }) as HTMLOptionElement).selected).toBe(true)

  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'Which AEO platform fits an agency?' } })
  const run = screen.getByRole('button', { name: RESEARCH_COPY.runAction }) as HTMLButtonElement
  await waitFor(() => expect(run.disabled).toBe(false))
  fireEvent.click(run)
  await waitFor(() => expect(requests.some(request => request.method === 'POST')).toBe(true))
  expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({
    runs: [{ queries: ['Which AEO platform fits an agency?'], location: null }],
  })
  expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ runs: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] })
  expect(requests.some(request => request.path === '/api/v1/settings')).toBe(false)
  expect(screen.queryByRole('button', { name: 'Review for tracking' })).toBeNull()
})

test.each([
  { name: 'a simple preview', mode: 'simple', noOp: false, heading: 'Confirm tracked query changes', subcopy: 'Changes apply to future sweeps. Earlier results stay unchanged.' },
])('shows no reset notice for $name', async ({ mode, noOp, heading, subcopy }) => {
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode, diff: noOp ? { ...removalDiff, removed: [], noOp } : removalDiff }))
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode })
  renderWorkspace()
  expect((await reviewRemoval()).textContent).toBe(heading)
  if (subcopy) expect(screen.getByText(subcopy)).toBeTruthy()
  else expect(screen.queryByText('This request leaves tracking unchanged.')).toBeNull()
  expect(screen.queryByText(/AI Visibility keeps showing the last sweep/)).toBeNull()
  expect(screen.queryByText(advancedResetLine)).toBeNull()
  expect(screen.queryByRole('button', { name: advancedResetNotice })).toBeNull()
})

test.each([
  { name: 'a simple commit', mode: 'simple', committed: true, title: 'Tracked queries updated', detail: undefined },
])('names when new numbers arrive only after $name', async ({ mode, committed, title, detail }) => {
  resetToasts()
  onTestFinished(resetToasts)
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode, diff: removalDiff }))
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed, mode, workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: removalDiff, workload: removalWorkload })
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode })
  renderWorkspace()
  await reviewRemoval()
  fireEvent.click(screen.getByRole('button', { name: mode === 'simple' ? 'Confirm changes' : 'Publish 1 change' }))
  await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual([title]))
  expect(getToasts()[0]!.detail).toBe(detail)
})

test.each(['simple'])('commits a resolved template query edit in %s mode without expanding its source', async (mode) => {
  const requests: Array<{ path: string; body: unknown }> = []
  const saved = workspace()
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({ mode }))
    if (path.endsWith('/query-tracking/commit')) return jsonResponse({ committed: true, mode, workspaceVersion, reviewedAt: '2026-09-04T12:15:00.000Z', active, diff: preview().diff, workload: preview().workload })
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], {
    ...saved, mode,
    tracked: [{
      ...saved.tracked[0],
      provenance: {
        source: 'template', sourceId: 'template-1', capturedAt: '2026-09-04T12:00:00.000Z',
        template: { templateId: 'template-1', templateVersion: 'v1', template: '{property} pricing', variables: { property: 'Acme' }, output: 'Acme pricing' },
      },
    }],
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  expect((screen.getByLabelText('Query text') as HTMLTextAreaElement).value).toBe('Acme pricing')
  // The hint names the button this project has: a simple project keeps Add query.
  expect(screen.getByText(`Existing locations and engines are preserved. Use ${mode === 'simple' ? 'Add query' : 'Add queries'} to create assignments in another scope.`)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Acme fees' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText(mode === 'simple' ? 'Confirm tracked query changes' : 'Review tracking changes')
  fireEvent.click(screen.getByRole('button', { name: mode === 'simple' ? 'Confirm changes' : 'Publish changes' }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/commit',
    body: {
      expectedWorkspaceVersion: workspaceVersion, additions: [], removals: [],
      edits: [{ queryId: 'query-acme', text: 'Acme fees' }],
      previewToken, reviewedAt: '2026-09-04T12:15:00.000Z',
    },
  })
})

test.each(['non-brand', 'branded'] as const)('keeps all Simple tracked rows visible when the shared URL carries %s', async queryClass => {
  const data = workspace()
  data.mode = 'simple'
  data.tracked = data.tracked.map(row => ({ ...row, assignments: [] }))
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: 'project', queryClass } })

  expect(await screen.findByText('Acme pricing')).toBeTruthy()
  expect(screen.getByText('Best AEO platform')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Query type' })).toBeNull()
  expect(screen.queryByRole('columnheader', { name: 'Class' })).toBeNull()
  expect(screen.queryByText('Unknown')).toBeNull()
})

test('keeps simple measurements classifier-only with no Apply to box and never submits an operator override', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({ mode: 'simple' }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), mode: 'simple' })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  expect(screen.queryByLabelText('Classification')).toBeNull()
  expect(screen.queryByLabelText('Location and engines')).toBeNull()
  expect(screen.queryByRole('group', { name: 'Apply to' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByText('Automatic')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'How does Acme compare?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Confirm tracked query changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'How does Acme compare?' } }],
    removals: [],
  })
  // A simple project keeps the earlier review, with none of the advanced one.
  expect(screen.getByText('+1 / −0 answers per sweep · next sweep asks 3')).toBeTruthy()
  expect(screen.getByText('Changes apply to future sweeps. Earlier results stay unchanged.')).toBeTruthy()
  expect(screen.getByText('Ready to confirm')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Confirm changes' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Publish/ })).toBeNull()
  expect(screen.queryByRole('term')).toBeNull()
  expect(screen.queryByRole('table', { name: 'Changes' })).toBeNull()
})

test('tells a simple project that a market template cannot be used, without naming Apply to', async () => {
  const template = {
    id: 'template-market', projectId: 'project-demo', name: 'Market comparison', description: null,
    pattern: 'Best {property} provider in {market}', variables: ['property', 'market'],
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z',
  }
  installWorkspaceApi(undefined, [template], { ...workspace(), mode: 'simple', groups: [], markets: [] })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'template' } })
  fireEvent.change(screen.getByLabelText('Saved template'), { target: { value: 'template-market' } })
  expect(screen.getByText('This template needs a market, and this project has no markets. Write a question instead.')).toBeTruthy()
  expect(screen.queryByText(/Apply to/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
})
