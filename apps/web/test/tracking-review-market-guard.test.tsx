import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingPreviewResponse, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { TrackingReview, TrackingReviewActions } from '../src/components/project/TrackingReview.js'
import { contextLabels } from '../src/components/project/queries/tracking-contexts.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { expectNoSentence, noteButton, reviewRow, sharedSearchLocation } from './support/query-tracking-fixtures.js'

// The review mounted on its own: the market guard, the Subject column, the type of a query with none set, and the next sweep date.

afterEach(cleanup)

const context = { providers: ['openai', 'gemini'], models: { openai: 'gpt-5', gemini: 'gemini-3' }, location: { label: 'Northbridge', city: 'Northbridge', region: 'NY', country: 'US' } }
const edge = (targetKey: string) => ({ executionNodeKey: `node-${targetKey}`, targetKey, queryId: 'query-pool' })
const pairing = (targetKey: string, marketKeys: string[], queryClass: 'branded' | 'non-brand' | null = 'non-brand') => ({ targetKey, groupKeys: [], marketKeys, queryClass, classificationSource: 'server', contexts: [context] })
const tracked = (queryId: string, queryText: string, focus: unknown, assignments: unknown[]) => ({
  queryId, queryText, normalizedText: queryText, provenance: null, state: 'awaiting-sweep', lastMeasuredAt: null, assignments, ...(focus ? { focus } : {}),
})

// Uptown holds three locations now. Harbor Point holds one, and Midtown one.
const pool = tracked('query-pool', 'apartments with a pool in uptown', { kind: 'market', key: 'uptown' }, ['court', 'lofts', 'square'].map(key => pairing(key, ['uptown'])))
const harbor = tracked('query-harbor', 'apartments near the harbor', { kind: 'market', key: 'harbor' }, [pairing('court', ['harbor'])])
const workspace = {
  mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, active: { revision: 4, compiledChecksum: 'c'.repeat(64) }, defaultContexts: [context],
  targets: [
    { stableKey: 'court', label: 'Acme Homes Court' },
    { stableKey: 'lofts', label: 'Acme Homes Lofts' },
    { stableKey: 'square', label: 'Acme Homes Square' },
    { stableKey: 'terrace', label: 'Acme Homes Terrace' },
  ],
  groups: [],
  markets: [
    { stableKey: 'uptown', label: 'Uptown', usageEdges: ['court', 'lofts', 'square'].map(edge), targetKeys: ['court', 'lofts', 'square'] },
    { stableKey: 'harbor', label: 'Harbor Point', usageEdges: [edge('court')], targetKeys: ['court'] },
    { stableKey: 'midtown', label: 'Midtown', usageEdges: [edge('lofts')], targetKeys: ['lofts'] },
  ],
  tracked: [pool, harbor],
  savedSources: { research: [], discovery: [] },
} as unknown as QueryTrackingWorkspaceResponse

// Uptown loses two locations and gains one, so "3 → 2" and "Loses 2" cannot be had from each other. Midtown only gains.
const marketChanges = [
  { marketKey: 'harbor', before: { targetKeys: ['court'] }, after: { targetKeys: [] }, removedTargetKeys: ['court'], emptied: true },
  { marketKey: 'midtown', before: { targetKeys: ['lofts'] }, after: { targetKeys: ['lofts', 'square'] }, removedTargetKeys: [], emptied: false },
  { marketKey: 'uptown', before: { targetKeys: ['court', 'lofts', 'square'] }, after: { targetKeys: ['square', 'terrace'] }, removedTargetKeys: ['court', 'lofts'], emptied: false },
]
const gym = tracked('query-gym', 'apartments with a gym in uptown', { kind: 'market', key: 'uptown' }, ['square', 'terrace'].map(key => pairing(key, ['uptown'])))
const row = (query: { queryId: string; queryText: string }, assignmentCount: number) => ({ queryId: query.queryId, queryText: query.queryText, assignmentCount })

