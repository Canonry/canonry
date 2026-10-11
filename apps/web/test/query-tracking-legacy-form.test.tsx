import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { TrackingComposer } from '../src/components/project/queries/TrackingComposer.js'
import { defaultTrackingDraft } from '../src/components/project/queries/tracking-draft.js'
import { jsonResponse } from './mock-fetch.js'
import {
  active, chooseContext, context, expectNoSentence, installScrollSpy, installWorkspaceApi, listLocations, noteButton, openLegacyAdd, preview, previewToken,
  renderWorkspace, reviewRow, selectedContext, sharedSearchLocation, workspace, workspaceVersion,
} from './support/query-tracking-fixtures.js'

// The Add query form of an Advanced project, reached through `openLegacyAdd` or a saved Research result.

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('leaves no audience after the last property is unchecked and requires an explicit Every location choice', async () => {
  const requests: unknown[] = []
  installWorkspaceApi((path, body) => {
    if (path.endsWith('/query-tracking/preview')) {
      requests.push(body)
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'How does Acme compare?' } })
  chooseContext()
  const review = screen.getByRole('button', { name: 'Review changes' })
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Change tracking destination' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  expect((screen.getByRole('checkbox', { name: 'Every location (1)' }) as HTMLInputElement).checked).toBe(false)
  noteButton('Choose a place', 'Choose at least one location, group, or market.')
  expect(review.hasAttribute('disabled')).toBe(true)
  fireEvent.click(review)
  expect(requests).toEqual([])

  fireEvent.click(screen.getByRole('checkbox', { name: 'Every location (1)' }))
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(review)
  await screen.findByRole('heading', { name: 'Review tracking changes' })
  expect(requests).toEqual([{
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'How does Acme compare?' }, audience: { targetKeys: ['acme'] }, contexts: [selectedContext] }],
    removals: [],
  }])
})

test('starts a project-scope Add with no destination chosen and Review disabled', async () => {
  const requests: unknown[] = []
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'How does Acme compare?' } })
  chooseContext()

  const applyTo = screen.getByRole('group', { name: 'Apply to' })
  expect(within(applyTo).getAllByRole('checkbox')).toHaveLength(4)
  for (const name of ['Every location (1)', 'Acme, Location', 'North East, Group', 'New York, Market']) {
    expect(within(applyTo).getByRole('checkbox', { name })).toHaveProperty('checked', false)
  }
  // A short status in the box; the sentence is its help.
  expect(noteButton('Choose a place', 'Choose at least one location, group, or market.', applyTo).closest('[role="status"]')).not.toBeNull()
  // What a group and a market are is one help button beside the search, outside the group's name.
  expect(within(applyTo).getByRole('button', { name: 'A group is a set of locations. A market asks its queries with its own search location and engines.' })).toBeTruthy()
  expect(applyTo.textContent).not.toMatch(/propert|question|assign/i)
  const review = screen.getByRole('button', { name: 'Review changes' })
  expect(review.hasAttribute('disabled')).toBe(true)
  fireEvent.click(review)
  expect(requests).toEqual([])
})

test('sends Every location as the explicit list of every location key', async () => {
  const data = workspace()
  data.targets.push({ stableKey: 'beta', label: 'Beta' }, { stableKey: 'gamma', label: 'Gamma' })
  let previewBody: unknown
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], data)
  renderWorkspace()
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Which platform fits our team?' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Every location (3)' }))
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByRole('heading', { name: 'Review tracking changes' })
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'Which platform fits our team?' },
      audience: { targetKeys: ['acme', 'beta', 'gamma'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
})

