import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryTrackingPreviewRequestSchema, queryTrackingPreviewResponseSchema } from '@ainyc/canonry-contracts'

import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { getToasts, resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const workspaceVersion = `qtw_${'a'.repeat(64)}`
const previewToken = `qtp_${'b'.repeat(64)}`
const reviewedAt = '2026-09-04T12:15:00.000Z'
const active = { revision: 4, compiledChecksum: 'c'.repeat(64) }
const context = {
  providers: ['openai'],
  models: { openai: 'gpt-5' },
  location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
}
const tracked = [{
  queryId: 'query-acme', queryText: 'Acme pricing', normalizedText: 'acme pricing',
  provenance: { source: 'manual', sourceId: null, capturedAt: '2026-09-04T12:00:00.000Z' },
  state: 'tracked', lastMeasuredAt: '2026-09-04T12:10:00.000Z',
  assignments: [{ targetKey: 'acme', groupKeys: ['north-east'], marketKeys: ['new-york'], queryClass: 'branded', classificationSource: 'frozen', contexts: [context] }],
}]
const resetNotice = 'After you publish, AI Visibility keeps showing the last sweep until the next sweep. Location pages and competitor results show no numbers until then. Past answers are kept.'
const handPickedLink = 'Hand-picked locations, templates or saved research'
const firstLineOnly = 'The Add query form adds one query at a time. It opens with your first line only.'

/** One group holding the New York market, and a second market that sits in no group. */
function workspace(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'advanced', workspaceVersion, active, defaultContexts: [context],
    targets: [{ stableKey: 'acme', label: 'Acme' }],
    groups: [{ stableKey: 'north-east', label: 'North East', targetKeys: ['acme'] }],
    markets: [
      { stableKey: 'new-york', label: 'New York', groupKey: 'north-east', usageEdges: [] },
      { stableKey: 'remote', label: 'Remote searches', usageEdges: [] },
    ],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
      { id: 'north-east', label: 'North East', kind: 'group', targetCount: 1 },
      { id: 'new-york', label: 'New York', kind: 'market', targetCount: 1, parentGroupIds: ['north-east'] },
      { id: 'remote', label: 'Remote searches', kind: 'market', targetCount: 1 },
      { id: 'acme', label: 'Acme', kind: 'property', targetCount: 1, parentGroupIds: ['north-east'] },
    ],
    tracked,
    savedSources: { research: [], discovery: [] },
    ...overrides,
  }
}

const usageEdge = (targetKey: string, queryId = 'query-acme') => ({ executionNodeKey: `node-${queryId}-${targetKey}`, targetKey, queryId })
const bostonContext = {
  providers: ['openai', 'gemini'],
  models: { openai: 'gpt-5', gemini: 'gemini-3' },
  location: { label: 'Boston', city: 'Boston', region: 'MA', country: 'US' },
}

/** Acme has queries in two markets (two in one of them), Cedar Court only in a third, and Birch House in none. */
function locationWorkspace(overrides: Record<string, unknown> = {}) {
  const location = (id: string, label: string) => ({ id, label, kind: 'property', targetCount: 1, parentGroupIds: ['north-east'] })
  return workspace({
    targets: [{ stableKey: 'acme', label: 'Acme' }, { stableKey: 'birch', label: 'Birch House' }, { stableKey: 'cedar', label: 'Cedar Court' }],
    groups: [{ stableKey: 'north-east', label: 'North East', targetKeys: ['acme', 'birch', 'cedar'] }],
    markets: [
      { stableKey: 'new-york', label: 'New York', groupKey: 'north-east', usageEdges: [usageEdge('acme')] },
      { stableKey: 'remote', label: 'Remote searches', usageEdges: [usageEdge('acme'), usageEdge('acme', 'query-remote')] },
      { stableKey: 'boston', label: 'Boston', usageEdges: [usageEdge('cedar')] },
    ],
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 3 },
      { id: 'north-east', label: 'North East', kind: 'group', targetCount: 3 },
      { id: 'new-york', label: 'New York', kind: 'market', targetCount: 1, parentGroupIds: ['north-east'] },
      { id: 'remote', label: 'Remote searches', kind: 'market', targetCount: 1 },
      { id: 'boston', label: 'Boston', kind: 'market', targetCount: 1 },
      location('acme', 'Acme'),
      location('birch', 'Birch House'),
      location('cedar', 'Cedar Court'),
    ],
    ...overrides,
  })
}

function preview(added: string[], version = workspaceVersion) {
  // Each node is asked on three engines, so an answer number read from the node counts would show.
  const calls = { existingNodes: 1, existingProviderCalls: 3, nextSweepNodes: 1 + added.length, nextSweepProviderCalls: 3 * (1 + added.length), addedNodes: added.length, addedProviderCalls: 3 * added.length, removedNodes: 0, removedProviderCalls: 0 }
  const rows = added.map((queryText, index) => ({ queryId: `query-new-${index}`, queryText, assignmentCount: 1 }))
  return {
    mode: 'advanced', workspaceVersion: version, previewToken, reviewedAt, active,
    // As the server answers a review: `tracked` is the post-change list, so it holds each added query.
    tracked: [...tracked, ...rows.map(row => ({
      ...tracked[0]!, queryId: row.queryId, queryText: row.queryText, normalizedText: row.queryText.toLowerCase(), state: 'awaiting-sweep', lastMeasuredAt: null,
      assignments: [{ ...tracked[0]!.assignments[0]!, queryClass: 'non-brand', classificationSource: 'server' }],
    }))],
    diff: { added: rows, removed: [], reused: [], unchanged: [], noOp: false },
    workload: calls,
  }
}

type Write = { operation: string; body: { expectedWorkspaceVersion: string; additions: Array<{ input: { text: string } }> } }

