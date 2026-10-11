import React, { useEffect } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { TrackResearchBar, TrackResearchSheet, useTrackSelection, type TrackResearchItem } from '../src/components/project/queries/research/TrackResearchSheet.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { contextChoices, workspace, workspaceVersion } from './support/tracked-action-fixtures.js'

// The Track sheet of the Research page, and the bar that opens it. The fixture's places: Uptown holds Harbor Point,
// River Point and Summit Lofts; Downtown holds Harbor Point; Solo holds Pier House; Lone Pine is in no market.

afterEach(() => {
  cleanup()
  resetToasts()
})

const previewToken = `qtp_${'b'.repeat(64)}`
const reviewedAt = '2026-09-04T12:15:00.000Z'
/** The version the review answers with. Not the one the sheet sent, so a publish shows which of the two it carries. */
const reviewedVersion = `qtw_${'f'.repeat(64)}`
const active = { revision: 4, compiledChecksum: 'c'.repeat(64) }
const committed = { committed: true, mode: 'advanced', workspaceVersion: `qtw_${'d'.repeat(64)}`, reviewedAt, active: { ...active, revision: 5 } }
const refusal = () => jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' } }, 409)

type Body = { expectedWorkspaceVersion: string; additions: Array<Record<string, unknown>>; removals: unknown[] }
type Write = { operation: 'preview' | 'commit'; body: Body }

/** A review as the server answers one: every addition is a new query, and each asks one more answer. */
function preview(body: Body) {
  const added = body.additions.map((_addition, index) => ({ queryId: `new-${index}`, queryText: `Saved query ${index + 1}`, assignmentCount: 1 }))
  return {
    mode: 'advanced', workspaceVersion: reviewedVersion, previewToken, reviewedAt, active, tracked: workspace.tracked,
    diff: { added, removed: [], reused: [], unchanged: [], noOp: false },
    workload: { existingNodes: 9, existingProviderCalls: 9, nextSweepNodes: 9 + added.length, nextSweepProviderCalls: 9 + added.length, addedNodes: added.length, addedProviderCalls: added.length, removedNodes: 0, removedProviderCalls: 0 },
  }
}

/** Records every review and publish the sheet sends. Any other request fails the test: nothing here runs research or reaches an engine. */
function installApi(respond?: (write: Write) => Response | undefined) {
  const writes: Write[] = []
  onTestFinished(mockFetch((url, init) => {
    const operation = new URL(url).pathname.replace('/api/v1/projects/demo/query-tracking/', '')
    if (operation !== 'preview' && operation !== 'commit') throw new Error(`Unexpected fetch: ${url}`)
    const write: Write = { operation, body: JSON.parse(String(init?.body)) as Body }
    writes.push(write)
    return respond?.(write) ?? jsonResponse(operation === 'preview' ? preview(write.body) : committed)
  }))
  return writes
}

const research = (id: string, text: string, subject?: TrackResearchItem['subject']): TrackResearchItem => ({ text, input: { source: 'research', researchRunQueryId: id }, ...(subject ? { subject } : {}) })
const idea = (id: string, text: string): TrackResearchItem => ({ text, input: { source: 'discovery', discoveryProbeId: id } })
const uptown = { kind: 'market', key: 'uptown' } as const
const downtown = { kind: 'market', key: 'downtown' } as const
const harbor = { kind: 'location', key: 'harbor' } as const
const lone = { kind: 'location', key: 'lone' } as const

type SheetProps = React.ComponentProps<typeof TrackResearchSheet>

function renderSheet(props: Pick<SheetProps, 'items'> & Partial<SheetProps>, role?: 'viewer') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const all = { projectName: 'demo', workspace, contextChoices, sweepActive: false, onClose: vi.fn(), onPublished: vi.fn(), onRemove: vi.fn(), ...props }
  const sheet = <QueryClientProvider client={queryClient}><TrackResearchSheet {...all} /></QueryClientProvider>
  render(role ? <AccountProvider account={{ name: role, role }}>{sheet}</AccountProvider> : sheet)
  // A viewer gets no sheet, so there is no dialog to look in.
  return { ...all, sheet: within(screen.queryByRole('dialog') ?? document.body) }
}

