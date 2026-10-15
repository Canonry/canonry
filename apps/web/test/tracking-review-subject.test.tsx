import React from 'react'
import { afterEach, describe, expect, it, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryTrackingPreviewResponseSchema } from '@ainyc/canonry-contracts'
import type { QueryTrackingPreviewResponse, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { expectedSubject, TrackingReview, TrackingReviewActions, type ExpectedSubject } from '../src/components/project/TrackingReview.js'
import { TrackingAddQueriesPage } from '../src/components/project/queries/AddQueriesEntry.js'
import { TrackedActionSheet } from '../src/components/project/queries/advanced/TrackedActionSheet.js'
import { TrackResearchSheet, type TrackResearchItem } from '../src/components/project/queries/research/TrackResearchSheet.js'
import { contextLabels } from '../src/components/project/queries/tracking-contexts.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { expectNoSentence, noteButton, reviewNumbers, reviewRow } from './support/query-tracking-fixtures.js'
import { contextChoices, rows as trackedRows, workspace as sheetWorkspace } from './support/tracked-action-fixtures.js'

// The review's check that each change lands on the Subject its caller asked for: the Locations column, the two
// checks above the table, the mismatch that keeps Publish off, the note on a row a one-location market words as
// the other Subject, and the three sheets that state a Subject.

afterEach(() => {
  cleanup()
  resetToasts()
})

const context = { providers: ['openai', 'gemini'], models: { openai: 'gpt-5', gemini: 'gemini-3' }, location: { label: 'Northbridge', city: 'Northbridge', region: 'NY', country: 'US' } }
const elsewhere = { ...context, location: { label: 'Lakeshore', city: 'Lakeshore', region: 'NY', country: 'US' } }
const edge = (targetKey: string) => ({ executionNodeKey: `node-${targetKey}`, targetKey, queryId: 'query-pool' })
const pairing = (targetKey: string, marketKeys: string[], queryClass: 'branded' | 'non-brand' = 'non-brand', contexts: unknown[] = [context]) => ({ targetKey, groupKeys: [], marketKeys, queryClass, classificationSource: 'server', contexts })
const tracked = (queryId: string, queryText: string, focus: unknown, assignments: ReturnType<typeof pairing>[]) => ({
  queryId, queryText, normalizedText: queryText.toLowerCase(), provenance: null, state: 'awaiting-sweep', lastMeasuredAt: null, assignments, focus,
})
type Tracked = ReturnType<typeof tracked>

const UPTOWN = ['court', 'lofts', 'square']
const uptownFocus = { kind: 'market', key: 'uptown' }
// Every location of the project: Uptown's three, Solo's one, one in no market, and 187 more.
const everywhere = [...UPTOWN, 'pier', 'terrace', ...Array.from({ length: 187 }, (_, index) => `home-${index}`)]
const pool = tracked('query-pool', 'apartments with a pool in uptown', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
/**
 * Uptown holds three locations. Solo holds Pier House alone, which sits in no other market, so the server
 * reads a query there as the market's or the location's by its type alone. Terrace is in no market.
 */
const workspace = {
  mode: 'advanced', workspaceVersion: `qtw_${'a'.repeat(64)}`, active: { revision: 4, compiledChecksum: 'c'.repeat(64) }, defaultContexts: [context],
  targets: [
    { stableKey: 'court', label: 'Acme Homes Court' },
    { stableKey: 'lofts', label: 'Acme Homes Lofts' },
    { stableKey: 'square', label: 'Acme Homes Square' },
    { stableKey: 'pier', label: 'Pier House' },
    { stableKey: 'terrace', label: 'Acme Homes Terrace' },
  ],
  groups: [],
  markets: [
    { stableKey: 'uptown', label: 'Uptown', usageEdges: UPTOWN.map(edge), targetKeys: UPTOWN },
    { stableKey: 'solo', label: 'Solo', usageEdges: [edge('pier')], targetKeys: ['pier'] },
  ],
  tracked: [pool],
  savedSources: { research: [], discovery: [] },
} as unknown as QueryTrackingWorkspaceResponse

type Landing = {
  row: Tracked
  change?: 'added' | 'reused' | 'removed'
  /** Where the query is asked now. */
  before?: string[]
  /** Where the server would ask it: every location of the post-change row unless said otherwise. */
  after?: string[]
  /** The server's link count: one per location and search location. */
  links?: number
}
const targetsOf = (row: Tracked) => row.assignments.map(assignment => assignment.targetKey)
const marketsOf = (row: Tracked) => [...new Set(row.assignments.flatMap(assignment => assignment.marketKeys))]

/** A review as the server answers one, with each query's placement before and after. Parsed, so it is one the server could send. */
function preview(landings: Landing[], overrides: Record<string, unknown> = {}) {
  const kind = (landing: Landing) => landing.change ?? 'added'
  const diffRow = (landing: Landing) => ({ queryId: landing.row.queryId, queryText: landing.row.queryText, assignmentCount: landing.links ?? landing.row.assignments.length })
  const listed = (change: string) => landings.filter(landing => kind(landing) === change)
  return queryTrackingPreviewResponseSchema.parse({
    mode: 'advanced', workspaceVersion: workspace.workspaceVersion, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-10-10T12:00:00.000Z', active: workspace.active,
    // Post-change: a removed query is gone, and every other one is as the server would track it.
    tracked: [pool, ...landings.filter(landing => kind(landing) !== 'removed').map(landing => landing.row)],
    diff: { added: listed('added').map(diffRow), reused: listed('reused').map(diffRow), removed: listed('removed').map(diffRow), unchanged: [diffRow({ row: pool })], noOp: false },
    changes: landings.map(landing => ({
      queryId: landing.row.queryId, queryText: landing.row.queryText, change: kind(landing),
      before: { targetKeys: landing.before ?? [], marketKeys: [] },
      after: { targetKeys: landing.after ?? (kind(landing) === 'removed' ? [] : targetsOf(landing.row)), marketKeys: kind(landing) === 'removed' ? [] : marketsOf(landing.row) },
    })),
    marketChanges: [],
    workload: { existingNodes: 3, existingProviderCalls: 6, nextSweepNodes: 6, nextSweepProviderCalls: 12, addedNodes: 3, addedProviderCalls: 6, removedNodes: 0, removedProviderCalls: 0 },
    ...overrides,
  }) as QueryTrackingPreviewResponse
}

const market = (queryText: string, key = 'uptown'): ExpectedSubject => expectedSubject(queryText, { kind: 'market', key }, workspace)
const location = (queryText: string, key: string): ExpectedSubject => expectedSubject(queryText, { kind: 'location', key }, workspace)

// A market query as it should land: on Uptown's three locations.
const gym = tracked('query-gym', 'apartments with a gym in uptown', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
// The same request gone wrong: the query on every location of the project, in no market.
const everyLocation = tracked('query-parking', 'apartments with parking in uptown', { kind: 'custom' }, everywhere.map(key => pairing(key, [])))

type ReviewProps = Partial<React.ComponentProps<typeof TrackingReview>>

/** The review as a sheet draws it: the changes in one place and the actions in another. */
function renderReview(props: ReviewProps, role?: 'viewer') {
  const all = { workspace, contextLabels, error: null, isCommitting: false, sweepActive: false, nextSweepDate: 'Oct 21', onPublish: vi.fn(), onReviewAgain: vi.fn(), onBack: vi.fn(), preview: null, ...props }
  const tree = <><section aria-label="Review"><TrackingReview {...all} showActions={false} /></section><footer aria-label="Actions"><TrackingReviewActions {...all} /></footer></>
  render(role ? <AccountProvider account={{ name: role, role }}>{tree}</AccountProvider> : tree)
  return all
}

const reviewRegion = () => screen.getByRole('region', { name: 'Review' })
const actions = () => screen.getByRole('contentinfo', { name: 'Actions' })
// Not the "Publish blocked" note, whose name starts the same way.
const PUBLISH = /^Publish (\d+ )?changes?$/
const publish = () => screen.getByRole('button', { name: PUBLISH }) as HTMLButtonElement
const headers = (table = 'Changes') => within(screen.getByRole('table', { name: table })).getAllByRole('columnheader').map(header => header.textContent)
const listedQueries = () => [...screen.getByRole('table', { name: 'Changes' }).querySelectorAll('tbody tr')].map(row => (row as HTMLTableRowElement).cells[1]!.querySelector('span')!.textContent)
/** One cell of a row of changes, by its column header. */
const cell = (queryText: string, header: string) => reviewRow(queryText).row.cells[headers().indexOf(header)]!
/** A note as a reader sees it: its icon, by lucide's class for it, and its tone. */
function look(note: Element) {
  const icon = [...note.querySelector('svg')!.classList].find(name => name.startsWith('lucide-'))!.slice('lucide-'.length)
  return `${icon} ${['positive', 'negative', 'caution'].find(tone => note.classList.contains(`text-${tone}`)) ?? 'neutral'}`
}
const SUBJECT_MISSES = /^[\d,]+ Subject mismatch(es)?$/
const LOCATION_MISSES = /^[\d,]+ location mismatch(es)?$/
/**
 * A check above the table. One that holds is its name with a tick, and is a state with no sentence to open.
 * One that does not is the count of queries that miss it with a cross, which is what this returns.
 */
function check(name: string, missed: RegExp) {
  const held = within(reviewRegion()).queryByText(name)
  if (held) {
    expect(held.closest('button')).not.toBeNull()
    expect(look(held)).toBe('check positive')
    return 'met'
  }
  const miss = within(reviewRegion()).queryByText(missed)
  if (!miss) return null
  expect(look(miss)).toBe('x negative')
  return miss.textContent
}
const checks = () => ({ subjects: check('Subject as chosen', SUBJECT_MISSES), locations: check('Locations as chosen', LOCATION_MISSES) })
/** The sentence behind a check that does not hold. */
const subjectMisses = (label: string, queries: string) => noteButton(label, `${queries} would get a different Subject than the one you chose.`, reviewRegion())
const locationMisses = (label: string, queries: string) => noteButton(label, `${queries} would be asked for other locations than your Subject holds.`, reviewRegion())
/** "Publish blocked" in the actions: a status, with the count and the way out behind it. */
function blockedNote(queries: string, back = true) {
  const note = noteButton('Publish blocked', `${queries} would not be tracked for the Subject you chose.${back ? ' Go back to update the change.' : ''}`, actions())
  expect(look(note)).toBe('ban negative')
  expect(within(actions()).getAllByRole('status').some(status => status.contains(note))).toBe(true)
  return note
}
/** A row's own note, in its Query cell on the line of its location list. */
const rowNote = (queryText: string, label: string, detail: string) => noteButton(label, detail, cell(queryText, 'Query'))

test('checks a market add: its three locations, both checks met and Publish on', () => {
  // Each of Uptown's three locations is asked from two search locations, so the server counts six links for three locations.
  const twice = { ...gym, assignments: UPTOWN.map(key => pairing(key, ['uptown'], 'non-brand', [context, elsewhere])) }
  // The Subject was stated for the text as typed. The server lists it trimmed and in its own case.
  const { onPublish } = renderReview({ preview: preview([{ row: twice, links: 6 }]), expectedSubjects: [market('  Apartments with a  gym in Uptown ')] })
  expect(screen.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy()
  expect(headers()).toEqual(['Change', 'Query', 'Subject and type', 'Locations', 'Pairs'])
  expect(cell(gym.queryText, 'Locations').textContent).toBe('0 → 3')
  expect(reviewRow(gym.queryText)).toMatchObject({ change: 'Added', subject: 'Market · Uptown (3)', type: 'Non-brand', assignments: '6' })
  expect(checks()).toEqual({ subjects: 'met', locations: 'met' })
  // Both sit above the table, beside the count of changes.
  const table = screen.getByRole('table', { name: 'Changes' })
  for (const label of ['1 added', 'Subject as chosen', 'Locations as chosen']) expect(screen.getByText(label).compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // The row says nothing more: its cell is the query and its location list.
  expect(cell(gym.queryText, 'Query').textContent).toBe(`${gym.queryText}3 locations`)
  expect(screen.queryByText('Publish blocked')).toBeNull()
  expect(within(actions()).getByText('First answers Oct 21')).toBeTruthy()
  expectNoSentence(reviewRegion())
  expectNoSentence(actions())
  // A row's location list spans all five columns.
  fireEvent.click(within(reviewRow(gym.queryText).row).getByRole('button', { name: '3 locations' }))
  expect((reviewRow(gym.queryText).row.nextElementSibling as HTMLTableRowElement).cells[0]!.colSpan).toBe(5)

  expect(publish().disabled).toBe(false)
  fireEvent.click(publish())
  expect(onPublish).toHaveBeenCalledTimes(1)
})

test('keeps Publish off when a market query would be asked for all 192 locations, hand-picked', () => {
  const { onPublish } = renderReview({
    // The server lists the query that lands well first.
    preview: preview([{ row: gym }, { row: everyLocation }]),
    expectedSubjects: [market(gym.queryText), market(everyLocation.queryText)],
  })
  // The heading takes focus when the review opens, so a screen reader hears the block with it.
  expect(screen.getByRole('heading', { name: 'Review 2 changes, publish blocked' })).toBeTruthy()
  // Each check is now the count of queries that miss it, with what that means behind it.
  expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: '1 location mismatch' })
  subjectMisses('1 Subject mismatch', '1 query')
  locationMisses('1 location mismatch', '1 query')
  expect(screen.queryByText('Subject as chosen')).toBeNull()
  expect(screen.queryByText('Locations as chosen')).toBeNull()

  // The row that misses its Subject leads the table and is marked.
  expect(listedQueries()).toEqual([everyLocation.queryText, gym.queryText])
  const missed = reviewRow(everyLocation.queryText).row
  expect(missed.classList.contains('bg-negative-soft')).toBe(true)
  expect(reviewRow(gym.queryText).row.classList.contains('bg-negative-soft')).toBe(false)
  expect(cell(everyLocation.queryText, 'Locations').textContent).toBe('0 → 192')
  // What was chosen, and what the server would do, are behind the row's note. It sits with the query, after its location list.
  expect(cell(everyLocation.queryText, 'Query').textContent).toBe(`${everyLocation.queryText}192 locationsSubject mismatch`)
  expect(look(rowNote(everyLocation.queryText, 'Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Hand-picked · 192 locations.'))).toBe('x negative')
  // The Subject the server names keeps its Type under it, and its count stays on the line of its noun.
  expect(reviewRow(everyLocation.queryText)).toMatchObject({ subject: 'Hand-picked · 192 locations', type: 'Non-brand' })
  expect(within(cell(everyLocation.queryText, 'Subject and type')).getByText('192 locations').className).toBe('whitespace-nowrap')
  expect(within(reviewRow(gym.queryText).row).queryByText('Subject mismatch')).toBeNull()

  blockedNote('1 query')
  // Nothing is published, so no first answers are promised.
  expect(screen.queryByText(/^First answers/)).toBeNull()
  expect(publish().textContent).toBe('Publish 2 changes')
  expect(publish().disabled).toBe(true)
  fireEvent.click(publish())
  expect(onPublish).not.toHaveBeenCalled()
  expect(within(actions()).getByRole('button', { name: 'Back' })).toHaveProperty('disabled', false)
  expectNoSentence(reviewRegion())
  expectNoSentence(actions())
})

test('counts every query that misses, and names no way back where the caller has none', () => {
  const twice = tracked('query-rooftop', 'apartments with a rooftop in uptown', { kind: 'custom' }, everywhere.map(key => pairing(key, [])))
  renderReview({ preview: preview([{ row: gym }, { row: everyLocation }, { row: twice }]), expectedSubjects: [market(gym.queryText), market(everyLocation.queryText), market(twice.queryText)], onBack: undefined })
  expect(checks()).toEqual({ subjects: '2 Subject mismatches', locations: '2 location mismatches' })
  subjectMisses('2 Subject mismatches', '2 queries')
  locationMisses('2 location mismatches', '2 queries')
  blockedNote('2 queries', false)
  expect(within(actions()).queryByRole('button', { name: 'Back' })).toBeNull()
  expect(within(screen.getByRole('table', { name: 'Changes' })).getAllByText('Subject mismatch')).toHaveLength(2)
})

test('keeps both pauses when a sweep runs over a blocked publish', () => {
  renderReview({ preview: preview([{ row: everyLocation }]), expectedSubjects: [market(everyLocation.queryText)], sweepActive: true })
  expect(within(actions()).getAllByRole('status').map(status => status.textContent)).toEqual(['Publish blocked', 'Sweep running'])
  blockedNote('1 query')
  expect(publish().disabled).toBe(true)
})

describe('a market of one location', () => {
  const asMarket = tracked('query-pier', 'apartments near the pier', { kind: 'market', key: 'solo' }, [pairing('pier', ['solo'])])
  const asLocation = tracked('query-pier', 'apartments near the pier', { kind: 'property', key: 'pier' }, [pairing('pier', ['solo'], 'branded')])

  it.each([
    { name: 'a location add the server reads as its one-location market', row: asMarket, expected: location(asMarket.queryText, 'pier'), chosen: 'Location · Pier House', subject: 'Market · Solo (1)' },
    { name: 'a market add the server reads as its one location', row: asLocation, expected: market(asLocation.queryText, 'solo'), chosen: 'Market · Solo (1)', subject: 'Location · Pier House' },
  ])('blocks $name even when the server reports no type mismatch', ({ row, expected, chosen, subject }) => {
    const { onPublish } = renderReview({ preview: preview([{ row }], { typeMismatches: [] }), expectedSubjects: [expected] })
    expect(reviewRow(row.queryText).subject).toBe(subject)
    expect(cell(row.queryText, 'Locations').textContent).toBe('0 → 1')
    expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: 'met' })
    rowNote(row.queryText, 'Subject mismatch', `You chose ${chosen}. After you publish, its Subject would be ${subject}.`)
    expect(reviewRow(row.queryText).row.classList.contains('bg-negative-soft')).toBe(true)
    expect(screen.queryByText('Type sets Subject')).toBeNull()
    expect(publish().disabled).toBe(true)
    fireEvent.click(publish())
    expect(onPublish).not.toHaveBeenCalled()
  })

  it('does not pass a query hand-picked for that one location', () => {
    // Asked for Solo, and the server would ask it for Pier House outside the market: the right location, and no market query.
    const loose = tracked('query-pier', 'apartments near the pier', { kind: 'custom' }, [pairing('pier', [])])
    renderReview({ preview: preview([{ row: loose }]), expectedSubjects: [market(loose.queryText, 'solo')] })
    expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: 'met' })
    rowNote(loose.queryText, 'Subject mismatch', 'You chose Market · Solo (1). After you publish, its Subject would be Hand-picked · 1 location.')
    expect(screen.queryByText('Type sets Subject')).toBeNull()
    expect(publish().disabled).toBe(true)
  })

  it('does not pass the other Subject where the market holds more than one location', () => {
    // Asked for Acme Homes Court alone, and the server would track it for all of Uptown.
    const spread = tracked('query-court', 'acme homes court reviews', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
    // Asked for all of Uptown, and the server would track it for Acme Homes Court alone.
    const narrowed = tracked('query-quiet', 'quiet apartments in uptown', { kind: 'property', key: 'court' }, [pairing('court', ['uptown'], 'branded')])
    renderReview({ preview: preview([{ row: spread }, { row: narrowed }]), expectedSubjects: [location(spread.queryText, 'court'), market(narrowed.queryText)] })
    rowNote(spread.queryText, 'Subject mismatch', 'You chose Location · Acme Homes Court. After you publish, its Subject would be Market · Uptown (3).')
    rowNote(narrowed.queryText, 'Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Location · Acme Homes Court.')
    expect(checks()).toEqual({ subjects: '2 Subject mismatches', locations: '2 location mismatches' })
    expect(publish().disabled).toBe(true)
    blockedNote('2 queries')
  })

  it('does not take a location\'s Subject for a market of several, even with the market\'s own locations listed', () => {
    // The server's two answers disagree here: Uptown's three locations, and a location's Subject. The chosen Subject must match even if the location list agrees.
    const odd = tracked('query-view', 'apartments with a view in uptown', { kind: 'property', key: 'court' }, [pairing('court', ['uptown'], 'branded')])
    renderReview({ preview: preview([{ row: odd, after: UPTOWN }]), expectedSubjects: [market(odd.queryText)] })
    expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: 'met' })
    rowNote(odd.queryText, 'Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Location · Acme Homes Court.')
    expect(publish().disabled).toBe(true)
  })
})