/** Serves the workspace and records every review and publish the sheet sends; `respond` can answer one itself. */
function installApi(options: { workspace?: () => unknown; respond?: (write: Write) => Response | Promise<Response> | undefined } = {}) {
  const writes: Write[] = []
  onTestFinished(mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/query-tracking') return jsonResponse((options.workspace ?? workspace)())
    if (path === '/api/v1/projects/demo/measurement-query-templates') return jsonResponse({ templates: [] })
    const operation = path.replace('/api/v1/projects/demo/query-tracking/', '')
    if (operation !== 'preview' && operation !== 'commit') throw new Error(`Unexpected fetch: ${path}`)
    const write = { operation, body: JSON.parse(String(init?.body)) } as Write
    writes.push(write)
    const response = options.respond?.(write)
    if (response) return response
    if (operation === 'preview') return jsonResponse(preview(write.body.additions.map(addition => addition.input.text), write.body.expectedWorkspaceVersion))
    return jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt, active })
  }))
  return writes
}

type TrackedProps = Partial<React.ComponentProps<typeof QueriesSection>>

/** `show` renders the same section again with other props, as the page does when the Tracked filter changes. */
function renderTracked(props: TrackedProps = {}, role?: 'viewer') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const section = (next: TrackedProps) => {
    const tracked = <QueryClientProvider client={queryClient}><QueriesSection projectName="demo" {...next} /></QueryClientProvider>
    return role ? <AccountProvider account={{ name: role, role }}>{tracked}</AccountProvider> : tracked
  }
  const { rerender } = render(section(props))
  return { queryClient, show: (next: TrackedProps) => rerender(section(next)) }
}

async function openSheet() {
  await screen.findByText('Acme pricing')
  const opener = screen.getByRole('button', { name: 'Add queries' })
  opener.focus()
  fireEvent.click(opener)
  return { opener, sheet: within(screen.getByRole('dialog', { name: 'Add queries' })) }
}

type Sheet = Awaited<ReturnType<typeof openSheet>>['sheet']
const queriesField = (sheet: Sheet) => sheet.getByLabelText('Queries') as HTMLTextAreaElement
const reviewButton = (sheet: Sheet) => sheet.getByRole('button', { name: 'Review' }) as HTMLButtonElement
const reviewHeading = (sheet: Sheet) => sheet.findByRole('heading', { name: /^Review \d+ changes?$/ })
const sheetIsOpen = () => screen.queryByRole('dialog', { name: 'Add queries' }) !== null
const sheetText = () => screen.getByRole('dialog', { name: 'Add queries' }).textContent

// A group row only browses; the market inside it is the choice.
function chooseNewYorkFromGroup(sheet: Sheet) {
  fireEvent.click(sheet.getByRole('button', { name: 'Browse North East' }))
  fireEvent.click(sheet.getByRole('button', { name: 'Select New York' }))
}

function chooseNewYork(sheet: Sheet) {
  fireEvent.click(sheet.getByText('Choose a market'))
  chooseNewYorkFromGroup(sheet)
}

function fill(sheet: Sheet, text: string) {
  chooseNewYork(sheet)
  fireEvent.change(queriesField(sheet), { target: { value: text } })
}

const newYorkAddition = (text: string) => ({ input: { source: 'manual', text }, audience: { marketKeys: ['new-york'] } })

// As for a market, a group row only browses; the location inside it is the choice.
function chooseLocation(sheet: Sheet, label: string) {
  fireEvent.click(sheet.getByText('Choose a location'))
  fireEvent.click(sheet.getByRole('button', { name: 'Browse North East' }))
  fireEvent.click(sheet.getByRole('button', { name: `Select ${label}` }))
}

function fillLocation(sheet: Sheet, label: string, text: string) {
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  chooseLocation(sheet, label)
  fireEvent.change(queriesField(sheet), { target: { value: text } })
}

/** Acme sits in New York and Remote searches, so its queries name both and no contexts. */
const acmeAddition = (text: string) => ({ input: { source: 'manual', text }, audience: { targetKeys: ['acme'], marketKeys: ['new-york', 'remote'] } })
/** Birch House is in no market, so its queries name it alone and one search location and engines. */
const birchAddition = (text: string, chosen: Record<string, unknown>) => ({ input: { source: 'manual', text }, audience: { targetKeys: ['birch'] }, contexts: [chosen] })

/** After a hand-off the sheet is gone, the form holds the first line, and focus stays on the form. */
async function expectAddQueryForm(firstLine: string) {
  const heading = await screen.findByRole('heading', { name: 'Add query' })
  expect(sheetIsOpen()).toBe(false)
  expect(screen.getByRole('group', { name: 'Apply to' })).toBeTruthy()
  expect((screen.getByLabelText('Question') as HTMLTextAreaElement).value).toBe(firstLine)
  // The market chosen in the sheet stays behind: checked here it would narrow hand-picked locations to it.
  expect((screen.getByRole('checkbox', { name: 'New York, Market' }) as HTMLInputElement).checked).toBe(false)
  // The form keeps the focus it took; the closed sheet does not hand it back to its opener.
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(document.activeElement).toBe(heading)
}