type Sheet = ReturnType<typeof renderSheet>['sheet']
const reviewButton = (sheet: Sheet) => sheet.getByRole<HTMLButtonElement>('button', { name: 'Review' })
/** The Subject control is named for the rows it sets ("Subject for 2 queries"). */
const subjectControl = (sheet: Sheet) => sheet.getByRole('radiogroup', { name: /^Subject for / })
const chooseSubject = (sheet: Sheet, option: string) => fireEvent.click(within(subjectControl(sheet)).getByRole('radio', { name: option }))
/** Opens the place picker by the text its trigger shows and chooses an option. */
const pick = (sheet: Sheet, trigger: string, option: string) => {
  fireEvent.click(sheet.getByText(trigger).closest('summary')!)
  fireEvent.click(sheet.getByRole('button', { name: `Select ${option}` }))
}
/** The sheet's rows as text: each query with what the Subject cell shows. A third cell holds the row's Remove. */
const listed = (sheet: Sheet) => sheet.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').slice(0, 2).map(cell => cell.textContent))

/** Presses Review and returns the request the server got. */
async function review(sheet: Sheet, writes: Write[]) {
  const sentBefore = writes.length
  fireEvent.click(reviewButton(sheet))
  await sheet.findByRole('heading', { name: /^Review \d+ changes?$/ })
  expect(writes).toHaveLength(sentBefore + 1)
  expect(writes.at(-1)!.operation).toBe('preview')
  return writes.at(-1)!.body
}

const version = { expectedWorkspaceVersion: workspaceVersion }
const many = (count: number) => Array.from({ length: count }, (_, index) => research(`rq-${index}`, `apartments near stop ${index}`, uptown))