test('catches a market query asked for a location the market did not hold', () => {
  // The server still calls it Uptown's query, with a fourth location the market gains by it.
  const grown = tracked('query-garden', 'apartments with a garden in uptown', uptownFocus, [...UPTOWN, 'terrace'].map(key => pairing(key, ['uptown'])))
  renderReview({
    preview: preview([{ row: grown }], { marketChanges: [{ marketKey: 'uptown', before: { targetKeys: UPTOWN }, after: { targetKeys: ['court', 'lofts', 'square', 'terrace'] }, removedTargetKeys: [], emptied: false }] }),
    expectedSubjects: [market(grown.queryText)],
  })
  expect(checks()).toEqual({ subjects: 'met', locations: '1 location mismatch' })
  locationMisses('1 location mismatch', '1 query')
  expect(cell(grown.queryText, 'Locations').textContent).toBe('0 → 4')
  // The Subject is the one chosen, so the row says its locations differ, and how.
  expect(reviewRow(grown.queryText).subject).toBe('Market · Uptown (4)')
  expect(look(rowNote(grown.queryText, 'Locations differ', 'You chose Market · Uptown (3). After you publish, this query would be asked for 4 locations.'))).toBe('x negative')
  expect(screen.queryByText('Subject mismatch')).toBeNull()
  expect(reviewRow(grown.queryText).row.classList.contains('bg-negative-soft')).toBe(true)
  expect(publish().disabled).toBe(true)
  blockedNote('1 query')
})