test('opens from Tracked on an advanced project and keeps Review off until a market and a query line exist', async () => {
  const writes = installApi()
  renderTracked()
  const { sheet } = await openSheet()
  // The open sheet hides the page behind it from assistive tech, so look past that for the form.
  expect(screen.queryByRole('heading', { name: 'Add query', hidden: true })).toBeNull()
  expect(within(sheet.getByRole('radiogroup', { name: 'Subject' })).getByRole('radio', { name: 'Market' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.getByText('More options', { selector: 'summary' })).toBeTruthy()
  // The market list is in the sheet too, group rows and their location counts included.
  expect(sheetText()).not.toMatch(/question|propert/i)
  expect(reviewButton(sheet).disabled).toBe(true)

  fireEvent.change(queriesField(sheet), { target: { value: 'best pizza in New York' } })
  expect(reviewButton(sheet).disabled).toBe(true)
  fireEvent.click(sheet.getByText('Choose a market'))
  // The list holds groups and markets, never locations.
  const search = sheet.getByPlaceholderText('Search groups or markets')
  fireEvent.change(search, { target: { value: 'Acme' } })
  expect(sheet.getByText('No matching scopes.')).toBeTruthy()
  fireEvent.change(search, { target: { value: '' } })
  // A group row only browses: it is never a choice, here or once inside it.
  expect(sheet.queryByRole('button', { name: 'Select North East' })).toBeNull()
  fireEvent.click(sheet.getByRole('button', { name: 'Browse North East' }))
  expect(sheet.queryByText('All properties in this group')).toBeNull()
  fireEvent.click(sheet.getByRole('button', { name: 'Select New York' }))
  expect(sheet.getByText('New York · Market')).toBeTruthy()
  expect(reviewButton(sheet).disabled).toBe(false)

  fireEvent.change(queriesField(sheet), { target: { value: ' \n\n  ' } })
  expect(reviewButton(sheet).disabled).toBe(true)
  fireEvent.click(reviewButton(sheet))
  expect(writes).toEqual([])
})

test('sends one addition per line for the chosen market, with no contexts, and drops blank and repeated lines', async () => {
  const writes = installApi({ workspace: () => workspace({ defaultContexts: [context, bostonContext] }) })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, [
    'best family resorts in New York',
    '',
    '  hotels near Central Park  ',
    'Best Family  Resorts in New York',
    '   ',
    'hotels with a pool in New York',
    'hotels near Central Park',
  ].join('\n'))
  expect(sheet.getByText(/3 queries to add\.$/)).toBeTruthy()
  // The lines under the picker and the search location pick are for a location only, however many the project has.
  expect(sheet.queryByText('This location is in no market.')).toBeNull()
  expect(sheet.queryByText(/^(Counts in|Engines and search locations come from|Search location and engines)/)).toBeNull()
  expect(sheet.queryByRole('combobox')).toBeNull()
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes).toEqual([{
    operation: 'preview',
    body: {
      expectedWorkspaceVersion: workspaceVersion,
      additions: [
        newYorkAddition('best family resorts in New York'),
        newYorkAddition('hotels near Central Park'),
        newYorkAddition('hotels with a pool in New York'),
      ],
      removals: [],
    },
  }])
})

test.each([
  ['Branded', 'branded'],
  ['Non-brand', 'non-brand'],
])('sends a %s Type choice on every addition', async (label, queryClass) => {
  const writes = installApi()
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'Acme reviews\nAcme pricing plans')
  const type = sheet.getByRole('radiogroup', { name: 'Type' })
  expect(type.closest('details')!.open).toBe(false)
  expect(within(type).getByRole('radio', { name: 'Automatic' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(within(type).getByRole('radio', { name: label }))
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([
    { ...newYorkAddition('Acme reviews'), queryClass },
    { ...newYorkAddition('Acme pricing plans'), queryClass },
  ])
})

test('keeps a Type choice across a Subject change, in view while More options is closed', async () => {
  const writes = installApi()
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'Acme reviews')
  fireEvent.click(within(sheet.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'Branded' }))
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  expect(sheet.getByText('More options · Type: Branded', { selector: 'summary' }).closest('details')!.open).toBe(false)
  fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))
  expect(sheet.getByText('More options · Type: Branded', { selector: 'summary' }).closest('details')!.open).toBe(false)
  // The Subject change dropped the market, so it is chosen again.
  chooseNewYork(sheet)
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([{ ...newYorkAddition('Acme reviews'), queryClass: 'branded' }])
})

test('lists only the groups that lead to a market', async () => {
  installApi({ workspace: () => workspace({
    scopeOptions: [
      ...workspace().scopeOptions.map(option => option.id === 'north-east' ? { ...option, parentGroupIds: ['east'] } : option),
      { id: 'east', label: 'East', kind: 'group', targetCount: 1 },
      { id: 'south-west', label: 'South West', kind: 'group', targetCount: 3 },
    ],
  }) })
  renderTracked()
  const { sheet } = await openSheet()
  fireEvent.click(sheet.getByText('Choose a market'))
  // East holds no market itself but its subgroup does; South West would open on an empty list.
  expect(sheet.queryByRole('button', { name: 'Browse South West' })).toBeNull()
  fireEvent.click(sheet.getByRole('button', { name: 'Browse East' }))
  chooseNewYorkFromGroup(sheet)
  expect(sheet.getByText('New York · Market')).toBeTruthy()
})

test('reviews inside the sheet, keeps the draft on Back, and publishes with the review token', async () => {
  resetToasts()
  onTestFinished(resetToasts)
  const writes = installApi()
  renderTracked()
  const { opener, sheet } = await openSheet()
  fill(sheet, 'best pizza in New York\nbest bagels in New York')
  fireEvent.click(reviewButton(sheet))

  await sheet.findByRole('heading', { name: 'Review 2 changes' })
  expect(Object.fromEntries(sheet.getAllByRole('term').map(term => [term.textContent, term.nextElementSibling?.textContent]))).toEqual({
    Queries: '1 → 3', 'Answers per sweep': '3 → 9', 'Answers added': '+6', 'Answers removed': '−0',
  })
  expect(sheet.getByText('2 added')).toBeTruthy()
  expect(sheet.getByText(resetNotice)).toBeTruthy()
  expect(sheet.getByText('Publishing does not run a sweep.')).toBeTruthy()
  expect(sheet.queryByLabelText('Queries')).toBeNull()
  expect(sheetText()).not.toMatch(/question/i)
  fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
  expect(queriesField(sheet).value).toBe('best pizza in New York\nbest bagels in New York')
  expect(sheet.getByText('New York · Market')).toBeTruthy()

  fireEvent.click(reviewButton(sheet))
  fireEvent.click(await sheet.findByRole('button', { name: 'Publish 2 changes' }))
  await waitFor(() => expect(sheetIsOpen()).toBe(false))
  const reviewed = {
    expectedWorkspaceVersion: workspaceVersion,
    additions: [newYorkAddition('best pizza in New York'), newYorkAddition('best bagels in New York')],
    removals: [],
  }
  expect(writes).toEqual([
    { operation: 'preview', body: reviewed },
    { operation: 'preview', body: reviewed },
    { operation: 'commit', body: { ...reviewed, previewToken, reviewedAt } },
  ])
  await waitFor(() => expect(getToasts().map(toast => toast.title)).toEqual(['Tracked queries updated']))
  await waitFor(() => expect(document.activeElement).toBe(opener))
})