test.each([
  ['property', 'acme', 'Acme, Location', { targetKeys: ['acme'] }],
  ['group', 'north-east', 'North East, Group', { groupKeys: ['north-east'] }],
  ['market', 'new-york', 'New York, Market', { marketKeys: ['new-york'] }],
] as const)('pre-ticks only the selected %s when Add opens from its view', async (scope, key, checkbox, audience) => {
  let previewBody: unknown
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace({ selection: { measurementScope: scope, measurementScopeKey: key, queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Which platform fits our team?' } })
  const change = screen.queryByRole('button', { name: 'Change tracking destination' })
  if (change) fireEvent.click(change)

  const applyTo = screen.getByRole('group', { name: 'Apply to' })
  for (const name of ['Every location (1)', 'Acme, Location', 'North East, Group', 'New York, Market']) {
    expect(within(applyTo).getByRole('checkbox', { name })).toHaveProperty('checked', name === checkbox)
  }
  if (scope !== 'market') chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByRole('heading', { name: 'Review tracking changes' })
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'Which platform fits our team?' },
      audience,
      ...(scope === 'market' ? {} : { contexts: [selectedContext] }),
    }],
    removals: [],
  })
})

test('starts with the question, preserves written text, and keeps required measurement controls outside optional options', async () => {
  installWorkspaceApi()
  renderWorkspace()
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  const text = screen.getByLabelText('Query')
  const source = screen.getByLabelText('Query source')
  expect(text.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Write a query' })).toBeTruthy()
  fireEvent.change(text, { target: { value: 'Which platform fits our team?' } })
  fireEvent.change(source, { target: { value: 'research' } })
  fireEvent.change(source, { target: { value: 'manual' } })
  expect((screen.getByLabelText('Query') as HTMLTextAreaElement).value).toBe('Which platform fits our team?')
  const options = screen.getByLabelText('Type', { selector: '#tracking-query-class' }).closest('details')!
  expect(options).not.toBeNull()
  expect(options.open).toBe(false)
  expect(screen.getByText('Measurement options', { selector: 'summary' })).toBeTruthy()
  const searchLocation = screen.getByLabelText('Search location and engines')
  expect(searchLocation.closest('details')).toBeNull()
  // Its help is beside the label, never part of the field's name.
  expect(within(searchLocation.parentElement!).getByRole('button', { name: 'Where this query is asked, and on which engines.' })).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  chooseContext()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(false)
  // The form shows labels only. Every sentence is behind a help button.
  const form = screen.getByRole('heading', { name: 'Add query' }).closest('.surface-card') as HTMLElement
  noteButton('No sweep on publish', 'Publishing does not run a sweep.', form)
  expect(form.textContent).not.toMatch(/question|propert|classif|template|assign|context/i)
  expectNoSentence(form)
})

test.each([
  { name: 'names a search location that has no place', contexts: [{ ...context, location: null }], options: ['Choose a search location and engines', 'No search location · openai (gpt-5)'] },
  { name: 'says so when the project has no search location and engines', contexts: [], options: ['Choose a search location and engines'] },
])('$name', async ({ contexts, options }) => {
  installWorkspaceApi(undefined, [], { ...workspace(), defaultContexts: contexts } as unknown as ReturnType<typeof workspace>)
  renderWorkspace()
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  const control = screen.getByLabelText('Search location and engines') as HTMLSelectElement
  expect([...control.options].map(option => option.text)).toEqual(options)
  // With none to choose, a short caution says so, and Review stays off.
  if (contexts.length === 0) noteButton('No search location', 'No search location and engines are set up for this project.')
  else expect(screen.queryByText('No search location')).toBeNull()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
})

test('offers to keep the combinations a draft already holds', () => {
  const chicago = { ...selectedContext, location: 'Chicago' }
  const draft = { ...defaultTrackingDraft({ measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' }), text: 'Acme hours', contexts: [selectedContext, chicago] }
  const onDraftChange = vi.fn()
  render(<TrackingComposer workspace={workspace() as never} templates={[]} action={{ kind: 'add' }} draft={draft} onDraftChange={onDraftChange} onClose={vi.fn()} canReview isPreviewing={false} editorHeadingRef={{ current: null }} onReview={vi.fn()} />)
  const control = screen.getByLabelText('Search location and engines') as HTMLSelectElement
  // The draft's own two stay one choice, ahead of the single ones.
  expect([...control.options].map(option => option.text)).toEqual(['Choose a search location and engines', 'Keep 2 current combinations', 'New York · openai (gpt-5)', 'Chicago · openai (gpt-5)'])
  expect(control.selectedOptions[0]!.text).toBe('Keep 2 current combinations')
  fireEvent.change(control, { target: { value: control.options[3]!.value } })
  expect(onDraftChange).toHaveBeenLastCalledWith({ ...draft, contexts: [chicago] })
})

test('opens Property Add with a compact destination and expands assignments only on Change', async () => {
  const data = workspace()
  data.targets.push(...Array.from({ length: 224 }, (_, index) => ({ stableKey: `property-${index}`, label: `Property ${index}` })))
  installWorkspaceApi(undefined, [], data)
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  expect(screen.getByText('Location: Acme')).toBeTruthy()
  expect(screen.getByText('Location: Acme').closest('fieldset')?.classList.contains('self-start')).toBe(true)
  expect(screen.queryByRole('checkbox', { name: 'Property 223, Location' })).toBeNull()
  expect(screen.getByRole('combobox', { name: 'Search location and engines' }).closest('details')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Change tracking destination' }))
  expect(screen.getByRole('checkbox', { name: 'Acme, Location' })).toBeTruthy()
  const search = screen.getByRole('searchbox', { name: 'Filter places' }) as HTMLInputElement
  expect(search.placeholder).toBe('Search places')
  fireEvent.change(search, { target: { value: 'Property 223' } })
  expect(screen.getByRole('checkbox', { name: 'Property 223, Location' })).toBeTruthy()
  fireEvent.change(search, { target: { value: 'no such place' } })
  expect(screen.getByText('No matches')).toBeTruthy()
})

test('clears the previous confirmation while a changed draft awaits a new preview', async () => {
  let requests = 0
  let finishPreview: ((response: Response) => void) | undefined
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) {
      requests += 1
      if (requests === 1) return jsonResponse(preview())
      return new Promise<Response>(resolve => { finishPreview = resolve })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'New question' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByRole('heading', { name: 'Review tracking changes' })

  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Acme pricing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await waitFor(() => expect(finishPreview).toBeTypeOf('function'))
  expect(screen.queryByRole('button', { name: 'Publish changes' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Review tracking changes' })).toBeNull()

  finishPreview!(jsonResponse(preview({ diff: { added: [], removed: [], reused: [], unchanged: [], noOp: true } })))
  const noOp = await screen.findByRole('heading', { name: 'No tracking changes' })
  expect(document.activeElement).toBe(noOp)
  expect(screen.getByRole('button', { name: 'Publish changes' }).hasAttribute('disabled')).toBe(true)
})

test('focuses and scrolls an opened assignment editor without hijacking assignment checkbox focus', async () => {
  installWorkspaceApi()
  const scrollIntoView = installScrollSpy()
  renderWorkspace()

  await screen.findByText('Acme pricing')
  const add = screen.getByRole('button', { name: 'Add queries' })
  add.focus()
  fireEvent.click(add)
  fireEvent.click(screen.getByRole('button', { name: 'More ways to add' }))

  const heading = await screen.findByRole('heading', { name: 'Add query' })
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' }))
  expect(heading.getAttribute('tabindex')).toBe('-1')
  expect(document.activeElement).toBe(heading)
  // The closed sheet returns focus to its opener a task later unless told not to.
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(document.activeElement).toBe(heading)

  const group = screen.getByRole('checkbox', { name: 'North East, Group' })
  group.focus()
  fireEvent.click(group)
  expect(document.activeElement).toBe(group)
})

test('requires a selected context for an advanced addition, then uses the server preview and keeps no-op confirmation disabled', async () => {
  const requests: Array<{ path: string; body: unknown }> = []
  installWorkspaceApi((path, body) => {
    requests.push({ path, body })
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      return jsonResponse(preview({
        diff: { added: [], removed: [], reused: [], unchanged: [{ queryId: 'query-acme', queryText: 'Acme pricing', assignmentCount: 1 }], noOp: true },
        workload: { existingNodes: 2, existingProviderCalls: 2, nextSweepNodes: 2, nextSweepProviderCalls: 2, addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0 },
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Acme pricing' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('No tracking changes')
  expect(screen.getByRole('button', { name: 'Publish changes' }).hasAttribute('disabled')).toBe(true)
  const unchanged = screen.getByText('1 unchanged query').closest('details')
  expect(unchanged?.open).toBe(false)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/preview',
    body: {
      expectedWorkspaceVersion: workspaceVersion,
      additions: [{ input: { source: 'manual', text: 'Acme pricing' }, audience: { targetKeys: ['acme'] }, contexts: [selectedContext] }],
      removals: [],
    },
  })
})

test('sends one explicitly selected context for a new advanced group assignment', async () => {
  let previewBody: Record<string, unknown> | undefined
  const contexts = [
    context,
    { ...context, location: { label: 'Chicago', city: 'Chicago', region: 'IL', country: 'US' } },
  ]
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({
        diff: { added: [{ queryId: 'query-new-group', queryText: 'New group query', assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
        tracked: [{
          queryId: 'query-new-group', queryText: 'New group query', normalizedText: 'new group query',
          provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:15:00.000Z' },
          state: 'awaiting-sweep', lastMeasuredAt: null,
          assignments: [{ targetKey: 'acme', groupKeys: ['north-east'], marketKeys: [], queryClass: 'non-brand', classificationSource: 'server', contexts: [context] }],
        }],
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], { ...workspace(), defaultContexts: contexts })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'New group query' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^North East/ }))
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext('New York')
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Review 1 change')
  const added = reviewRow('New group query')
  // One changed row, so where it is asked is said once above the table, with the model id as its help.
  expect(added).toMatchObject({ change: 'Added', type: 'Non-brand', assignments: '1', searchLocation: undefined })
  expect(sharedSearchLocation()).toEqual({ label: 'New York · OpenAI', models: 'New York · openai (gpt-5)' })
  expect(listLocations(added.row, '1 location')).toEqual(['Acme · Non-brand · Groups: North East'])
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'New group query' },
      audience: { groupKeys: ['north-east'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
})

test('requires an explicit context when a market is combined with a group', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Mixed scope query' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'New York, Market' }))
  expect(screen.queryByLabelText('Search location and engines')).toBeNull()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(false)

  fireEvent.click(screen.getByRole('checkbox', { name: 'North East, Group' }))
  expect(screen.getByLabelText('Search location and engines')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Review tracking changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: { source: 'manual', text: 'Mixed scope query' },
      audience: { groupKeys: ['north-east'], marketKeys: ['new-york'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
}, 10_000)

test('promotes a saved research query as source provenance, never an answer or a sweep request', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview({
        diff: { added: [{ queryId: 'query-research', queryText: 'How do teams compare AEO platforms?', assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
      }))
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'research' } })
  fireEvent.change(screen.getByLabelText('Saved research query'), { target: { value: 'research-query-1' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('1 added')
  noteButton('Saved query only', 'Only the saved query is added, not its saved answer.')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'research', researchRunQueryId: 'research-query-1' }, audience: { targetKeys: ['acme'] }, contexts: [selectedContext] }],
    removals: [],
  })
})

test.each(['research', 'discovery'] as const)('tracks a selected saved %s result through Research navigation, assignment, review, and confirmation', async (source) => {
  const writes: Array<{ path: string; body: unknown }> = []
  const data = workspace()
  const queryText = source === 'research' ? 'How do teams compare AEO platforms?' : 'What does Acme cost?'
  const sourceInput = source === 'research'
    ? { source, researchRunQueryId: 'research-query-1' }
    : { source, discoveryProbeId: 'discovery-probe-1' }
  const added = {
    ...data.tracked[1]!, queryId: 'query-promoted', queryText, normalizedText: queryText.toLowerCase(),
    provenance: { source, sourceId: source === 'research' ? 'research-query-1' : 'discovery-probe-1', capturedAt: '2026-09-04T12:00:00.000Z' },
    assignments: [{ ...data.tracked[1]!.assignments[0]!, groupKeys: [], marketKeys: ['new-york'] }],
  }
  const reviewed = preview({
    tracked: [...data.tracked, added],
    diff: { added: [{ queryId: added.queryId, queryText, assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
  })
  const run = {
    id: 'research-run-1', projectId: 'project-demo', status: 'completed', provider: 'openai', requestedModel: 'gpt-5', resolvedModel: 'gpt-5',
    scope: source === 'research' ? { kind: 'market', key: 'new-york', label: 'New York', planRevision: 4 } : null, location: context.location, totalQueries: 2, completedQueries: 2, failedQueries: 0, error: null,
    startedAt: '2026-09-04T10:00:00.000Z', finishedAt: '2026-09-04T10:01:00.000Z', createdAt: '2026-09-04T10:00:00.000Z',
  }
  const researchQuery = (id: string, text: string) => ({
    id, query: text, position: 0, status: 'completed', requestedModel: 'gpt-5', resolvedModel: 'gpt-5', servedModel: 'gpt-5',
    answerText: `Saved answer for ${text}`, groundingSources: [{ uri: 'https://rival.example/source', title: 'Saved research source' }],
    citedDomains: ['rival.example'], searchQueries: [], namedCompetitors: ['Rival'], citedCompetitorDomains: ['rival.example'],
    answerMentioned: false, citationState: 'not-cited', error: null,
    startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt,
  })
  const session = {
    id: 'discovery-session-1', projectId: 'project-demo', status: 'completed', icpDescription: 'Operators comparing AEO services',
    probeCount: 2, citedCount: 1, aspirationalCount: 1, wastedCount: 0, competitorMap: [{ domain: 'rival.example', hits: 2 }],
    createdAt: '2026-09-04T10:00:00.000Z',
  }
  installWorkspaceApi((path, body, method) => {
    if (method !== 'GET') writes.push({ path, body })
    if (path === '/api/v1/projects/demo/discover/sessions' && method === 'GET') return jsonResponse(source === 'discovery' ? [session] : [])
    if (path === '/api/v1/projects/demo/discover/sessions/discovery-session-1' && method === 'GET') {
      return jsonResponse({ ...session, probes: [
        { id: 'discovery-other', sessionId: session.id, projectId: session.projectId, query: 'Another discovery question', bucket: 'cited', citationState: 'cited', citedDomains: ['demo.example'], answerMentioned: true, createdAt: session.createdAt },
        { id: 'discovery-probe-1', sessionId: session.id, projectId: session.projectId, query: queryText, bucket: 'aspirational', citationState: 'not-cited', citedDomains: ['rival.example'], answerMentioned: false, createdAt: session.createdAt },
      ] })
    }
    if (path === '/api/v1/projects/demo/research/runs' && method === 'GET') return jsonResponse({ runs: [run] })
    if (path === '/api/v1/projects/demo/research/runs/research-run-1' && method === 'GET') {
      return jsonResponse({ ...run, queries: [researchQuery('research-other', 'Another research question'), researchQuery('research-query-1', queryText)] })
    }
    if (path === '/api/v1/projects/demo' && method === 'GET') return jsonResponse({ name: 'demo', locations: [context.location], providers: [], providerModels: {}, defaultLocation: null })
    if (path === '/api/v1/settings' && method === 'GET') return jsonResponse({ providers: [], providerCatalog: [] })
    if (path === '/api/v1/projects/demo/query-tracking/preview' && method === 'POST') return jsonResponse(reviewed)
    if (path === '/api/v1/projects/demo/query-tracking/commit' && method === 'POST') {
      data.tracked.push(added)
      return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt: reviewed.reviewedAt, active, diff: reviewed.diff, workload: reviewed.workload })
    }
    throw new Error(`Unexpected ${method}: ${path}`)
  }, [], data)
  const selectedProperty = { measurementScope: 'property' as const, measurementScopeKey: 'acme', queryClass: 'all' as const, provider: 'gemini', location: 'Boston' }
  const onSelectionChange = vi.fn()
  renderWorkspace({ queryWorkspace: undefined, researchMode: undefined, selection: selectedProperty, onSelectionChange })

  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('tab', { name: 'Research', exact: true }))
  // Research opens on Write, with the saved runs under it. Find ideas is one choice of "Start from", not a tab.
  expect(screen.getByRole('radio', { name: 'Write' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Tracked', 'Research'])
  if (source === 'research') {
    fireEvent.click(await screen.findByRole('button', { name: queryText }))
    expect(await screen.findByText(`Saved answer for ${queryText}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review for tracking' }))
  } else {
    fireEvent.click(screen.getByRole('radio', { name: 'Find ideas' }))
    expect(screen.getByRole('radio', { name: 'Find ideas' }).getAttribute('aria-checked')).toBe('true')
    // By role, because Write stays drawn behind Find ideas, hidden, and its results hold the same text.
    const result = await screen.findByRole('cell', { name: queryText })
    fireEvent.click(within(result.closest('tr')!).getByRole('button', { name: 'Review for tracking' }))
  }

  expect(await screen.findByRole('heading', { name: 'Add query' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'Tracked' }).getAttribute('aria-selected')).toBe('true')
  expect((screen.getByLabelText(source === 'research' ? 'Saved research query' : 'Discovery query') as HTMLSelectElement).value).toBe(source === 'research' ? 'research-query-1' : 'discovery-probe-1')
  if (source === 'research') {
    expect(onSelectionChange).toHaveBeenCalledWith({ measurementScope: 'market', measurementScopeKey: 'new-york' })
    expect(screen.queryByLabelText('Search location and engines')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(false)
  } else {
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'Acme, Location' })).toHaveProperty('checked', false)
    expect((screen.getByLabelText('Search location and engines') as HTMLSelectElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Review changes' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
    chooseContext()
  }
  expect(writes).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('1 added')
  expect(writes).toEqual([{
    path: '/api/v1/projects/demo/query-tracking/preview',
    body: { expectedWorkspaceVersion: workspaceVersion, additions: [{ input: sourceInput, audience: source === 'research' ? { marketKeys: ['new-york'] } : { targetKeys: ['acme'] }, ...(source === 'research' ? {} : { contexts: [selectedContext] }) }], removals: [] },
  }])
  fireEvent.click(screen.getByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes[1]).toEqual({
    path: '/api/v1/projects/demo/query-tracking/commit',
    body: { ...(writes[0]!.body as Record<string, unknown>), previewToken, reviewedAt: reviewed.reviewedAt },
  })
  const trackedRow = (await screen.findByRole('button', { name: `Actions for ${queryText}` })).closest('tr')!
  expect(trackedRow.textContent).toContain('First answers')
}, 15_000)

test.each([false, true])('keeps reused-query classifications collapsed until requested (no-op: %s)', async noOp => {
  const data = workspace()
  data.targets.push({ stableKey: 'beta', label: 'Beta' })
  const existing = data.tracked[0]!
  const reused = { ...existing, assignments: [
    { ...existing.assignments[0]!, queryClass: 'non-brand' },
    { ...existing.assignments[0]!, targetKey: 'beta', queryClass: 'branded' },
  ] }
  installWorkspaceApi(path => {
    if (path.endsWith('/query-tracking/preview')) return jsonResponse(preview({
      tracked: [reused], diff: { added: [], removed: [], reused: [{ queryId: existing.queryId, queryText: existing.queryText, assignmentCount: 1 }], unchanged: [], noOp },
    }))
    throw new Error(`Unexpected fetch: ${path}`)
  }, [], data)
  renderWorkspace({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Acme pricing' } })
  fireEvent.click(screen.getByText('Measurement options', { selector: 'summary' }))
  fireEvent.change(screen.getByLabelText('Type', { selector: '#tracking-query-class' }), { target: { value: 'non-brand' } })
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await screen.findByText('1 reused')
  // A no-op lists the query it matched and counts no change.
  expect(screen.getByRole('heading', { name: noOp ? 'No tracking changes' : 'Review 1 change' })).toBeTruthy()
  expect((screen.getByRole('button', { name: noOp ? 'Publish changes' : 'Publish 1 change' }) as HTMLButtonElement).disabled).toBe(noOp)
  // Asked under both types, the row reads as the Tracked table reads it. Each location's own type is in its list.
  expect(reviewRow('Acme pricing').type).toBe('Mixed')
  expect(screen.queryByText(/^Acme · Non-brand ·/)).toBeNull()
  const lines = listLocations(reviewRow('Acme pricing').row, '2 locations')
  expect(lines[0]).toMatch(/^Acme · Non-brand ·/)
  expect(lines[1]).toMatch(/^Beta · Branded ·/)
})

test('sends an explicit class only when the operator overrides server classification', async () => {
  let previewBody: Record<string, unknown> | undefined
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  })
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'Enterprise AEO platform' } })
  fireEvent.change(screen.getByLabelText('Type', { selector: '#tracking-query-class' }), { target: { value: 'non-brand' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  chooseContext()
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Review tracking changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{ input: { source: 'manual', text: 'Enterprise AEO platform' }, audience: { targetKeys: ['acme'] }, contexts: [selectedContext], queryClass: 'non-brand' }],
    removals: [],
  })
})

test('does not offer a template source when this portfolio has no saved templates', async () => {
  installWorkspaceApi()
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()

  const source = screen.getByLabelText('Query source') as HTMLSelectElement
  expect([...source.options].map(option => option.textContent)).toEqual(['Write a query', 'Saved research', 'Discovery result'])
  // The select is described by a short note, with the sentence as the note's help.
  const described = document.getElementById(source.getAttribute('aria-describedby')!)!
  noteButton('No saved patterns', 'No saved patterns are set up for this project. Write a query, or use saved research or a discovery result.', described)
})

test('requires a market for a saved market template before sending its identity and pattern for expansion', async () => {
  let previewBody: Record<string, unknown> | undefined
  const template = {
    id: 'template-market', projectId: 'project-demo', name: 'Market comparison', description: null,
    pattern: 'Best {property} provider in {market}', variables: ['property', 'market'],
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z',
  }
  installWorkspaceApi((path, body) => {
    if (path === '/api/v1/projects/demo/query-tracking/preview') {
      previewBody = body as Record<string, unknown>
      return jsonResponse(preview())
    }
    throw new Error(`Unexpected fetch: ${path}`)
  }, [template])
  renderWorkspace()

  await screen.findByText('Acme pricing')
  openLegacyAdd()
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'template' } })
  expect(screen.getByRole('option', { name: 'Saved pattern' })).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Choose a pattern' })).toBeTruthy()
  const pattern = screen.getByLabelText('Saved pattern')
  fireEvent.change(pattern, { target: { value: 'template-market' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Acme, Location' }))
  chooseContext()
  const review = screen.getByRole('button', { name: 'Review changes' })
  expect(review.hasAttribute('disabled')).toBe(true)
  const needsMarket = noteButton('Needs a market', 'This pattern needs a market. Choose one under Apply to. A location alone does not select a market.')
  expect(needsMarket.closest('[role="status"]')!.id).toBe(pattern.getAttribute('aria-describedby'))
  fireEvent.click(review)
  expect(previewBody).toBeUndefined()

  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'manual' } })
  fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'How does Acme compare?' } })
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.change(screen.getByLabelText('Query source'), { target: { value: 'template' } })
  expect(review.hasAttribute('disabled')).toBe(true)

  fireEvent.click(screen.getByRole('checkbox', { name: 'New York, Market' }))
  expect(review.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

  await screen.findByText('Review tracking changes')
  expect(previewBody).toEqual({
    expectedWorkspaceVersion: workspaceVersion,
    additions: [{
      input: {
        source: 'template', templateId: 'template-market', templateVersion: '2026-09-04T12:00:00.000Z',
        template: 'Best {property} provider in {market}',
      },
      audience: { targetKeys: ['acme'], marketKeys: ['new-york'] },
      contexts: [selectedContext],
    }],
    removals: [],
  })
})