function preview(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'advanced', workspaceVersion: workspace.workspaceVersion, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-10-10T12:00:00.000Z', active: workspace.active,
    // Post-change: the pool and harbor queries are gone and the gym query is in.
    tracked: [gym],
    diff: { added: [row(gym, 2)], removed: [row(pool, 3), row(harbor, 1)], reused: [], unchanged: [], noOp: false },
    marketChanges,
    workload: { existingNodes: 4, existingProviderCalls: 8, nextSweepNodes: 2, nextSweepProviderCalls: 4, addedNodes: 2, addedProviderCalls: 4, removedNodes: 4, removedProviderCalls: 8 },
    ...overrides,
  } as unknown as QueryTrackingPreviewResponse
}

type ReviewProps = Partial<React.ComponentProps<typeof TrackingReview>>

/** The review as a sheet draws it: the changes in one place and the actions in another. */
function reviewTree(props: ReviewProps, role?: 'viewer') {
  const all = { workspace, contextLabels, preview: preview(), error: null, isCommitting: false, sweepActive: false, onPublish: vi.fn(), onReviewAgain: vi.fn(), ...props }
  const tree = <><section aria-label="Review"><TrackingReview {...all} showActions={false} /></section><footer><TrackingReviewActions {...all} /></footer></>
  return { all, tree: role ? <AccountProvider account={{ name: role, role }}>{tree}</AccountProvider> : tree }
}

function renderReview(props: ReviewProps = {}, role?: 'viewer') {
  const { all, tree } = reviewTree(props, role)
  const view = render(tree)
  return { ...all, show: (next: ReviewProps) => view.rerender(reviewTree({ ...all, ...next }, role).tree) }
}

const publish = () => screen.getByRole('button', { name: /^Publish/ }) as HTMLButtonElement
const confirmBox = () => screen.getByRole('checkbox', { name: 'Confirm market changes' }) as HTMLInputElement
const marketRows = () => [...screen.getByRole('table', { name: 'Market changes' }).querySelectorAll('tbody tr')].map(line => [...(line as HTMLTableRowElement).cells].map(cell => cell.textContent))