test('pauses publishing in the sheet while a sweep is queued or running', async () => {
  const writes = installApi()
  renderTracked({ publishGuard: { sweepActive: true } })
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))

  const publish = await sheet.findByRole('button', { name: 'Publish 1 change' }) as HTMLButtonElement
  expect(publish.disabled).toBe(true)
  expect(sheet.getByRole('status').textContent).toBe('A sweep is queued or running. Publish after it finishes.')
  // Publish and the pause sit in the footer beside Back, not at the end of the scrolling list of changes.
  const footer = sheet.getByRole('button', { name: 'Back' }).parentElement!
  expect(publish.parentElement).toBe(footer)
  expect(sheet.getByRole('status').parentElement).toBe(footer)
  expect(footer.contains(sheet.getByRole('heading', { name: 'Review 1 change' }))).toBe(false)
  fireEvent.click(publish)
  // A commit reaches fetch only after the mutation's async onMutate, so let a task pass before asserting none went out.
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(writes.map(write => write.operation)).toEqual(['preview'])
})

test('asks for a new review when the draft changes while a review is in flight', async () => {
  let finish: ((response: Response) => void) | undefined
  const writes = installApi({ respond: write => write.operation === 'preview' && !finish ? new Promise<Response>(resolve => { finish = resolve }) : undefined })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect((sheet.getByRole('button', { name: 'Reviewing…' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(queriesField(sheet), { target: { value: 'best bagels in New York' } })

  await act(async () => finish!(jsonResponse(preview(['best pizza in New York']))))
  await waitFor(() => expect(reviewButton(sheet).disabled).toBe(false))
  expect(sheet.queryByRole('button', { name: 'Publish 1 change' })).toBeNull()
  fireEvent.click(reviewButton(sheet))
  await sheet.findByRole('button', { name: 'Publish 1 change' })
  expect(writes.map(write => write.body.additions)).toEqual([[newYorkAddition('best pizza in New York')], [newYorkAddition('best bagels in New York')]])
})

test('asks for a new review when Subject changes while a review is in flight', async () => {
  let finish: ((response: Response) => void) | undefined
  const writes = installApi({
    workspace: locationWorkspace,
    respond: write => write.operation === 'preview' && !finish ? new Promise<Response>(resolve => { finish = resolve }) : undefined,
  })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))

  // The market review lands under Subject Location; confirming it would publish the market draft.
  await act(async () => finish!(jsonResponse(preview(['best pizza in New York']))))
  await waitFor(() => expect(sheet.queryByRole('button', { name: 'Reviewing…' })).toBeNull())
  expect(sheet.queryByRole('button', { name: 'Publish 1 change' })).toBeNull()
  expect(sheet.getByText('Choose a location')).toBeTruthy()
  chooseLocation(sheet, 'Acme')
  fireEvent.click(reviewButton(sheet))
  await sheet.findByRole('button', { name: 'Publish 1 change' })
  expect(writes.map(write => write.body.additions)).toEqual([[newYorkAddition('best pizza in New York')], [acmeAddition('best pizza in New York')]])
})

test('asks for a new review when the search location and engines pick changes while a review is in flight', async () => {
  let finish: ((response: Response) => void) | undefined
  const writes = installApi({
    workspace: () => locationWorkspace({ defaultContexts: [context, bostonContext] }),
    respond: write => write.operation === 'preview' && !finish ? new Promise<Response>(resolve => { finish = resolve }) : undefined,
  })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Birch House', 'Birch House reviews')
  const choice = sheet.getByRole('combobox', { name: 'Search location and engines' })
  fireEvent.change(choice, { target: { value: 'New York · openai (gpt-5)' } })
  fireEvent.click(reviewButton(sheet))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.change(choice, { target: { value: 'Boston · openai (gpt-5), gemini (gemini-3)' } })

  // The New York review lands while the pick shows Boston; confirming it would publish New York.
  await act(async () => finish!(jsonResponse(preview(['Birch House reviews']))))
  await waitFor(() => expect(sheet.queryByRole('button', { name: 'Reviewing…' })).toBeNull())
  expect(sheet.queryByRole('button', { name: 'Publish 1 change' })).toBeNull()
  fireEvent.click(reviewButton(sheet))
  await sheet.findByRole('button', { name: 'Publish 1 change' })
  expect(writes.map(write => write.body.additions)).toEqual([
    [birchAddition('Birch House reviews', { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' })],
    [birchAddition('Birch House reviews', { providers: ['openai', 'gemini'], models: { openai: 'gpt-5', gemini: 'gemini-3' }, location: 'Boston' })],
  ])
})

test.each(['preview', 'commit'] as const)('shows a refused %s in the review, reviews the draft again against the refreshed workspace, and keeps it behind Back', async refused => {
  resetToasts()
  onTestFinished(resetToasts)
  const refreshedVersion = `qtw_${'d'.repeat(64)}`
  let stale = false
  const writes = installApi({
    workspace: () => workspace({ workspaceVersion: stale ? refreshedVersion : workspaceVersion }),
    respond: write => {
      if (write.operation !== refused || stale) return undefined
      stale = true
      return jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' } }, 409)
    },
  })
  const { queryClient } = renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  if (refused === 'commit') fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))

  await waitFor(() => expect(getToasts().map(toast => toast.detail)).toEqual(['Workspace changed. Review again.']))
  // The toast sits under the open sheet, so the review shows the refusal itself, in place of the changes.
  const refusal = `Could not ${refused === 'preview' ? 'review' : 'confirm'} tracking changes. Workspace changed. Review again.`
  expect(sheet.getByRole('alert').textContent).toBe(refusal)
  expect(document.activeElement).toBe(sheet.getByRole('alert'))
  expect(sheet.queryByRole('button', { name: /^Publish/ })).toBeNull()
  expect(sheet.queryByLabelText('Queries')).toBeNull()
  await waitFor(() => expect(queryClient.getQueryCache().getAll().some(query => (query.state.data as { workspaceVersion?: string } | undefined)?.workspaceVersion === refreshedVersion)).toBe(true))
  // Back returns to the same draft, with the refusal still beside it.
  fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
  expect(queriesField(sheet).value).toBe('best pizza in New York')
  expect(sheet.getByText('New York · Market')).toBeTruthy()
  expect(sheet.getByRole('alert').textContent).toBe(refusal)
  fireEvent.click(reviewButton(sheet))
  expect(sheet.queryByRole('alert')).toBeNull()
  expect(await sheet.findByRole('button', { name: 'Publish 1 change' })).toBeTruthy()
  expect(writes.at(-1)).toEqual({
    operation: 'preview',
    body: { expectedWorkspaceVersion: refreshedVersion, additions: [newYorkAddition('best pizza in New York')], removals: [] },
  })
})

test('reviews an expired review again from the review, then publishes it', async () => {
  let refused = false
  const writes = installApi({
    respond: write => {
      if (write.operation !== 'commit' || refused) return undefined
      refused = true
      return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'The reviewed preview has expired or has an invalid review time. Preview the changes again.' } }, 400)
    },
  })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))

  expect((await sheet.findByRole('alert')).textContent).toBe('Could not confirm tracking changes. The reviewed preview has expired or has an invalid review time. Preview the changes again.')
  // Review again and Back share the pinned footer, as Publish and Back do.
  const again = sheet.getByRole('button', { name: 'Review again' })
  expect(again.parentElement).toBe(sheet.getByRole('button', { name: 'Back' }).parentElement)
  fireEvent.click(again)
  fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(sheetIsOpen()).toBe(false))
  const body = { expectedWorkspaceVersion: workspaceVersion, additions: [newYorkAddition('best pizza in New York')], removals: [] }
  expect(writes.map(write => write.operation)).toEqual(['preview', 'commit', 'preview', 'commit'])
  expect(writes.slice(2)).toEqual([{ operation: 'preview', body }, { operation: 'commit', body: { ...body, previewToken, reviewedAt } }])
})