test('catches a market query asked for fewer locations than the market held, and words each Subject as of its own time', () => {
  // Uptown loses Acme Homes Square in this publish, and the query would be asked for the two it keeps: one short of the three chosen.
  const kept = tracked('query-garden', 'apartments with a garden in uptown', uptownFocus, ['court', 'lofts'].map(key => pairing(key, ['uptown'])))
  const shrunk = { marketChanges: [{ marketKey: 'uptown', before: { targetKeys: UPTOWN }, after: { targetKeys: ['court', 'lofts'] }, removedTargetKeys: ['square'], emptied: false }] }
  renderReview({ preview: preview([{ row: kept, change: 'reused', before: ['terrace'] }], shrunk), expectedSubjects: [market(kept.queryText)] })
  expect(checks()).toEqual({ subjects: 'met', locations: '1 location mismatch' })
  expect(reviewRow(kept.queryText).subject).toBe('Market · Uptown (2)')
  rowNote(kept.queryText, 'Locations differ', 'You chose Market · Uptown (3). After you publish, this query would be asked for 2 locations.')
  expect(publish().disabled).toBe(true)
  cleanup()

  // The Subject chosen has the locations it held when it was chosen. The one the server would give has those it holds after the publish.
  const narrowed = tracked('query-garden', 'apartments with a garden in uptown', { kind: 'property', key: 'court' }, [pairing('court', ['uptown'], 'branded')])
  renderReview({ preview: preview([{ row: narrowed, change: 'reused', before: ['terrace'] }], shrunk), expectedSubjects: [market(narrowed.queryText)] })
  rowNote(narrowed.queryText, 'Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Location · Acme Homes Court.')
  cleanup()
  renderReview({ preview: preview([{ row: kept, change: 'reused', before: ['terrace'] }], shrunk), expectedSubjects: [location(kept.queryText, 'court')] })
  rowNote(kept.queryText, 'Subject mismatch', 'You chose Location · Acme Homes Court. After you publish, its Subject would be Market · Uptown (2).')
})