describe('TrackResearchSheet', () => {
  it('sends one addition per row, each for its own run\'s Subject, then publishes exactly that review', async () => {
    const writes = installApi()
    const items = [
      research('rq-1', 'apartments with a dog park in Uptown', uptown),
      research('rq-2', 'quiet apartments in Downtown', downtown),
      research('rq-3', 'Is Harbor Point pet friendly?', harbor),
      research('rq-4', 'best apartments for remote workers in Uptown', uptown),
    ]
    const { sheet, onPublished, onClose } = renderSheet({ items })
    expect(screen.getByRole('dialog', { name: 'Track 4 queries' })).toBeTruthy()
    // Every row has the Subject its run was saved under, read-only, so there is nothing to choose.
    expect(sheet.queryByRole('radiogroup')).toBeNull()
    expect(sheet.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Subject', 'Remove'])
    // A location row says which markets it also counts in, in plain words: no row has a help button.
    expect(listed(sheet)).toEqual([
      ['apartments with a dog park in Uptown', 'Market · Uptown'],
      ['quiet apartments in Downtown', 'Market · Downtown'],
      ['Is Harbor Point pet friendly?', 'Location · Harbor PointCounts in: Uptown, Downtown'],
      ['best apartments for remote workers in Uptown', 'Market · Uptown'],
    ])
    expect(sheet.getAllByRole('row').slice(1).map(row => within(row).getAllByRole('button').map(button => button.getAttribute('aria-label')))).toEqual(items.map(item => [`Remove ${item.text}`]))
    // With no Subject to choose, the sheet opens on Review, not on the first row's Remove.
    expect(document.activeElement).toBe(reviewButton(sheet))

    // A market names itself alone. A location names itself and every market that holds it, as the Add queries sheet does. No row sends a search location.
    const additions = [
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-2' }, audience: { marketKeys: ['downtown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-3' }, audience: { targetKeys: ['harbor'], marketKeys: ['uptown', 'downtown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-4' }, audience: { marketKeys: ['uptown'] } },
    ]
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions, removals: [] })

    fireEvent.click(sheet.getByRole('button', { name: 'Publish 4 changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(writes).toHaveLength(2)
    // The publish carries the version the review answered with, not the one the sheet sent.
    expect(writes[1]).toStrictEqual({ operation: 'commit', body: { expectedWorkspaceVersion: reviewedVersion, additions, removals: [], previewToken, reviewedAt } })
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(committed)
  })

  it('keeps Review off until rows with no Subject get one, and gives them all the place chosen', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ items: [idea('probe-1', 'lofts near transit'), research('rq-1', 'apartments with a dog park in Uptown', uptown), idea('probe-2', 'short term rentals')] })
    expect(screen.getByRole('dialog', { name: 'Track 3 queries' })).toBeTruthy()
    // The control is named for the rows it sets, and those rows are listed first, under it.
    expect(sheet.getByRole('radiogroup', { name: 'Subject for 2 queries' })).toBe(subjectControl(sheet))
    expect(sheet.getByText('Subject for 2 queries')).toBeTruthy()
    expect(within(subjectControl(sheet)).getAllByRole('radio').map(radio => [radio.textContent, radio.getAttribute('aria-checked'), radio.getAttribute('aria-disabled')])).toEqual([
      ['Market', 'true', null], ['Location', 'false', null], ['Company', 'false', 'true'],
    ])
    expect(listed(sheet)).toEqual([['lofts near transit', 'Subject not set'], ['short term rentals', 'Subject not set'], ['apartments with a dog park in Uptown', 'Market · Uptown']])
    // The marks are plain labels: the control above is what sets them.
    expect(sheet.queryByRole('button', { name: /^Subject not set/ })).toBeNull()
    expect(reviewButton(sheet).disabled).toBe(true)
    fireEvent.click(reviewButton(sheet))
    chooseSubject(sheet, 'Company')
    expect(writes).toEqual([])

    pick(sheet, 'Choose a market', 'Downtown')
    // The row with its own Subject keeps it.
    expect(listed(sheet)).toEqual([['lofts near transit', 'Market · Downtown'], ['short term rentals', 'Market · Downtown'], ['apartments with a dog park in Uptown', 'Market · Uptown']])
    expect(await review(sheet, writes)).toStrictEqual({ ...version, removals: [], additions: [
      { input: { source: 'discovery', discoveryProbeId: 'probe-1' }, audience: { marketKeys: ['downtown'] } },
      { input: { source: 'discovery', discoveryProbeId: 'probe-2' }, audience: { marketKeys: ['downtown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } },
    ] })

    // A query has one Subject: another one drops the place, and Review waits again.
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    chooseSubject(sheet, 'Location')
    expect(listed(sheet)[0]).toEqual(['lofts near transit', 'Subject not set'])
    expect(reviewButton(sheet).disabled).toBe(true)
    pick(sheet, 'Choose a location', 'Harbor Point')
    // The markets the location's queries count in, with the sentence behind the help beside them.
    expect(sheet.getByText('Counts in: Uptown, Downtown')).toBeTruthy()
    expect(sheet.getByRole('button', { name: "Asked with these markets' engines and search locations." })).toBeTruthy()
    const location = { targetKeys: ['harbor'], marketKeys: ['uptown', 'downtown'] }
    // The rows that take the chosen location say nothing more: the line under the picker speaks for them.
    expect(listed(sheet)[0]).toEqual(['lofts near transit', 'Location · Harbor Point'])
    expect((await review(sheet, writes)).additions).toStrictEqual([
      { input: { source: 'discovery', discoveryProbeId: 'probe-1' }, audience: location },
      { input: { source: 'discovery', discoveryProbeId: 'probe-2' }, audience: location },
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } },
    ])
  })

  it('asks again for a Subject the plan no longer holds', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ items: [research('rq-1', 'apartments in the old quarter', { kind: 'market', key: 'old-quarter' }), research('rq-2', 'Is Mill House pet friendly?', { kind: 'location', key: 'mill-house' })] })
    expect(listed(sheet)).toEqual([['apartments in the old quarter', 'Subject not set'], ['Is Mill House pet friendly?', 'Subject not set']])
    expect(reviewButton(sheet).disabled).toBe(true)
    pick(sheet, 'Choose a market', 'Uptown')
    expect((await review(sheet, writes)).additions.map(addition => addition.audience)).toStrictEqual([{ marketKeys: ['uptown'] }, { marketKeys: ['uptown'] }])
  })

  it('gives a location in no market the project\'s one search location and engines, and cannot place it with two', async () => {
    const writes = installApi()
    const items = [research('rq-1', 'Is Lone Pine pet friendly?', lone), research('rq-2', 'apartments with a dog park in Uptown', uptown)]
    const one = renderSheet({ items, contextChoices: [contextChoices[1]!] }).sheet
    // Placed, and it says where it stands: a plain second line, with nothing held back and no note beside the buttons.
    expect(listed(one)).toEqual([['Is Lone Pine pet friendly?', 'Location · Lone PineIn no market'], ['apartments with a dog park in Uptown', 'Market · Uptown']])
    expect(one.queryByRole('button', { name: /^In no market/ })).toBeNull()
    expect(reviewButton(one).disabled).toBe(false)
    expect((await review(one, writes)).additions).toStrictEqual([
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { targetKeys: ['lone'] }, contexts: [contextChoices[1]!.input] },
      { input: { source: 'research', researchRunQueryId: 'rq-2' }, audience: { marketKeys: ['uptown'] } },
    ])

    for (const [choices, why] of [[contextChoices, /this project has more than one\./], [[], /^In no market\. No search location and engines are set up for this project/]] as const) {
      cleanup()
      const { sheet } = renderSheet({ items, contextChoices: choices })
      // The row keeps its Subject and says why it has no place. The sentence is behind the note beside the buttons, after them.
      expect(listed(sheet)).toEqual([['Is Lone Pine pet friendly?', 'Location · Lone PineIn no market'], ['apartments with a dog park in Uptown', 'Market · Uptown']])
      const note = sheet.getByRole('button', { name: why })
      expect(note.textContent).toBe('In no market')
      expect(sheet.getByRole('button', { name: 'Cancel' }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // Never sent without its place, and never sent short of a row.
      expect(reviewButton(sheet).disabled).toBe(true)
      fireEvent.click(reviewButton(sheet))
    }
    expect(writes).toHaveLength(1)
  })

  it('says what a chosen location in no market is asked with, and counts a location that sits in three markets', async () => {
    const writes = installApi()
    // Harbor Point in a third market: over two, the markets are counted, and named in the help beside the picker.
    const wide = { ...workspace, markets: workspace.markets.map(market => market.stableKey === 'solo' ? { ...market, usageEdges: [...market.usageEdges, { executionNodeKey: 'node-extra', targetKey: 'harbor', queryId: 'q-extra' }] } : market) }
    const { sheet } = renderSheet({ workspace: wide, contextChoices: [contextChoices[1]!], items: [research('rq-1', 'Is Harbor Point pet friendly?', harbor), idea('probe-1', 'lofts near transit')] })
    expect(sheet.getByRole('radiogroup', { name: 'Subject for 1 query' })).toBeTruthy()
    // The row that takes the Subject chosen here comes first, whatever the order the rows were ticked in.
    expect(listed(sheet)).toEqual([['lofts near transit', 'Subject not set'], ['Is Harbor Point pet friendly?', 'Location · Harbor PointCounts in 3 markets']])

    chooseSubject(sheet, 'Location')
    pick(sheet, 'Choose a location', 'Lone Pine')
    // As the Add queries sheet says it: in no market, and the one search location and engines its query is asked with.
    expect(sheet.getByRole('button', { name: 'In no market. A query for a location in no market needs its own search location and engines.' }).textContent).toBe('In no market')
    expect(sheet.getByText('Search location and engines').nextElementSibling!.textContent).toBe('Boston · OpenAI')
    expect(listed(sheet)[0]).toEqual(['lofts near transit', 'Location · Lone Pine'])
    const everyMarket = { targetKeys: ['harbor'], marketKeys: ['uptown', 'downtown', 'solo'] }
    expect((await review(sheet, writes)).additions).toStrictEqual([
      { input: { source: 'discovery', discoveryProbeId: 'probe-1' }, audience: { targetKeys: ['lone'] }, contexts: [contextChoices[1]!.input] },
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: everyMarket },
    ])

    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    pick(sheet, 'Lone Pine · Location', 'Summit Lofts')
    expect(sheet.queryByText('Search location and engines')).toBeNull()
    expect(sheet.getByText('Counts in: Uptown')).toBeTruthy()
    pick(sheet, 'Summit Lofts · Location', 'Harbor Point')
    // Under the picker and under the row that keeps its own run's location.
    expect(sheet.getAllByText('Counts in 3 markets')).toHaveLength(2)
    expect(sheet.getByRole('button', { name: "Uptown, Downtown, Solo. Asked with these markets' engines and search locations." })).toBeTruthy()
  })

  it('lists a query ticked twice under one Subject once, and sends it once', async () => {
    const writes = installApi()
    // The server matches a query by its text, whatever its case and spacing. Two of these are one query for Uptown, and the two Find ideas results are one more.
    const { sheet } = renderSheet({ items: [
      research('rq-1', 'pet friendly apartments', uptown), idea('probe-1', 'Lofts near transit'), research('rq-2', ' Pet Friendly  Apartments', uptown),
      idea('probe-2', 'lofts near transit'), research('rq-3', 'quiet apartments in Downtown', downtown),
    ] })
    expect(screen.getByRole('dialog', { name: 'Track 3 queries' })).toBeTruthy()
    expect(sheet.getByRole('radiogroup', { name: 'Subject for 1 query' })).toBeTruthy()
    expect(listed(sheet)).toEqual([['Lofts near transit', 'Subject not set'], ['pet friendly apartments', 'Market · Uptown'], ['quiet apartments in Downtown', 'Market · Downtown']])
    // A different Subject for the same text is two rows, and no review.
    pick(sheet, 'Choose a market', 'Solo')
    expect((await review(sheet, writes)).additions).toStrictEqual([
      { input: { source: 'discovery', discoveryProbeId: 'probe-1' }, audience: { marketKeys: ['solo'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-3' }, audience: { marketKeys: ['downtown'] } },
    ])
  })

  it('holds Review while one query is ticked under two Subjects, on every row that shares its text', () => {
    const writes = installApi()
    const { sheet } = renderSheet({ items: [
      research('rq-1', 'pet friendly apartments', uptown), research('rq-2', 'Pet friendly apartments ', downtown),
      research('rq-3', 'quiet apartments in Downtown', downtown), idea('probe-1', 'pet friendly apartments'), idea('probe-2', 'Quiet apartments in downtown'),
    ] })
    expect(screen.getByRole('dialog', { name: 'Track 5 queries' })).toBeTruthy()
    // A row with no Subject is not one of the two until it has one: the Downtown query it shares its text with is not marked.
    expect(listed(sheet)).toEqual([
      ['pet friendly apartments', 'Subject not set'],
      ['Quiet apartments in downtown', 'Subject not set'],
      ['pet friendly apartments', 'Market · UptownKeep one Subject'],
      ['Pet friendly apartments ', 'Market · DowntownKeep one Subject'],
      ['quiet apartments in Downtown', 'Market · Downtown'],
    ])
    // The marks are plain labels. The sentence is behind the note beside the buttons, after them.
    const note = sheet.getByRole('button', { name: /^Keep one Subject\. This query is ticked under more than one Subject, and a query is tracked for one\./ })
    expect(note.textContent).toBe('Keep one Subject')
    expect(sheet.getByRole('button', { name: 'Cancel' }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Given Uptown, one row with no Subject is the Uptown row again, listed once, and the other is a second Subject for its own text.
    pick(sheet, 'Choose a market', 'Uptown')
    expect(screen.getByRole('dialog', { name: 'Track 4 queries' })).toBeTruthy()
    expect(listed(sheet)).toEqual([
      ['pet friendly apartments', 'Market · UptownKeep one Subject'],
      ['Quiet apartments in downtown', 'Market · UptownKeep one Subject'],
      ['Pet friendly apartments ', 'Market · DowntownKeep one Subject'],
      ['quiet apartments in Downtown', 'Market · DowntownKeep one Subject'],
    ])
    // Given a third, every row is marked.
    pick(sheet, 'Uptown · Market', 'Solo')
    expect(listed(sheet).map(cells => cells[1])).toEqual(['Market · SoloKeep one Subject', 'Market · SoloKeep one Subject', 'Market · UptownKeep one Subject', 'Market · DowntownKeep one Subject', 'Market · DowntownKeep one Subject'])
    expect(reviewButton(sheet).disabled).toBe(true)
    fireEvent.click(reviewButton(sheet))
    expect(writes).toEqual([])
  })

  it('keeps a refused review in the sheet, with the server\'s reason and Review again', async () => {
    let refuse = true
    const writes = installApi(write => write.operation === 'preview' && refuse ? refusal() : undefined)
    const { sheet, onClose } = renderSheet({ items: [research('rq-1', 'apartments with a dog park in Uptown', uptown)] })
    expect(screen.getByRole('dialog', { name: 'Track 1 query' })).toBeTruthy()
    fireEvent.click(reviewButton(sheet))
    expect((await sheet.findByRole('alert')).textContent).toBe('Could not review tracking changes. Workspace changed. Review again.')
    expect(onClose).not.toHaveBeenCalled()

    refuse = false
    fireEvent.click(sheet.getByRole('button', { name: 'Review again' }))
    await sheet.findByRole('heading', { name: 'Review 1 change' })
    expect(writes.map(write => write.body.additions)).toStrictEqual([
      [{ input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } }],
      [{ input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { marketKeys: ['uptown'] } }],
    ])
  })

  it('holds Publish back while a sweep runs, and names the next sweep when none does', async () => {
    const writes = installApi()
    const items = [research('rq-1', 'apartments with a dog park in Uptown', uptown)]
    const running = renderSheet({ items, sweepActive: true, nextSweepDate: 'Oct 21' }).sheet
    await review(running, writes)
    expect(running.getByRole<HTMLButtonElement>('button', { name: 'Publish 1 change' }).disabled).toBe(true)
    expect(running.getByRole('button', { name: /^Sweep running\./ })).toBeTruthy()
    expect(running.queryByText('First answers Oct 21')).toBeNull()

    cleanup()
    const { sheet } = renderSheet({ items, nextSweepDate: 'Oct 21' })
    await review(sheet, writes)
    expect(sheet.getByRole<HTMLButtonElement>('button', { name: 'Publish 1 change' }).disabled).toBe(false)
    expect(sheet.getByText('First answers Oct 21')).toBeTruthy()
  })

  it('reviews 50 rows and refuses 51', async () => {
    const writes = installApi()
    const over = renderSheet({ items: many(51) }).sheet
    expect(reviewButton(over).disabled).toBe(true)
    expect(over.getByText('Max 50 rows')).toBeTruthy()
    fireEvent.click(reviewButton(over))
    expect(writes).toEqual([])

    cleanup()
    const { sheet } = renderSheet({ items: many(50) })
    expect(sheet.queryByText('Max 50 rows')).toBeNull()
    expect((await review(sheet, writes)).additions).toHaveLength(50)
  })

  it('gives a view-only account no sheet', () => {
    const writes = installApi()
    renderSheet({ items: many(2) }, 'viewer')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes).toEqual([])
  })
})

describe('TrackResearchBar', () => {
  type BarProps = React.ComponentProps<typeof TrackResearchBar>

  function renderBar(props: Pick<BarProps, 'items'> & Partial<BarProps>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    onTestFinished(() => queryClient.clear())
    const all = { projectName: 'demo', workspace, sweepActive: false, onClear: vi.fn(), returnFocus: vi.fn(), ...props }
    const bar = (next: Partial<BarProps>) => <QueryClientProvider client={queryClient}><TrackResearchBar {...all} {...next} /></QueryClientProvider>
    const view = render(bar({}))
    return { ...all, show: (next: Partial<BarProps>) => view.rerender(bar(next)) }
  }
  const bar = () => within(screen.getByRole('region', { name: 'Selected queries' }))
  /** The bar while the sheet is open over it: the sheet keeps the rest of the page from assistive tech. */
  const barBehind = () => within(screen.getByRole('region', { name: 'Selected queries', hidden: true }))

  it('counts the ticked rows, opens the sheet for them, and clears them', async () => {
    const writes = installApi()
    const { onClear, returnFocus, show } = renderBar({ items: many(4) })
    expect(bar().getByRole('status').textContent).toBe('4 selected')
    expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 4', 'Clear'])
    fireEvent.click(bar().getByRole('button', { name: 'Clear' }))
    expect(onClear).toHaveBeenCalledOnce()
    // Clear takes the bar off the page, so the caller says where the focus goes.
    expect(returnFocus).toHaveBeenCalledOnce()

    fireEvent.click(bar().getByRole('button', { name: 'Track 4' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Track 4 queries' }))
    // The sheet gets the project's own search location and engines choices: here one, so nothing is asked.
    await review(sheet, writes)
    fireEvent.click(sheet.getByRole('button', { name: 'Publish 4 changes' }))
    // A publish clears the ticks and closes the sheet.
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Rows that leave the selection while the sheet is open take it with them, and it stays shut for the next row ticked.
    fireEvent.click(bar().getByRole('button', { name: 'Track 4' }))
    await screen.findByRole('dialog', { name: 'Track 4 queries' })
    show({ items: [] })
    expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    show({ items: many(1) })
    expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 1', 'Clear'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /** The bar over a real selection, as both Research tables hold one: ticked on arrival, then unticked from the sheet or by a tracked list that grows. */
  function Selection({ items, subjects, ...rest }: Pick<BarProps, 'items'> & Partial<BarProps> & { subjects?: ReadonlyMap<string, string> }) {
    const picks = useTrackSelection(subjects)
    const { pick } = picks
    useEffect(() => pick(items, true), [pick, items])
    return <TrackResearchBar projectName="demo" workspace={workspace} sweepActive={false} {...rest} items={picks.items} onClear={picks.clear} onRemove={rows => pick(rows, false)} />
  }
  function renderSelection(props: React.ComponentProps<typeof Selection>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    onTestFinished(() => queryClient.clear())
    const selection = (next: Partial<React.ComponentProps<typeof Selection>>) => <QueryClientProvider client={queryClient}><Selection {...props} {...next} /></QueryClientProvider>
    const view = render(selection({}))
    return { show: (next: Partial<React.ComponentProps<typeof Selection>>) => view.rerender(selection(next)) }
  }
  const openSheet = async (track: string, title: string) => {
    fireEvent.click(bar().getByRole('button', { name: track }))
    return within(await screen.findByRole('dialog', { name: title }))
  }
  const loneRows = [research('rq-1', 'Is Lone Pine pet friendly?', lone), research('rq-2', 'apartments with a dog park in Uptown', uptown), research('rq-3', 'quiet apartments in Downtown', downtown)]

  it('gives a location in no market the project\'s own search location and engines', async () => {
    const writes = installApi()
    renderSelection({ items: loneRows.slice(0, 2) })
    const sheet = await openSheet('Track 2', 'Track 2 queries')
    // The choice is built from the project's default: its engine, its model and its search location by name.
    expect((await review(sheet, writes)).additions).toStrictEqual([
      { input: { source: 'research', researchRunQueryId: 'rq-1' }, audience: { targetKeys: ['lone'] }, contexts: [{ providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' }] },
      { input: { source: 'research', researchRunQueryId: 'rq-2' }, audience: { marketKeys: ['uptown'] } },
    ])
  })

  it('holds a location in no market back when the project has two search locations, until its row is removed', async () => {
    const writes = installApi()
    const boston = { ...workspace.defaultContexts[0]!, location: { label: 'Boston', city: 'Boston', region: 'MA', country: 'US' } }
    renderSelection({ items: loneRows, workspace: { ...workspace, defaultContexts: [...workspace.defaultContexts, boston] } })
    const sheet = await openSheet('Track 3', 'Track 3 queries')
    expect(listed(sheet)[0]).toEqual(['Is Lone Pine pet friendly?', 'Location · Lone PineIn no market'])
    expect(sheet.getByRole('button', { name: /^In no market\. .* this project has more than one\./ })).toBeTruthy()
    // Review waits, so the sheet opens on Cancel. Never sent without its place, and never sent short of a row.
    expect(reviewButton(sheet).disabled).toBe(true)
    expect(document.activeElement).toBe(sheet.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(reviewButton(sheet))
    expect(writes).toEqual([])

    // Removing the row unticks it and leaves the rest to review. The next row's Remove takes the focus.
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Is Lone Pine pet friendly?' }))
    expect(screen.getByRole('dialog', { name: 'Track 2 queries' })).toBeTruthy()
    expect(barBehind().getByRole('status', { hidden: true }).textContent).toBe('2 selected')
    expect(listed(sheet)).toEqual([['apartments with a dog park in Uptown', 'Market · Uptown'], ['quiet apartments in Downtown', 'Market · Downtown']])
    expect(sheet.queryByText('In no market')).toBeNull()
    expect(document.activeElement).toBe(sheet.getByRole('button', { name: 'Remove apartments with a dog park in Uptown' }))
    // The last row has no Remove: Cancel is its way out. With no Remove left, Review takes the focus.
    fireEvent.click(sheet.getByRole('button', { name: 'Remove quiet apartments in Downtown' }))
    expect(screen.getByRole('dialog', { name: 'Track 1 query' })).toBeTruthy()
    expect(sheet.queryByRole('button', { name: /^Remove / })).toBeNull()
    expect(sheet.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Query', 'Subject'])
    expect(document.activeElement).toBe(reviewButton(sheet))
    expect((await review(sheet, writes)).additions).toStrictEqual([{ input: { source: 'research', researchRunQueryId: 'rq-2' }, audience: { marketKeys: ['uptown'] } }])
  })

  it('reviews a query ticked under two Subjects once one of its rows is removed, with every row that stood for it', async () => {
    const writes = installApi()
    renderSelection({ items: [
      research('rq-1', 'pet friendly apartments', uptown), research('rq-2', 'Pet friendly apartments', downtown),
      research('rq-3', 'quiet apartments in Downtown', downtown), research('rq-4', 'pet friendly apartments ', uptown),
    ] })
    // Four rows ticked, three queries listed: the two Uptown rows are one.
    const sheet = await openSheet('Track 4', 'Track 3 queries')
    expect(reviewButton(sheet).disabled).toBe(true)
    fireEvent.click(sheet.getByRole('button', { name: 'Remove pet friendly apartments' }))
    // Both Uptown rows are unticked with the one that stood for them, so neither comes back.
    expect(barBehind().getByRole('status', { hidden: true }).textContent).toBe('2 selected')
    expect(listed(sheet)).toEqual([['Pet friendly apartments', 'Market · Downtown'], ['quiet apartments in Downtown', 'Market · Downtown']])
    expect(sheet.queryByText('Keep one Subject')).toBeNull()
    expect(await review(sheet, writes)).toStrictEqual({ ...version, removals: [], additions: [
      { input: { source: 'research', researchRunQueryId: 'rq-2' }, audience: { marketKeys: ['downtown'] } },
      { input: { source: 'research', researchRunQueryId: 'rq-3' }, audience: { marketKeys: ['downtown'] } },
    ] })
  })

  it('drops a ticked row whose query has since been tracked', () => {
    installApi()
    const { show } = renderSelection({ items: many(3), subjects: new Map() })
    expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 3', 'Clear'])
    // The tracked list grew with no publish from here, as it does when someone else tracks the query. It is matched by its identity text.
    show({ subjects: new Map([['apartments near stop 1', 'Market · Uptown (3)']]) })
    expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Track 2', 'Clear'])
    show({ subjects: new Map(many(3).map(item => [item.text, 'Market · Uptown (3)'])) })
    expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
  })

  it('offers no Track over 50 rows, and says why', () => {
    installApi()
    renderBar({ items: many(51) })
    expect(bar().getByRole('status').textContent).toBe('51 selected')
    expect(bar().getAllByRole('button').map(button => button.textContent)).toEqual(['Max 50 rows', 'Clear'])
    expect(bar().getByRole('button', { name: /^Max 50 rows\. One change takes at most 50 rows\./ })).toBeTruthy()
  })

  it('draws nothing with no row ticked', () => {
    installApi()
    renderBar({ items: [] })
    expect(screen.queryByRole('region', { name: 'Selected queries' })).toBeNull()
  })
})