test('sends the reviewed change again when the refreshed workspace no longer holds its market, so the server says why', async () => {
  const refreshedVersion = `qtw_${'d'.repeat(64)}`
  let gone = false
  const withoutNewYork = () => workspace({
    workspaceVersion: refreshedVersion,
    markets: workspace().markets.filter(market => market.stableKey !== 'new-york'),
    scopeOptions: workspace().scopeOptions.filter(option => option.id !== 'new-york'),
  })
  const writes = installApi({
    workspace: () => gone ? withoutNewYork() : workspace(),
    respond: write => {
      if (gone) return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Selected market "new-york" is not in the active plan.' } }, 400)
      if (write.operation !== 'commit') return undefined
      gone = true
      return jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' } }, 409)
    },
  })
  const { queryClient } = renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(queryClient.getQueryCache().getAll().some(query => (query.state.data as { workspaceVersion?: string } | undefined)?.workspaceVersion === refreshedVersion)).toBe(true))

  // The draft's market is gone, so nothing can be rebuilt from it. The reviewed change goes again as it was.
  fireEvent.click(sheet.getByRole('button', { name: 'Review again' }))
  await waitFor(() => expect(sheet.getByRole('alert').textContent).toBe('Could not review tracking changes. Selected market "new-york" is not in the active plan.'))
  expect(writes.map(write => write.operation)).toEqual(['preview', 'commit', 'preview'])
  expect(writes.at(-1)!.body).toEqual({ expectedWorkspaceVersion: refreshedVersion, additions: [newYorkAddition('best pizza in New York')], removals: [] })
  // Back still leads to the draft, where another market can be chosen.
  fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
  expect(queriesField(sheet).value).toBe('best pizza in New York')
  expect(sheet.getByText('Choose a market')).toBeTruthy()
})

test('keeps Back off while a publish is in flight', async () => {
  let finish: ((response: Response) => void) | undefined
  installApi({ respond: write => write.operation === 'commit' ? new Promise<Response>(resolve => { finish = resolve }) : undefined })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  fireEvent.click(reviewButton(sheet))
  fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  // Going back would let another draft be reviewed while this publish still closes the sheet.
  expect((sheet.getByRole('button', { name: 'Publishing…' }) as HTMLButtonElement).disabled).toBe(true)
  expect((sheet.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)

  await act(async () => finish!(jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, reviewedAt, active })))
  await waitFor(() => expect(sheetIsOpen()).toBe(false))
})

test('opens the Add query form from the hand-picked link with the first line typed', async () => {
  installApi()
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  expect(sheet.queryByText(firstLineOnly)).toBeNull()
  fireEvent.change(queriesField(sheet), { target: { value: 'best pizza in New York\nbest bagels in New York' } })
  expect(sheet.getByText(firstLineOnly)).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: handPickedLink }))
  await expectAddQueryForm('best pizza in New York')
})