test('asks for no market confirmation while a mismatch blocks the publish', () => {
  const shrunk = { marketChanges: [{ marketKey: 'solo', before: { targetKeys: ['pier'] }, after: { targetKeys: [] }, removedTargetKeys: ['pier'], emptied: true }] }
  renderReview({ preview: preview([{ row: everyLocation }], shrunk), expectedSubjects: [market(everyLocation.queryText)] })
  // The market table stays. There is nothing to confirm until the mismatch is gone.
  expect(screen.getByRole('table', { name: 'Market changes' })).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(publish().disabled).toBe(true)
  blockedNote('1 query')
})

test('says None for a query the server would no longer ask anywhere', () => {
  // The server lists the query as changed, and the row it would leave is asked for no location.
  const idle = tracked('query-idle', 'apartments with a gym in uptown', { kind: 'not-asked' }, [])
  renderReview({ preview: preview([{ row: idle, change: 'reused', before: UPTOWN, links: 0 }]), expectedSubjects: [market(idle.queryText)] })
  expect(cell(idle.queryText, 'Locations').textContent).toBe('3 → 0')
  // With no location to list, the note is all that sits under the query.
  expect(cell(idle.queryText, 'Query').textContent).toBe(`${idle.queryText}Subject mismatch`)
  rowNote(idle.queryText, 'Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be None.')
  expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: '1 location mismatch' })
  expect(publish().disabled).toBe(true)
})

test('counts a query the server lists no change for against the publish', () => {
  renderReview({ preview: preview([{ row: gym }]), expectedSubjects: [market(gym.queryText), market('apartments with a view in uptown')] })
  // No row can carry the note, so the check and the block say it.
  expect(checks()).toEqual({ subjects: '1 Subject mismatch', locations: 'met' })
  subjectMisses('1 Subject mismatch', '1 query')
  expect(screen.queryByText('Subject mismatch')).toBeNull()
  expect(publish().disabled).toBe(true)
  blockedNote('1 query')
})