test('lists each market that loses locations and keeps Publish off until the change is confirmed', () => {
  const { onPublish } = renderReview()
  // The server's order, without the market that only gains. Every number is the length of a list it sent.
  expect(marketRows()).toEqual([
    ['Harbor Point', '1 → 0', 'Market emptied'],
    ['Uptown', '3 → 2', 'Loses 2 locations'],
  ])
  const table = screen.getByRole('table', { name: 'Market changes' })
  expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Market', 'Locations', 'Change'])
  // The locations that leave are named behind each note, with the sentence.
  expect(noteButton('Market emptied', 'Leaves this market: Acme Homes Court. A market with no locations takes no new queries.', table).classList.contains('text-negative')).toBe(true)
  expect(noteButton('Loses 2 locations', 'Leaves this market: Acme Homes Court, Acme Homes Lofts. No query is asked there for them after you publish.', table).classList.contains('text-caution')).toBe(true)
  // The table sits above the list of changes.
  expect(table.compareDocumentPosition(screen.getByRole('table', { name: 'Changes' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expectNoSentence(screen.getByRole('region', { name: 'Review' }))

  expect(confirmBox().checked).toBe(false)
  expect(publish().disabled).toBe(true)
  fireEvent.click(publish())
  expect(onPublish).not.toHaveBeenCalled()

  fireEvent.click(confirmBox())
  expect(publish().disabled).toBe(false)
  fireEvent.click(publish())
  expect(onPublish).toHaveBeenCalledTimes(1)
  // Unticking turns Publish off again.
  fireEvent.click(confirmBox())
  expect(publish().disabled).toBe(true)
})

test('clears the confirmation when another review arrives', () => {
  const { show } = renderReview()
  fireEvent.click(confirmBox())
  expect(publish().disabled).toBe(false)

  // The same change reviewed again is another review, with its own token.
  show({ preview: preview({ previewToken: `qtp_${'d'.repeat(64)}` }) })
  expect(confirmBox().checked).toBe(false)
  expect(publish().disabled).toBe(true)
  fireEvent.click(confirmBox())
  expect(publish().disabled).toBe(false)

  // A refusal takes the review away; the next one starts unticked too.
  show({ preview: null, error: { title: 'Could not confirm tracking changes', detail: 'Workspace changed. Review again.' } })
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Review again' })).toBeTruthy()
  show({ preview: preview({ previewToken: `qtp_${'e'.repeat(64)}` }), error: null })
  expect(confirmBox().checked).toBe(false)
  expect(publish().disabled).toBe(true)
})

test.each([
  { name: 'no market changes', changes: [] },
  { name: 'a market that only gains a location', changes: [marketChanges[1]!] },
  { name: 'a server that sends no market changes', changes: undefined },
])('shows no guard for $name, and Publish works as before', ({ changes }) => {
  const { onPublish } = renderReview({ preview: preview({ marketChanges: changes }) })
  expect(screen.queryByRole('table', { name: 'Market changes' })).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(publish().textContent).toBe('Publish 3 changes')
  expect(publish().disabled).toBe(false)
  fireEvent.click(publish())
  expect(onPublish).toHaveBeenCalledTimes(1)
})

test('keeps the other reasons Publish is off: a sweep, a publish in flight, and a view-only account', () => {
  const { show } = renderReview({ sweepActive: true })
  fireEvent.click(confirmBox())
  // Confirmed, and still off while a sweep runs.
  expect(publish().disabled).toBe(true)
  noteButton('Sweep running', 'A sweep is queued or running. Publish after it finishes.', screen.getByRole('status'))

  show({ sweepActive: false, isCommitting: true })
  expect(screen.getByRole('button', { name: 'Publishing…' })).toHaveProperty('disabled', true)
  // The tick cannot change under a publish that is already on its way.
  expect(confirmBox().disabled).toBe(true)
  expect(confirmBox().checked).toBe(true)
  cleanup()

  // A viewer cannot publish, so there is nothing to confirm: the table shows and no control is live.
  renderReview({}, 'viewer')
  expect(marketRows()).toHaveLength(2)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(publish().disabled).toBe(true)
})

test('names each change\'s Subject after the publish, and a removed query\'s Subject now', () => {
  const lofts = tracked('query-lofts', 'acme homes lofts reviews', { kind: 'property', key: 'lofts' }, [pairing('lofts', ['midtown'], 'branded')])
  const picked = tracked('query-picked', 'apartments with parking', { kind: 'custom' }, [pairing('court', []), pairing('terrace', [])])
  const idle = tracked('query-idle', 'short term rentals', { kind: 'not-asked' }, [])
  renderReview({
    preview: preview({
      tracked: [gym, lofts, picked, idle],
      diff: { added: [row(gym, 2), row(lofts, 1)], reused: [row(picked, 2)], removed: [row(pool, 3)], unchanged: [row(idle, 0)], noOp: false },
    }),
  })
  expect(within(screen.getByRole('table', { name: 'Changes' })).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Change', 'Query', 'Subject', 'Type', 'Location links'])
  // Uptown holds two locations once this is published, and three now: the added row counts the first, the removed row the second.
  expect(reviewRow(gym.queryText)).toMatchObject({ change: 'Added', subject: 'Market · Uptown (2)', type: 'Non-brand', assignments: '2' })
  expect(reviewRow(pool.queryText)).toMatchObject({ change: 'Removed', subject: 'Market · Uptown (3)', type: '', assignments: '−3' })
  expect(reviewRow(lofts.queryText)).toMatchObject({ change: 'Added', subject: 'Location · Acme Homes Lofts', type: 'Branded' })
  expect(reviewRow(picked.queryText)).toMatchObject({ change: 'Reused', subject: 'Hand-picked · 2 locations' })
  expect(reviewRow(idle.queryText, 'Unchanged queries')).toMatchObject({ change: 'Unchanged', subject: 'None', type: '' })
  // A market's count stays on the line of the name's last word.
  expect(within(reviewRow(gym.queryText).row).getByText('Uptown (2)').classList.contains('whitespace-nowrap')).toBe(true)
  // Every changed row that is asked is asked the same way, so that is one line above the table.
  expect(sharedSearchLocation()).toEqual({ label: 'Northbridge · OpenAI, Gemini', models: 'Northbridge · openai (gpt-5), gemini (gemini-3)' })
  expect(screen.getByRole('region', { name: 'Review' }).textContent).not.toMatch(/propert|custom|not-asked/i)
})

test('shows no Subject column for a server that sends no Subject', () => {
  const bare = (query: typeof gym) => ({ ...query, focus: undefined })
  const data = { ...workspace, tracked: [bare(pool), bare(harbor)] } as unknown as QueryTrackingWorkspaceResponse
  renderReview({ workspace: data, preview: preview({ tracked: [bare(gym)] }) })
  expect(within(screen.getByRole('table', { name: 'Changes' })).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Change', 'Query', 'Type', 'Location links'])
  expect(reviewRow(gym.queryText).subject).toBeUndefined()
})

test('reads a query with no type as Not set, and tells two models of one engine apart', () => {
  const mini = { ...context, providers: ['openai'], models: { openai: 'gpt-5-mini' } }
  const full = { ...context, providers: ['openai'], models: { openai: 'gpt-5' } }
  const untyped = tracked('query-untyped', 'apartments near the park', { kind: 'custom' }, [{ ...pairing('court', [], null), contexts: [full, mini] }])
  renderReview({ preview: preview({ tracked: [untyped], diff: { added: [row(untyped, 2)], removed: [], reused: [], unchanged: [], noOp: false }, marketChanges: [] }) })
  const added = reviewRow(untyped.queryText)
  expect(added.type).toBe('Not set')
  // By display name both would read "Northbridge · OpenAI", so each keeps its model id.
  expect(sharedSearchLocation()!.label).toBe('Northbridge · openai (gpt-5); Northbridge · openai (gpt-5-mini)')
  fireEvent.click(within(added.row).getByRole('button', { name: '1 location' }))
  expect(added.row.nextElementSibling!.textContent).toBe('Acme Homes Court · Not set · Northbridge · openai (gpt-5); Northbridge · openai (gpt-5-mini)')
  expect(screen.getByRole('region', { name: 'Review' }).textContent).not.toMatch(/unknown/i)
})

test.each([
  { name: 'a publish that asks something new', props: { nextSweepDate: 'Oct 21' }, shown: true },
  { name: 'no next sweep date', props: { nextSweepDate: null }, shown: false },
  { name: 'a running sweep', props: { nextSweepDate: 'Oct 21', sweepActive: true }, shown: false },
  // The server's count of answers added: a removal has no first answers to wait for.
  { name: 'a publish that adds no answers', props: { nextSweepDate: 'Oct 21', preview: preview({ workload: { ...preview().workload, addedProviderCalls: 0 } }) }, shown: false },
  { name: 'a review that changes nothing', props: { nextSweepDate: 'Oct 21', preview: preview({ diff: { added: [], removed: [], reused: [], unchanged: [row(gym, 2)], noOp: true }, marketChanges: [] }) }, shown: false },
])('names the next sweep beside Publish for $name: $shown', ({ props, shown }) => {
  renderReview(props)
  const note = screen.queryByText('First answers Oct 21')
  expect(note !== null).toBe(shown)
  // Beside Publish, in the actions, and plain text: it has no sentence to open.
  if (note) {
    expect(publish().parentElement!.contains(note)).toBe(true)
    expect(note.closest('button')).toBeNull()
  }
  expect(screen.queryByText(/^First answers/) !== null).toBe(shown)
})