test('adds a location query to every market that location is in, with no contexts', async () => {
  const writes = installApi({ workspace: locationWorkspace })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Acme', 'Acme reviews\n\nAcme parking\nacme  reviews')
  expect(sheet.getByText('Acme · Location')).toBeTruthy()
  // Boston holds only Cedar Court, and Remote searches is listed once for its two Acme queries.
  expect(sheet.getByText('Counts in: New York, Remote searches')).toBeTruthy()
  expect(sheet.getByText('Engines and search locations come from: New York, Remote searches')).toBeTruthy()
  expect(sheet.queryByText('This location is in no market.')).toBeNull()
  expect(sheet.queryByText(/^Search location and engines/)).toBeNull()
  expect(sheetText()).not.toMatch(/question|propert|—/i)
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes).toEqual([{
    operation: 'preview',
    body: { expectedWorkspaceVersion: workspaceVersion, additions: [acmeAddition('Acme reviews'), acmeAddition('Acme parking')], removals: [] },
  }])
  // The API contract is strict, so this is a request the server reads as sent, with nothing to drop.
  expect(queryTrackingPreviewRequestSchema.safeParse(writes[0]!.body).success).toBe(true)
})

test('sends a Type choice on every location addition', async () => {
  const writes = installApi({ workspace: locationWorkspace })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Acme', 'Acme reviews\nAcme parking')
  fireEvent.click(within(sheet.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'Branded' }))
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([
    { ...acmeAddition('Acme reviews'), queryClass: 'branded' },
    { ...acmeAddition('Acme parking'), queryClass: 'branded' },
  ])
})