test('reads each row\'s locations from the server\'s two lists, for a reused and a removed query too', async () => {
  // The workspace holds the lake query on three locations. The server says it is asked for four now.
  const lake = tracked('query-lake', 'apartments near the lake', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
  // Its post-change row lists one location. The server's own list for it holds two.
  const narrowed = { ...lake, focus: { kind: 'property', key: 'court' }, assignments: [pairing('court', ['uptown'], 'branded')] }
  const gone = tracked('query-gone', 'apartments near the station', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
  renderReview({
    workspace: { ...workspace, tracked: [pool, lake, gone] } as unknown as QueryTrackingWorkspaceResponse,
    preview: preview([
      { row: gym },
      { row: narrowed, change: 'reused', before: ['court', 'lofts', 'square', 'terrace'], after: ['court', 'terrace'], links: 1 },
      { row: gone, change: 'removed', before: UPTOWN, links: 3 },
    ]),
    expectedSubjects: [market(gym.queryText)],
  })
  expect(cell(gym.queryText, 'Locations').textContent).toBe('0 → 3')
  expect(cell(lake.queryText, 'Locations').textContent).toBe('4 → 2')
  expect(within(reviewRow(lake.queryText).row).getByRole('button', { name: '1 location' })).toBeTruthy()
  expect(cell(gone.queryText, 'Locations').textContent).toBe('3 → 0')
  expect(reviewRow(gone.queryText).assignments).toBe('−3')
  // Only the query a Subject was stated for is checked. The other two changes pass no verdict.
  expect(checks()).toEqual({ subjects: 'met', locations: 'met' })
  expect(publish().disabled).toBe(false)
  // The unchanged queries have no placement to compare, so their table keeps its columns.
  fireEvent.click(screen.getByText('1 unchanged query'))
  await screen.findByRole('table', { name: 'Unchanged queries' })
  expect(headers('Unchanged queries')).toEqual(['Change', 'Query', 'Subject', 'Type', 'Pairs'])
})

test('puts a query\'s location links under its locations, with their unit, beside a search location column', () => {
  // Rows asked from different search locations keep the column, and a sixth one would pass the width of a sheet.
  const garden = tracked('query-garden', 'apartments with a garden in uptown', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'], 'non-brand', [context, elsewhere])))
  const court = tracked('query-court', 'acme homes court reviews', { kind: 'property', key: 'court' }, [pairing('court', ['uptown'], 'branded')])
  const gone = tracked('query-gone', 'apartments near the station', uptownFocus, UPTOWN.map(key => pairing(key, ['uptown'])))
  renderReview({
    workspace: { ...workspace, tracked: [pool, gone] } as unknown as QueryTrackingWorkspaceResponse,
    preview: preview([{ row: gym }, { row: garden, links: 6 }, { row: court }, { row: gone, change: 'removed', before: UPTOWN, links: 3 }]),
    expectedSubjects: [market(gym.queryText), market(garden.queryText), location(court.queryText, 'court')],
  })
  // The column keeps its name. The second line says what it counts.
  expect(headers()).toEqual(['Change', 'Query', 'Subject and type', 'Locations', 'Search location and engines'])
  const lines = (queryText: string) => [...cell(queryText, 'Locations').children].map(line => line.textContent)
  expect(lines(gym.queryText)).toEqual(['0 → 3', '3 pairs'])
  expect(lines(garden.queryText)).toEqual(['0 → 3', '6 pairs'])
  expect(lines(court.queryText)).toEqual(['0 → 1', '1 pair'])
  expect(lines(gone.queryText)).toEqual(['3 → 0', '−3 pairs'])
  // A row's location list spans all five columns.
  fireEvent.click(within(reviewRow(garden.queryText).row).getByRole('button', { name: '3 locations' }))
  expect((reviewRow(garden.queryText).row.nextElementSibling as HTMLTableRowElement).cells[0]!.colSpan).toBe(5)
  expect(checks()).toEqual({ subjects: 'met', locations: 'met' })
})

test('reviews each class with only its own engines and markets for a location asked both ways', () => {
  const branded = { ...context, providers: ['openai'], models: { openai: 'gpt-5' } }
  const nonBrand = { ...elsewhere, providers: ['gemini'], models: { gemini: 'gemini-3' } }
  const assignment = {
    ...pairing('court', ['uptown', 'solo'], 'branded', [branded, nonBrand]),
    classifiedContexts: [
      { ...nonBrand, queryClass: 'non-brand', marketKeys: ['solo'] },
      { ...branded, queryClass: 'branded', marketKeys: ['uptown'] },
    ],
  }
  const mixed = { ...tracked('query-mixed', 'acme homes court comparison', { kind: 'custom' }, [assignment]), queryClasses: ['branded', 'non-brand'] }
  renderReview({ preview: preview([{ row: mixed, links: 2 }]) })
  fireEvent.click(within(reviewRow(mixed.queryText).row).getByRole('button', { name: '1 location' }))
  const disclosure = reviewRow(mixed.queryText).row.nextElementSibling as HTMLElement
  expect(within(disclosure).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'Acme Homes Court · Branded · Markets: Uptown · Northbridge · OpenAI',
    'Acme Homes Court · Non-brand · Markets: Solo · Lakeshore · Gemini',
  ])
})

// Neither pair is the limit less the count, so a number worked out here would show.
const limits = { queries: { current: 932, next: 936, max: 1_000, left: { current: 61, next: 57 } } }
const numberGrid = () => screen.getByText('Queries asked', { selector: 'dt' }).closest('dl')!

describe('with nothing to check', () => {
  const landings = [{ row: gym }, { row: everyLocation }]
  const stated = [market(gym.queryText), market(everyLocation.queryText)]

  // Each review is from a server that sends its room under the limit, as the old Add form's is today.
  it.each([
    { name: 'no Subject was stated, as from the old Add form', props: { preview: preview(landings, { limits }) } },
    { name: 'an empty list of Subjects', props: { preview: preview(landings, { limits }), expectedSubjects: [] } },
    { name: 'a server that sends no changes', props: { preview: preview(landings, { limits, changes: undefined }), expectedSubjects: stated } },
  ])('keeps placement checks absent and leaves Publish on for $name', ({ props }) => {
    const { onPublish } = renderReview(props)
    expect(screen.getByRole('heading', { name: 'Review 2 changes' })).toBeTruthy()
    expect(headers()).toEqual(['Change', 'Query', 'Subject', 'Type', 'Pairs'])
    // The server's order, with the row that would have missed its Subject where the server put it.
    expect(listedQueries()).toEqual([gym.queryText, everyLocation.queryText])
    expect(reviewRow(everyLocation.queryText).row.className).toBe('')
    expect(cell(everyLocation.queryText, 'Query').textContent).toBe(`${everyLocation.queryText}192 locations`)
    expect(checks()).toEqual({ subjects: null, locations: null })
    expect(screen.queryByText('Subject mismatch')).toBeNull()
    expect(screen.queryByText('Publish blocked')).toBeNull()
    // Room under the limit is useful even when this caller stated no Subject.
    expect(reviewNumbers()).toEqual({ 'Queries asked': '932 → 936', 'Left under limit': '61 → 57', 'Answers per sweep': '6 → 12', 'Answers added': '+6', 'Answers removed': '0' })
    expect(numberGrid().classList.contains('sm:grid-cols-3')).toBe(true)
    fireEvent.click(publish())
    expect(onPublish).toHaveBeenCalledTimes(1)
  })

  it('draws no check for a review that changes nothing', () => {
    renderReview({
      preview: preview([], { limits, diff: { added: [], removed: [], reused: [{ queryId: gym.queryId, queryText: gym.queryText, assignmentCount: 3 }], unchanged: [], noOp: true }, tracked: [pool, gym] }),
      expectedSubjects: [market(gym.queryText)],
    })
    expect(screen.getByRole('heading', { name: 'No tracking changes' })).toBeTruthy()
    expect(headers()).toEqual(['Change', 'Query', 'Subject', 'Type', 'Pairs'])
    expect(checks()).toEqual({ subjects: null, locations: null })
    expect(Object.keys(reviewNumbers())).toEqual(['Queries asked', 'Left under limit', 'Answers per sweep', 'Answers added', 'Answers removed'])
    // Off because nothing changes, not because of a mismatch.
    expect(publish().disabled).toBe(true)
    expect(screen.queryByText('Publish blocked')).toBeNull()
  })
})

test('prints the server\'s room under the query limit beside the check, and none from a server that sends none', () => {
  renderReview({ preview: preview([{ row: gym }], { limits }), expectedSubjects: [market(gym.queryText)] })
  expect(reviewNumbers()).toEqual({ 'Queries asked': '932 → 936', 'Left under limit': '61 → 57', 'Answers per sweep': '6 → 12', 'Answers added': '+6', 'Answers removed': '0' })
  // The query counts lead, then the answers, three to a row. On a phone the widest has a row to itself, which keeps the two answer changes a pair.
  expect(within(numberGrid()).getAllByRole('term').map(term => term.textContent)).toEqual(['Queries asked', 'Left under limit', 'Answers per sweep', 'Answers added', 'Answers removed'])
  expect(numberGrid().classList.contains('sm:grid-cols-3')).toBe(true)
  expect([...numberGrid().children].map(number => number.className)).toEqual(['', '', 'max-sm:col-span-2', '', ''])
  cleanup()

  renderReview({ preview: preview([{ row: gym }], { limits: { queries: { current: 932, next: 936, max: 1_000 } } }), expectedSubjects: [market(gym.queryText)] })
  expect(reviewNumbers()).toEqual({ 'Queries asked': '932 → 936', 'Answers per sweep': '6 → 12', 'Answers added': '+6', 'Answers removed': '0' })
  expect(numberGrid().className).toBe('mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4')
  expect(checks()).toEqual({ subjects: 'met', locations: 'met' })
})

test('shows a viewer the checks, with nothing to confirm or publish', () => {
  // Every query lands where it was asked to, and the same publish empties another market: a writer has a tick to give.
  const emptied = { marketChanges: [{ marketKey: 'solo', before: { targetKeys: ['pier'] }, after: { targetKeys: [] }, removedTargetKeys: ['pier'], emptied: true }] }
  const props = { preview: preview([{ row: gym }], emptied), expectedSubjects: [market(gym.queryText)] }
  renderReview(props)
  expect(screen.getByRole('checkbox', { name: 'Confirm market changes' })).toBeTruthy()
  cleanup()

  renderReview(props, 'viewer')
  expect(checks()).toEqual({ subjects: 'met', locations: 'met' })
  expect(cell(gym.queryText, 'Locations').textContent).toBe('0 → 3')
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(publish().disabled).toBe(true)
  expect(publish().title).toMatch(/^View only/)
  expect(screen.queryByText('Publish blocked')).toBeNull()
})

test('reads the locations a stated Subject holds from the workspace', () => {
  expect(market('best apartments')).toEqual({ kind: 'market', key: 'uptown', queryText: 'best apartments', locationKeys: UPTOWN })
  expect(location('pier house reviews', 'pier')).toEqual({ kind: 'location', key: 'pier', queryText: 'pier house reviews', locationKeys: ['pier'] })
  // An older server sends a market's edges and no member list: its distinct locations are the list.
  const older = { ...workspace, markets: [{ stableKey: 'uptown', label: 'Uptown', usageEdges: [edge('court'), edge('court'), edge('lofts')] }] } as unknown as QueryTrackingWorkspaceResponse
  expect(expectedSubject('best apartments', { kind: 'market', key: 'uptown' }, older).locationKeys).toEqual(['court', 'lofts'])
  // A market the workspace no longer holds has no location, so no placement can match it.
  expect(expectedSubject('best apartments', { kind: 'market', key: 'gone' }, workspace).locationKeys).toEqual([])
})

// --- the three sheets that state a Subject. The shared fixture: Uptown holds Harbor Point, River Point and Summit Lofts;
// Downtown holds Harbor Point; Solo holds Pier House alone; Lone Pine is in no market.

type Body = { additions: Array<{ input: { text?: string }; audience?: { targetKeys?: string[]; marketKeys?: string[] }; contexts?: unknown[] }>; removals: Array<{ queryId: string }> }
type Answer = { text: string; queryId?: string; focus?: unknown; after: string[]; before?: string[]; removed?: boolean }
const sheetContext = sheetWorkspace.defaultContexts[0]!

/** Answers a sheet's review with where the server would put each query, and records what the sheet sent. `marketChanges` are the markets the same publish changes. */
function installReview(answer: (body: Body) => Answer[], marketChanges: unknown[] = []) {
  const bodies: Body[] = []
  onTestFinished(mockFetch((url, init) => {
    if (!new URL(url).pathname.endsWith('/query-tracking/preview')) throw new Error(`Unexpected fetch: ${url}`)
    const body = JSON.parse(String(init?.body)) as Body
    bodies.push(body)
    const answers = answer(body).map((row, index) => ({ ...row, queryId: row.queryId ?? `new-${index}` }))
    const kind = (item: Answer) => item.removed ? 'removed' : item.before ? 'reused' : 'added'
    const row = (item: typeof answers[number]) => ({ queryId: item.queryId, queryText: item.text, assignmentCount: item.removed ? item.before!.length : item.after.length })
    return jsonResponse(queryTrackingPreviewResponseSchema.parse({
      mode: 'advanced', workspaceVersion: sheetWorkspace.workspaceVersion, previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-10-10T12:00:00.000Z', active: sheetWorkspace.active,
      tracked: [
        ...sheetWorkspace.tracked.filter(existing => !answers.some(item => item.queryId === existing.queryId)),
        ...answers.filter(item => !item.removed).map(item => ({ queryId: item.queryId, queryText: item.text, normalizedText: item.text.toLowerCase(), provenance: null, state: 'awaiting-sweep', lastMeasuredAt: null, focus: item.focus, assignments: item.after.map(targetKey => ({ targetKey, groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'server', contexts: [sheetContext] })) })),
      ],
      diff: { added: answers.filter(item => kind(item) === 'added').map(row), reused: answers.filter(item => kind(item) === 'reused').map(row), removed: answers.filter(item => kind(item) === 'removed').map(row), unchanged: [], noOp: false },
      changes: answers.map(item => ({ queryId: item.queryId, queryText: item.text, change: kind(item), before: { targetKeys: item.before ?? [], marketKeys: [] }, after: { targetKeys: item.after, marketKeys: [] } })),
      marketChanges,
      workload: { existingNodes: 9, existingProviderCalls: 9, nextSweepNodes: 10, nextSweepProviderCalls: 10, addedNodes: 1, addedProviderCalls: 1, removedNodes: 0, removedProviderCalls: 0 },
      limits: { queries: { current: 10, next: 11, max: 1_000, left: { current: 990, next: 989 } } },
    }))
  }))
  return bodies
}

function renderSheet(sheet: React.ReactElement, role: 'dialog' | 'region' = 'dialog') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(<QueryClientProvider client={queryClient}>{sheet}</QueryClientProvider>)
  return within(screen.getByRole(role, role === 'region' ? { name: 'Add queries' } : undefined))
}
type Sheet = ReturnType<typeof renderSheet>

/** Presses Review and reads what the review then shows of the check. */
async function reviewed(sheet: Sheet) {
  fireEvent.click(sheet.getByRole('button', { name: 'Review' }))
  const heading = await sheet.findByRole('heading', { name: /^Review \d+ changes?(, publish blocked)?$/ })
  const state = (name: string, missed: RegExp) => sheet.queryByText(name) ? 'met' : sheet.queryByText(missed)?.textContent ?? null
  const publishButton = sheet.getByRole<HTMLButtonElement>('button', { name: PUBLISH })
  // The sheet's own footer makes the review's buttons a finger's size on a phone.
  expect(publishButton.parentElement!.classList.contains('max-md:[&>button]:h-11')).toBe(true)
  return {
    subjects: state('Subject as chosen', SUBJECT_MISSES),
    locations: state('Locations as chosen', LOCATION_MISSES),
    mismatches: sheet.queryAllByText('Subject mismatch').length,
    byType: sheet.queryAllByText('Type sets Subject').length,
    blocked: sheet.queryByText('Publish blocked') !== null && heading.textContent!.endsWith(', publish blocked'),
    publishOff: publishButton.disabled,
    leftUnderLimit: sheet.queryByText('Left under limit')?.nextElementSibling?.textContent ?? null,
    columns: within(sheet.getByRole('table', { name: 'Changes' })).getAllByRole('columnheader').map(header => header.textContent),
  }
}
const landed = { subjects: 'met', locations: 'met', mismatches: 0, byType: 0, blocked: false, publishOff: false, leftUnderLimit: '990 → 989' }
const missedOnce = { subjects: '1 Subject mismatch', locations: '1 location mismatch', mismatches: 1, blocked: true, publishOff: true }
const pick = (sheet: Sheet, trigger: string, option: string) => {
  fireEvent.click(sheet.getByText(trigger).closest('summary')!)
  fireEvent.click(sheet.getByRole('button', { name: `Select ${option}` }))
}
const sheetRow = (sheet: Sheet, queryText: string) => sheet.getByText(queryText).closest('tr')!
const UPTOWN_SHEET = ['harbor', 'river', 'summit']
const sheetProps = { projectName: 'demo', workspace: sheetWorkspace, sweepActive: false, onClose: () => {} }

describe('the Add queries page', () => {
  const lines = ['apartments with a gym uptown', 'quiet apartments uptown']

  it('states the chosen market for every line, and blocks the publish when one would land elsewhere', async () => {
    let handPick = false
    const bodies = installReview(body => body.additions.map((addition, index) => handPick && index === 1
      ? { text: addition.input.text!, focus: { kind: 'custom' }, after: [...UPTOWN_SHEET, 'pier', 'lone'] }
      : { text: addition.input.text!, focus: { kind: 'market', key: 'uptown' }, after: UPTOWN_SHEET }))
    const sheet = renderSheet(<TrackingAddQueriesPage {...sheetProps} defaultMarketKey="uptown" defaultText={lines.join('\n')} />, 'region')
    expect(await reviewed(sheet)).toEqual({ ...landed, columns: ['Change', 'Query', 'Subject and type', 'Locations', 'Pairs'] })
    // The request is the one the sheet always sent: the check reads the answer and adds nothing to it.
    expect(bodies[0]!.additions).toEqual(lines.map(text => ({ input: { source: 'manual', text }, audience: { marketKeys: ['uptown'] } })))

    handPick = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject(missedOnce)
    noteButton('Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Hand-picked · 5 locations.', sheetRow(sheet, lines[1]!))
  })

  it('blocks a location query that becomes a market query, whether that market has one or several locations', async () => {
    let spread = false
    installReview(body => body.additions.map(addition => spread
      ? { text: addition.input.text!, focus: { kind: 'market', key: 'uptown' }, after: UPTOWN_SHEET }
      : { text: addition.input.text!, focus: { kind: 'market', key: 'solo' }, after: ['pier'] }))
    const sheet = renderSheet(<TrackingAddQueriesPage {...sheetProps} defaultLocationKey="pier" defaultText="apartments by the water" />, 'region')
    expect(await reviewed(sheet)).toMatchObject({ ...missedOnce, locations: 'met', byType: 0 })
    // The table names the Subject the server gives it, and the mismatch blocks the chosen location's publish.
    expect(sheetRow(sheet, 'apartments by the water').cells[2]!.textContent).toBe('Market · Solo (1)Non-brand')
    noteButton('Subject mismatch', 'You chose Location · Pier House. After you publish, its Subject would be Market · Solo (1).', sheetRow(sheet, 'apartments by the water'))

    spread = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject(missedOnce)
    noteButton('Subject mismatch', 'You chose Location · Pier House. After you publish, its Subject would be Market · Uptown (3).', sheetRow(sheet, 'apartments by the water'))
  })

  it('states the location itself where it sits in no market', async () => {
    let spread = false
    const bodies = installReview(body => body.additions.map(addition => spread
      ? { text: addition.input.text!, focus: { kind: 'custom' }, after: ['lone', 'pier'] }
      : { text: addition.input.text!, focus: { kind: 'property', key: 'lone' }, after: ['lone'] }))
    const sheet = renderSheet(<TrackingAddQueriesPage {...sheetProps} defaultLocationKey="lone" defaultText="Lone Pine reviews" />, 'region')
    expect(await reviewed(sheet)).toMatchObject(landed)
    // With no market to take them from, the request names the location and the project's one search location and engines.
    expect(bodies[0]!.additions).toEqual([{ input: { source: 'manual', text: 'Lone Pine reviews' }, audience: { targetKeys: ['lone'] }, contexts: [expect.anything()], queryClass: 'branded' }])

    spread = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject(missedOnce)
    noteButton('Subject mismatch', 'You chose Location · Lone Pine. After you publish, its Subject would be Hand-picked · 2 locations.', sheetRow(sheet, 'Lone Pine reviews'))
  })
})

describe('the Tracked action sheet', () => {
  it('states the market a Subject change names', async () => {
    let stays = false
    installReview(() => [stays
      ? { text: trackedRows.handPicked.queryText, queryId: 'q-picked', focus: { kind: 'custom' }, before: ['harbor', 'pier'], after: [...UPTOWN_SHEET, 'pier'] }
      : { text: trackedRows.handPicked.queryText, queryId: 'q-picked', focus: { kind: 'market', key: 'uptown' }, before: ['harbor', 'pier'], after: UPTOWN_SHEET }])
    const sheet = renderSheet(<TrackedActionSheet {...sheetProps} action="change-subject" rows={[trackedRows.handPicked]} contextChoices={contextChoices} />)
    pick(sheet, 'Choose a market', 'Uptown')
    expect(await reviewed(sheet)).toMatchObject(landed)
    expect(within(sheetRow(sheet, trackedRows.handPicked.queryText)).getByText('2 → 3')).toBeTruthy()

    stays = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject(missedOnce)
  })

  it('blocks a Subject change that stays a market query after the market shrinks to one location', async () => {
    // Uptown's query becomes River Point's. Were it Uptown's only one, the market would keep River Point alone,
    // and there the server reads a Non-brand query as the market's: the Subject stays Market.
    installReview(
      () => [{ text: trackedRows.market.queryText, queryId: 'q-uptown', focus: { kind: 'market', key: 'uptown' }, before: UPTOWN_SHEET, after: ['river'] }],
      [{ marketKey: 'uptown', before: { targetKeys: UPTOWN_SHEET }, after: { targetKeys: ['river'] }, removedTargetKeys: ['harbor', 'summit'], emptied: false }],
    )
    const sheet = renderSheet(<TrackedActionSheet {...sheetProps} action="change-subject" rows={[trackedRows.market]} contextChoices={contextChoices} />)
    fireEvent.click(sheet.getByRole('radio', { name: 'Location' }))
    pick(sheet, 'Choose a location', 'River Point')
    // The form gave no warning: Uptown held three locations when the Subject was chosen.
    expect(sheet.queryByText('Type sets Subject')).toBeNull()
    // The chosen location is preserved; a market membership confirmation cannot bypass a Subject mismatch.
    expect(await reviewed(sheet)).toMatchObject({ ...missedOnce, locations: 'met', byType: 0 })
    const row = sheetRow(sheet, trackedRows.market.queryText)
    expect(within(row).getByText('3 → 1')).toBeTruthy()
    expect(row.cells[2]!.textContent).toBe('Market · Uptown (1)Non-brand')
    noteButton('Subject mismatch', 'You chose Location · River Point. After you publish, its Subject would be Market · Uptown (1).', row)
    expect(sheet.queryByRole('checkbox', { name: 'Confirm market changes' })).toBeNull()
    expect(sheet.getByRole<HTMLButtonElement>('button', { name: PUBLISH }).disabled).toBe(true)
  })

  it('states the location a move names', async () => {
    installReview(() => [{ text: trackedRows.location.queryText, queryId: 'q-harbor', focus: { kind: 'property', key: 'river' }, before: ['harbor'], after: ['river'] }])
    const sheet = renderSheet(<TrackedActionSheet {...sheetProps} action="move-location" rows={[trackedRows.location]} contextChoices={contextChoices} />)
    pick(sheet, 'Harbor Point · Location', 'River Point')
    expect(await reviewed(sheet)).toMatchObject(landed)
    expect(within(sheetRow(sheet, trackedRows.location.queryText)).getByText('1 → 1')).toBeTruthy()
    cleanup()

    // The server would leave it on Harbor Point.
    installReview(() => [{ text: trackedRows.location.queryText, queryId: 'q-harbor', focus: { kind: 'property', key: 'harbor' }, before: ['harbor'], after: ['harbor'] }])
    const stuck = renderSheet(<TrackedActionSheet {...sheetProps} action="move-location" rows={[trackedRows.location]} contextChoices={contextChoices} />)
    pick(stuck, 'Harbor Point · Location', 'River Point')
    expect(await reviewed(stuck)).toMatchObject(missedOnce)
    noteButton('Subject mismatch', 'You chose Location · River Point. After you publish, its Subject would be Location · Harbor Point.', sheetRow(stuck, trackedRows.location.queryText))
    cleanup()

    // Moved to Pier House, Solo's one location, the server reads it as Solo's query.
    installReview(() => [{ text: trackedRows.location.queryText, queryId: 'q-harbor', focus: { kind: 'market', key: 'solo' }, before: ['harbor'], after: ['pier'] }])
    const solo = renderSheet(<TrackedActionSheet {...sheetProps} action="move-location" rows={[trackedRows.location]} contextChoices={contextChoices} />)
    pick(solo, 'Harbor Point · Location', 'Pier House')
    expect(await reviewed(solo)).toMatchObject({ ...missedOnce, locations: 'met', byType: 0 })
    noteButton('Subject mismatch', 'You chose Location · Pier House. After you publish, its Subject would be Market · Solo (1).', sheetRow(solo, trackedRows.location.queryText))
  })

  it('states no Subject for an action that names no place, so its review is as before', async () => {
    // A market's own query is stopped. The server sends its placement and its room under the limit all the same, and nothing is checked against the market it leaves.
    installReview(() => [{ text: trackedRows.market.queryText, queryId: 'q-uptown', removed: true, before: UPTOWN_SHEET, after: [] }])
    const sheet = renderSheet(<TrackedActionSheet {...sheetProps} action="stop" rows={[trackedRows.market]} contextChoices={contextChoices} />)
    // The shared fixture's rows carry no Subject, so a removed row shows none.
    expect(await reviewed(sheet)).toEqual({ subjects: null, locations: null, mismatches: 0, byType: 0, blocked: false, publishOff: false, leftUnderLimit: '990 → 989', columns: ['Change', 'Query', 'Type', 'Pairs'] })
  })
})

describe('the Research track sheet', () => {
  const research = (id: string, text: string, subject?: TrackResearchItem['subject']): TrackResearchItem => ({ text, input: { source: 'research', researchRunQueryId: id }, ...(subject ? { subject } : {}) })

  it('states each row\'s own Subject', async () => {
    const items = [
      research('rq-1', 'apartments with a dog park in Uptown', { kind: 'market', key: 'uptown' }),
      research('rq-2', 'Is River Point pet friendly?', { kind: 'location', key: 'river' }),
    ]
    let swapped = false
    // The server reads each saved query's text itself. Swapped, it would give each row the other one's place.
    installReview(() => {
      const uptown = { focus: { kind: 'market', key: 'uptown' }, after: UPTOWN_SHEET }
      const river = { focus: { kind: 'property', key: 'river' }, after: ['river'] }
      return [{ text: items[0]!.text, ...(swapped ? river : uptown) }, { text: items[1]!.text, ...(swapped ? uptown : river) }]
    })
    const sheet = renderSheet(<TrackResearchSheet {...sheetProps} contextChoices={contextChoices} items={items} />)
    expect(await reviewed(sheet)).toMatchObject(landed)

    swapped = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject({ subjects: '2 Subject mismatches', locations: '2 location mismatches', mismatches: 2, blocked: true, publishOff: true })
    noteButton('Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Location · River Point.', sheetRow(sheet, items[0]!.text))
    noteButton('Subject mismatch', 'You chose Location · River Point. After you publish, its Subject would be Market · Uptown (3).', sheetRow(sheet, items[1]!.text))
  })

  it('states the Subject picked in the sheet for the rows that carry none', async () => {
    // Saved with no Subject of their own: both take the market picked in the sheet.
    const items = [research('rq-1', 'apartments with a dog park'), research('rq-2', 'apartments with a rooftop')]
    let handPick = false
    const bodies = installReview(() => [
      { text: items[0]!.text, focus: { kind: 'market', key: 'uptown' }, after: UPTOWN_SHEET },
      handPick ? { text: items[1]!.text, focus: { kind: 'custom' }, after: [...UPTOWN_SHEET, 'pier'] } : { text: items[1]!.text, focus: { kind: 'market', key: 'uptown' }, after: UPTOWN_SHEET },
    ])
    const sheet = renderSheet(<TrackResearchSheet {...sheetProps} contextChoices={contextChoices} items={items} />)
    pick(sheet, 'Choose a market', 'Uptown')
    expect(await reviewed(sheet)).toMatchObject(landed)
    expect(bodies[0]!.additions.map(addition => addition.audience)).toEqual([{ marketKeys: ['uptown'] }, { marketKeys: ['uptown'] }])

    handPick = true
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(await reviewed(sheet)).toMatchObject(missedOnce)
    noteButton('Subject mismatch', 'You chose Market · Uptown (3). After you publish, its Subject would be Hand-picked · 4 locations.', sheetRow(sheet, items[1]!.text))
    expect(within(sheetRow(sheet, items[0]!.text)).queryByText('Subject mismatch')).toBeNull()
  })
})

test.each([undefined, []])('blocks a server-reported query limit without a chosen Subject (%j)', expectedSubjects => {
  const over = { queries: { current: 999, next: 1002, max: 1000, left: { current: 1, next: 0 }, exceeded: true, over: { current: 0, next: 2 } } }
  const { onPublish } = renderReview({ preview: preview([{ row: gym }], { limits: over }), expectedSubjects })
  expect(screen.getByRole('heading', { name: 'Review 1 change, publish blocked' })).toBeTruthy()
  expect(reviewNumbers()).toMatchObject({ 'Queries asked': '999 → 1,002', 'Left under limit': '1 → 0' })
  expect(checks()).toEqual({ subjects: null, locations: null })
  noteButton('Over limit by 2', 'This change would track 1,002 queries. The limit is 1,000. Over limit by 2. Add fewer queries, or stop some first.', reviewRegion())
  expect(publish().disabled).toBe(true)
  fireEvent.click(publish())
  expect(onPublish).not.toHaveBeenCalled()
})

test('blocks a server-reported type mismatch without expected Subjects and explains the affected wording', () => {
  const { onPublish } = renderReview({ preview: preview([{ row: gym }], { typeMismatches: [{ queryId: gym.queryId, queryText: gym.queryText, focus: uptownFocus, expectedQueryClass: 'non-brand', queryClasses: ['non-brand'], brandedWording: true }] }) })
  expect(checks()).toEqual({ subjects: null, locations: null })
  expect(screen.getByRole('heading', { name: 'Review 1 change, publish blocked' })).toBeTruthy()
  noteButton('1 type mismatch', '1 query would get a type their Subject does not take.', reviewRegion())
  rowNote(gym.queryText, 'Type mismatch', 'This wording names the company or a location, so it cannot count as Non-brand.')
  expect(reviewRow(gym.queryText).row.classList.contains('bg-negative-soft')).toBe(true)
  expect(publish().disabled).toBe(true)
  fireEvent.click(publish())
  expect(onPublish).not.toHaveBeenCalled()
})

test('a clean server type check explains the rule and permits publishing', () => {
  renderReview({ preview: preview([{ row: gym }], { typeMismatches: [] }) })
  noteButton('Type follows Subject', 'A market query is Non-brand and a location query is Branded. A hand-picked query takes either.', reviewRegion())
  expect(publish().disabled).toBe(false)
})