test('gives a location in no market the one search location and engines the project has', async () => {
  const writes = installApi({ workspace: locationWorkspace })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Birch House', 'Birch House reviews')
  expect(sheet.getByText('This location is in no market.')).toBeTruthy()
  expect(sheet.getByText('Search location and engines: New York · openai (gpt-5)')).toBeTruthy()
  expect(sheet.queryByRole('combobox')).toBeNull()
  expect(sheet.queryByText(/^Counts in:/)).toBeNull()
  expect(sheetText()).not.toMatch(/question|propert|—/i)
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([
    birchAddition('Birch House reviews', { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' }),
  ])
  expect(queryTrackingPreviewRequestSchema.safeParse(writes[0]!.body).success).toBe(true)
})

test('asks for one search location and engines when a location is in no market and the project has several', async () => {
  const writes = installApi({ workspace: () => locationWorkspace({ defaultContexts: [context, bostonContext] }) })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Birch House', 'Birch House reviews')
  const choice = sheet.getByRole('combobox', { name: 'Search location and engines' }) as HTMLSelectElement
  expect(choice.required).toBe(true)
  expect(choice.value).toBe('')
  // The same choices, in the same words, as the Add query form.
  expect([...choice.options].map(option => option.text)).toEqual([
    'Choose a search location and engines',
    'New York · openai (gpt-5)',
    'Boston · openai (gpt-5), gemini (gemini-3)',
  ])
  expect(sheetText()).not.toMatch(/question|propert|—/i)
  expect(reviewButton(sheet).disabled).toBe(true)
  fireEvent.click(reviewButton(sheet))
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(writes).toEqual([])

  fireEvent.change(choice, { target: { value: 'Boston · openai (gpt-5), gemini (gemini-3)' } })
  expect(reviewButton(sheet).disabled).toBe(false)
  fireEvent.click(reviewButton(sheet))
  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([
    birchAddition('Birch House reviews', { providers: ['openai', 'gemini'], models: { openai: 'gpt-5', gemini: 'gemini-3' }, location: 'Boston' }),
  ])

  // A location in a market takes that market's engines and search locations, never the one chosen above.
  fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
  fireEvent.click(sheet.getByText('Birch House · Location'))
  fireEvent.click(sheet.getByRole('button', { name: 'Select Cedar Court' }))
  expect(sheet.getByText('Counts in: Boston')).toBeTruthy()
  expect(sheet.queryByRole('combobox')).toBeNull()
  fireEvent.click(reviewButton(sheet))
  await reviewHeading(sheet)
  expect(writes[1]!.body.additions).toEqual([
    { input: { source: 'manual', text: 'Birch House reviews' }, audience: { targetKeys: ['cedar'], marketKeys: ['boston'] } },
  ])
})

test('keeps Review off for a location in no market when the project has no engines set up', async () => {
  const writes = installApi({ workspace: () => locationWorkspace({ defaultContexts: [] }) })
  renderTracked()
  const { sheet } = await openSheet()
  fillLocation(sheet, 'Birch House', 'Birch House reviews')
  expect(sheet.getByText('No search location and engines are set up for this project.')).toBeTruthy()
  expect(sheet.queryByRole('combobox')).toBeNull()
  expect(reviewButton(sheet).disabled).toBe(true)
  fireEvent.click(reviewButton(sheet))
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(writes).toEqual([])
})

test('lists groups and locations for Location, never markets, and calls them locations', async () => {
  installApi({ workspace: locationWorkspace })
  renderTracked()
  const { sheet } = await openSheet()
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  fireEvent.click(sheet.getByText('Choose a location'))
  const search = sheet.getByPlaceholderText('Search groups or locations')
  fireEvent.change(search, { target: { value: 'Remote' } })
  expect(sheet.getByText('No matching scopes.')).toBeTruthy()
  fireEvent.change(search, { target: { value: '' } })
  // A group row only browses, as it does for a market.
  expect(sheet.queryByRole('button', { name: 'Select North East' })).toBeNull()
  expect(sheet.getByRole('button', { name: 'Browse North East' }).textContent).toBe('North East3 locations')
  fireEvent.click(sheet.getByRole('button', { name: 'Browse North East' }))
  expect(sheet.getAllByRole('button', { name: /^Select / }).map(button => button.textContent)).toEqual(['AcmeLocation', 'Birch HouseLocation', 'Cedar CourtLocation'])
  expect(sheetText()).not.toMatch(/question|propert|—/i)
})

test.each([
  // One location in two markets is asked from each market's search location: two assignments on one location.
  { subject: 'Location', targetKeys: ['acme'], marketKeys: ['new-york', 'remote'], contexts: [context, bostonContext], markets: 'New York, Remote searches', locations: ['Acme'], classifications: '1 location', asked: '2 combinations', each: 'New York · openai (gpt-5); Boston · openai (gpt-5), gemini (gemini-3)' },
  { subject: 'Market', targetKeys: ['acme', 'cedar'], marketKeys: ['new-york'], contexts: [context], markets: 'New York', locations: ['Acme', 'Cedar Court'], classifications: '2 locations', asked: 'New York · openai (gpt-5)', each: 'New York · openai (gpt-5)' },
])('calls a location a location in the review of a $subject add', async ({ subject, targetKeys, marketKeys, contexts, markets, locations, classifications, asked, each }) => {
  // As the server answers a review: `tracked` holds the added query, on every location its markets hold.
  const held = () => locationWorkspace({ markets: locationWorkspace().markets.map(market => marketKeys.includes(market.stableKey) ? { ...market, usageEdges: targetKeys.map(key => usageEdge(key)) } : market) })
  const added = {
    queryId: 'query-new-0', queryText: 'Acme reviews', normalizedText: 'acme reviews',
    provenance: { source: 'manual', sourceId: null, capturedAt: reviewedAt },
    state: 'awaiting-sweep', lastMeasuredAt: null,
    assignments: targetKeys.map(targetKey => ({ targetKey, groupKeys: ['north-east'], marketKeys, queryClass: 'branded', classificationSource: 'server', contexts })),
  }
  const base = preview(['Acme reviews'])
  const reviewed = { ...base, tracked: [...tracked, added], diff: { ...base.diff, added: [{ queryId: added.queryId, queryText: added.queryText, assignmentCount: targetKeys.length * contexts.length }] } }
  expect(queryTrackingPreviewResponseSchema.safeParse(reviewed).success).toBe(true)
  installApi({ workspace: held, respond: write => write.operation === 'preview' ? jsonResponse(reviewed) : undefined })
  renderTracked()
  const { sheet } = await openSheet()
  if (subject === 'Location') fillLocation(sheet, 'Acme', 'Acme reviews')
  else fill(sheet, 'Acme reviews')
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  const changes = sheet.getByRole('table', { name: 'Changes' })
  expect(within(changes).getAllByRole('columnheader').map(header => header.textContent)).toContain('Location links')
  const row = within(changes).getByText('Acme reviews').closest('tr')!
  // Type, the server's assignment count (two either way, on one location or on two), and where the query is asked.
  expect([...row.cells].map(cell => cell.textContent).slice(2)).toEqual(['Branded', '2', asked])
  expect(within(row).getByText(classifications, { selector: 'summary' })).toBeTruthy()
  expect([...row.querySelectorAll('li')].map(line => line.textContent)).toEqual(locations.map(location => `${location} · Branded · Groups: North East · Markets: ${markets} · ${each}`))
  expect(sheetText()).not.toMatch(/question|propert|—/i)
})

test('drops the chosen place when Subject changes, and keeps the lines', async () => {
  const writes = installApi({ workspace: locationWorkspace })
  renderTracked()
  const { sheet } = await openSheet()
  fill(sheet, 'best pizza in New York')
  // Choosing the current Subject again changes nothing.
  fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))
  expect(sheet.getByText('New York · Market')).toBeTruthy()
  expect(reviewButton(sheet).disabled).toBe(false)

  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  // Location is handled here: the sheet stays open and the market does not follow.
  expect(sheetIsOpen()).toBe(true)
  expect(sheet.queryByText('New York · Market')).toBeNull()
  expect(queriesField(sheet).value).toBe('best pizza in New York')
  expect(reviewButton(sheet).disabled).toBe(true)
  fireEvent.click(reviewButton(sheet))
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  expect(writes).toEqual([])
  // Coming straight back does not bring the market back either.
  fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))
  expect(sheet.getByText('Choose a market')).toBeTruthy()
  expect(reviewButton(sheet).disabled).toBe(true)

  // A list left open on one Subject is not the other Subject's list.
  fireEvent.click(sheet.getByText('Choose a market'))
  fireEvent.click(sheet.getByRole('button', { name: 'Browse North East' }))
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  expect(sheet.getByText('Choose a location').closest('details')!.open).toBe(false)
  chooseLocation(sheet, 'Acme')
  expect(reviewButton(sheet).disabled).toBe(false)
  fireEvent.click(sheet.getByRole('radio', { name: 'Market' }))
  expect(sheet.getByText('Choose a market')).toBeTruthy()
  expect(sheet.queryByText(/^Counts in:/)).toBeNull()
  expect(queriesField(sheet).value).toBe('best pizza in New York')
  expect(reviewButton(sheet).disabled).toBe(true)
})

test('keeps the Add query form one link away from Location, with no button of its own', async () => {
  installApi()
  renderTracked()
  const { sheet } = await openSheet()
  fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
  expect(sheet.queryByRole('button', { name: 'Open the Add query form' })).toBeNull()
  fireEvent.change(queriesField(sheet), { target: { value: 'best pizza in New York\nbest bagels in New York' } })
  expect(sheet.getByText(firstLineOnly)).toBeTruthy()
  fireEvent.click(sheet.getByRole('button', { name: handPickedLink }))
  await expectAddQueryForm('best pizza in New York')
})

test('shows Company as not available yet and never selects it', async () => {
  installApi()
  renderTracked()
  const { sheet } = await openSheet()
  const company = sheet.getByRole('radio', { name: 'Company' })
  expect(company.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(company.getAttribute('aria-describedby')!)!.textContent).toBe('Not available yet')
  expect(sheet.getByText('Company is not available yet.')).toBeTruthy()
  fireEvent.click(company)
  expect(company.getAttribute('aria-checked')).toBe('false')
  expect(sheet.getByRole('radio', { name: 'Market' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.getByLabelText('Queries')).toBeTruthy()
})

test('starts on the market the Tracked view is filtered to', async () => {
  const writes = installApi()
  renderTracked({ selection: { measurementScope: 'market', measurementScopeKey: 'remote', queryClass: 'all' } })
  // The filtered view lists only that market's queries, so wait for the opener instead of a row.
  fireEvent.click(await screen.findByRole('button', { name: 'Add queries' }))
  const sheet = within(screen.getByRole('dialog', { name: 'Add queries' }))
  expect(sheet.getByText('Remote searches · Market')).toBeTruthy()
  fireEvent.change(queriesField(sheet), { target: { value: 'best remote team tools' } })
  fireEvent.click(reviewButton(sheet))

  await reviewHeading(sheet)
  expect(writes[0]!.body.additions).toEqual([{ input: { source: 'manual', text: 'best remote team tools' }, audience: { marketKeys: ['remote'] } }])
})

test('starts on the location the Tracked view is filtered to', async () => {
  const writes = installApi({ workspace: locationWorkspace })
  renderTracked({ selection: { measurementScope: 'property', measurementScopeKey: 'acme', queryClass: 'all' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Add queries' }))
  const sheet = within(screen.getByRole('dialog', { name: 'Add queries' }))
  expect(sheet.getByRole('radio', { name: 'Location' }).getAttribute('aria-checked')).toBe('true')
  expect(sheet.getByText('Acme · Location')).toBeTruthy()
  expect(sheet.getByText('Counts in: New York, Remote searches')).toBeTruthy()
  // Tracked has the Add query form, so its link stays.
  expect(sheet.getByRole('button', { name: handPickedLink })).toBeTruthy()
  fireEvent.change(queriesField(sheet), { target: { value: 'Acme reviews' } })
  fireEvent.click(reviewButton(sheet))

  await sheet.findByRole('heading', { name: 'Review 1 change' })
  expect(writes[0]!.body.additions).toEqual([acmeAddition('Acme reviews')])
})

test('points to hand-picked locations when the project has no markets', async () => {
  installApi({ workspace: () => workspace({ markets: [], scopeOptions: workspace().scopeOptions.filter(option => option.kind !== 'market') }) })
  renderTracked()
  const { sheet } = await openSheet()
  expect(sheet.getByText('This project has no markets yet. Use hand-picked locations below.')).toBeTruthy()
  expect(sheet.queryByText('Choose a market')).toBeNull()
  fireEvent.change(queriesField(sheet), { target: { value: 'best pizza near me' } })
  expect(reviewButton(sheet).disabled).toBe(true)
  expect(sheet.getByRole('button', { name: handPickedLink })).toBeTruthy()
})

test('closes the open market picker on Escape before the sheet', async () => {
  installApi()
  renderTracked()
  const { sheet } = await openSheet()
  fireEvent.click(sheet.getByText('Choose a market'))
  const search = sheet.getByRole('searchbox', { name: 'Search scopes' })
  const picker = search.closest('details')!
  expect(picker.open).toBe(true)
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(picker.open).toBe(false)
  expect(sheetIsOpen()).toBe(true)

  fireEvent.keyDown(sheet.getByLabelText('Queries'), { key: 'Escape' })
  expect(sheetIsOpen()).toBe(false)
})

test('closes an open Edit form when it opens, and Cancel returns focus to the button', async () => {
  installApi()
  renderTracked()
  await screen.findByText('Acme pricing')
  fireEvent.click(screen.getByRole('button', { name: 'Edit Acme pricing' }))
  expect(await screen.findByRole('heading', { name: 'Edit query' })).toBeTruthy()
  const opener = screen.getByRole('button', { name: 'Add queries' })
  opener.focus()
  fireEvent.click(opener)
  expect(screen.queryByRole('heading', { name: 'Edit query', hidden: true })).toBeNull()

  fireEvent.click(within(screen.getByRole('dialog', { name: 'Add queries' })).getByRole('button', { name: 'Cancel' }))
  expect(sheetIsOpen()).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(opener))
})

test('stays closed after a publication retires the market the Tracked view is filtered to', async () => {
  let retired = false
  installApi({ workspace: () => retired ? workspace({ markets: [] }) : workspace() })
  const { queryClient, show } = renderTracked({ selection: { measurementScope: 'market', measurementScopeKey: 'remote', queryClass: 'all' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Add queries' }))
  expect(sheetIsOpen()).toBe(true)
  retired = true
  await act(() => queryClient.invalidateQueries())

  expect(await screen.findByText('This saved market filter is unavailable in the current measurement.')).toBeTruthy()
  expect(sheetIsOpen()).toBe(false)
  // Back on the whole site, the sheet does not come back by itself.
  show({})
  await screen.findByText('Acme pricing')
  expect(sheetIsOpen()).toBe(false)
})

test('keeps the Add query form and its label on a simple project', async () => {
  installApi({ workspace: () => workspace({ mode: 'simple', groups: [], markets: [], scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }] }) })
  renderTracked()
  await screen.findByText('Acme pricing')
  expect(screen.queryByRole('button', { name: 'Add queries' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add query' }))
  expect(await screen.findByRole('heading', { name: 'Add query' })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('keeps a viewer out of the sheet and an embed without the button', async () => {
  installApi()
  renderTracked({}, 'viewer')
  await screen.findByText('Acme pricing')
  const opener = screen.getByRole('button', { name: 'Add queries' }) as HTMLButtonElement
  expect(opener.disabled).toBe(true)
  fireEvent.click(opener)
  expect(screen.queryByRole('dialog')).toBeNull()

  cleanup()
  window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  renderTracked()
  await screen.findByText('Acme pricing')
  expect(screen.queryByRole('button', { name: /^Add quer/ })).toBeNull()
})
