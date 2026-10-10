import React, { useState } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { TrackedActionSheet } from '../src/components/project/queries/advanced/TrackedActionSheet.js'
import type { TrackedRowVm } from '../src/components/project/queries/advanced/tracked-types.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { resetToasts } from '../src/lib/toast-store.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { contextChoices, rows, uptownPlace, withSecondSearchLocation, withSource, workspace, workspaceVersion } from './support/tracked-action-fixtures.js'

afterEach(() => {
  cleanup()
  resetToasts()
})

const previewToken = `qtp_${'b'.repeat(64)}`
const reviewedAt = '2026-09-04T12:15:00.000Z'
/** The version the review answers with. Not the one the form sent, so a publish shows which of the two it carries. */
const reviewedVersion = `qtw_${'f'.repeat(64)}`
const active = { revision: 4, compiledChecksum: 'c'.repeat(64) }
const committed = { committed: true, mode: 'advanced', workspaceVersion: `qtw_${'d'.repeat(64)}`, reviewedAt, active: { ...active, revision: 5 } }
const refusal = () => jsonResponse({ error: { code: 'QUERY_TRACKING_PREVIEW_STALE', message: 'Workspace changed. Review again.' } }, 409)

type Body = {
  expectedWorkspaceVersion: string
  additions: Array<{ input: { text: string } }>
  removals: Array<{ queryId: string }>
  edits?: Array<{ queryId: string }>
}
type Write = { operation: 'preview' | 'commit'; body: Body }

/** A review as the server answers one: a query both removed and added again is listed once, as reused. */
function preview(body: Body) {
  const text = (queryId: string) => workspace.tracked.find(row => row.queryId === queryId)?.queryText ?? queryId
  const change = (queryId: string) => ({ queryId, queryText: text(queryId), assignmentCount: 1 })
  const reused = body.additions.length > 0 ? body.removals : body.edits ?? []
  const removed = body.additions.length > 0 ? [] : body.removals
  return {
    mode: 'advanced', workspaceVersion: reviewedVersion, previewToken, reviewedAt, active,
    tracked: workspace.tracked.filter(row => !removed.some(removal => removal.queryId === row.queryId)),
    diff: { added: [], removed: removed.map(removal => change(removal.queryId)), reused: reused.map(row => change(row.queryId)), unchanged: [], noOp: false },
    workload: { existingNodes: 9, existingProviderCalls: 9, nextSweepNodes: 9 - removed.length, nextSweepProviderCalls: 9 - removed.length, addedNodes: 0, addedProviderCalls: 0, removedNodes: removed.length, removedProviderCalls: removed.length },
  }
}

/** Records every review and publish the sheet sends; `respond` can answer one itself, at once or later. */
function installApi(respond?: (write: Write) => Response | Promise<Response> | undefined) {
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

type SheetProps = React.ComponentProps<typeof TrackedActionSheet>

function renderSheet(props: Pick<SheetProps, 'action' | 'rows'> & Partial<SheetProps>, role?: 'viewer') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const all = { projectName: 'demo', workspace, contextChoices, sweepActive: false, onClose: vi.fn(), onPublished: vi.fn(), ...props }
  const sheet = <QueryClientProvider client={queryClient}><TrackedActionSheet {...all} /></QueryClientProvider>
  const { rerender } = render(role ? <AccountProvider account={{ name: role, role }}>{sheet}</AccountProvider> : sheet)
  /** Renders the same sheet with other props, as the page does when the workspace is read again. */
  const show = (next: Partial<SheetProps>) => rerender(<QueryClientProvider client={queryClient}><TrackedActionSheet {...all} {...next} /></QueryClientProvider>)
  // A viewer gets no sheet, so there is no dialog to look in.
  return { ...all, show, sheet: within(screen.queryByRole('dialog') ?? document.body) }
}

type Sheet = ReturnType<typeof renderSheet>['sheet']
const reviewButton = (sheet: Sheet) => sheet.getByRole<HTMLButtonElement>('button', { name: 'Review' })
const radios = (sheet: Sheet, group: string) => within(sheet.getByRole('radiogroup', { name: group })).getAllByRole('radio')
const choose = (sheet: Sheet, group: string, option: string) => fireEvent.click(within(sheet.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }))
const checked = (sheet: Sheet, group: string) => radios(sheet, group).find(radio => radio.getAttribute('aria-checked') === 'true')?.textContent
/** Opens the place picker by the text its trigger shows (the chosen place, or the placeholder) and chooses an option. */
const pick = (sheet: Sheet, trigger: string, option: string) => {
  fireEvent.click(sheet.getByText(trigger).closest('summary')!)
  fireEvent.click(sheet.getByRole('button', { name: `Select ${option}` }))
}

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
const many = (count: number): TrackedRowVm[] => Array.from({ length: count }, (_, index) => ({ ...rows.market, queryId: `q-${index}`, queryText: `apartments near stop ${index}` }))

describe('Stop tracking and Remove query', () => {
  it('sends a bulk stop of 3 rows as 3 removals in one review, then publishes exactly that review', async () => {
    const writes = installApi()
    const { sheet, onPublished, onClose } = renderSheet({ action: 'stop', rows: [rows.market, rows.location, rows.handPicked] })
    expect(screen.getByRole('dialog', { name: 'Stop tracking' })).toBeTruthy()
    // No place was given, so there is nothing to narrow to.
    expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()

    const removals = [{ queryId: 'q-uptown' }, { queryId: 'q-harbor' }, { queryId: 'q-picked' }]
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals })

    fireEvent.click(sheet.getByRole('button', { name: 'Publish 3 changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(writes).toHaveLength(2)
    // The publish carries the version the review answered with, not the one the form sent.
    expect(writes[1]).toStrictEqual({ operation: 'commit', body: { expectedWorkspaceVersion: reviewedVersion, additions: [], removals, previewToken, reviewedAt } })
    expect(onPublished).toHaveBeenCalledExactlyOnceWith(committed)
  })

  it('names up to five queries and counts the rest', () => {
    installApi()
    const { sheet } = renderSheet({ action: 'stop', rows: many(7) })
    expect(sheet.getByText('7 queries')).toBeTruthy()
    expect(sheet.getAllByRole('listitem').map(item => item.textContent)).toEqual(many(5).map(row => row.queryText))
    expect(sheet.getByText('+2 more')).toBeTruthy()

    cleanup()
    const five = renderSheet({ action: 'stop', rows: many(5) }).sheet
    expect(five.getAllByRole('listitem')).toHaveLength(5)
    expect(five.queryByText(/more$/)).toBeNull()
  })

  it('reviews 50 rows and refuses 51', async () => {
    const writes = installApi()
    const over = renderSheet({ action: 'stop', rows: many(51) }).sheet
    expect(reviewButton(over).disabled).toBe(true)
    expect(over.getByText('Max 50 rows')).toBeTruthy()
    fireEvent.click(reviewButton(over))
    expect(writes).toEqual([])

    cleanup()
    const { sheet } = renderSheet({ action: 'stop', rows: many(50) })
    expect(sheet.queryByText('Max 50 rows')).toBeNull()
    expect((await review(sheet, writes)).removals).toHaveLength(50)
  })

  it('removes a query that is not asked for the whole project, under its own title', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'remove', rows: [rows.notAsked], place: uptownPlace })
    expect(screen.getByRole('dialog', { name: 'Remove query' })).toBeTruthy()
    expect(sheet.getByText('apartments in the old town')).toBeTruthy()
    expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals: [{ queryId: 'q-old' }] })

    cleanup()
    const second = { ...rows.notAsked, queryId: 'q-older', queryText: 'apartments by the old mill' }
    const several = renderSheet({ action: 'remove', rows: [rows.notAsked, second] }).sheet
    expect(screen.getByRole('dialog', { name: 'Remove queries' })).toBeTruthy()
    expect(several.getByText('2 queries')).toBeTruthy()
    expect((await review(several, writes)).removals).toStrictEqual([{ queryId: 'q-old' }, { queryId: 'q-older' }])
  })
})

describe('Applies to', () => {
  const audience = { marketKeys: ['uptown'] }
  // The hand-picked query is asked at Harbor Point in Uptown and at Pier House outside it, so the two choices differ.
  const cases = [
    ['stop', (sheet: Sheet) => sheet, (queryId: string, scope: object) => ({ additions: [], removals: [{ queryId, ...scope }] })],
    ['change-type', (sheet: Sheet) => { choose(sheet, 'Type', 'Non-brand'); return sheet }, (queryId: string, scope: object) => ({ additions: [], removals: [], edits: [{ queryId, queryClass: 'non-brand', ...scope }] })],
    ['edit-wording', (sheet: Sheet) => { fireEvent.change(sheet.getByLabelText('Query'), { target: { value: 'apartments with a rooftop pool' } }); return sheet }, (queryId: string, scope: object) => ({ additions: [], removals: [], edits: [{ queryId, text: 'apartments with a rooftop pool', ...scope }] })],
  ] as const

  it.each(cases)('narrows %s to the place by default, and to nothing under Everywhere', async (action, fill, body) => {
    const writes = installApi()
    const { sheet } = renderSheet({ action, rows: [rows.handPicked], place: uptownPlace })
    expect(radios(sheet, 'Applies to').map(radio => radio.textContent)).toEqual(['Only Uptown', 'Everywhere'])
    expect(checked(sheet, 'Applies to')).toBe('Only Uptown')
    fill(sheet)
    expect(await review(sheet, writes)).toStrictEqual({ ...version, ...body('q-picked', { audience }) })

    // Back to the form: a change there drops the review, and the next one is for the whole query.
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    choose(sheet, 'Applies to', 'Everywhere')
    expect(await review(sheet, writes)).toStrictEqual({ ...version, ...body('q-picked', {}) })
  })

  it.each(cases)('asks nothing for %s when the query is asked nowhere else, and sends the plain request', async (action, fill, body) => {
    const writes = installApi()
    // Every pairing of this market query is in Uptown: "Only Uptown" and "Everywhere" would be one change.
    const { sheet } = renderSheet({ action, rows: [rows.market], place: uptownPlace })
    expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
    expect(sheet.queryByText('Applies to')).toBeNull()
    fill(sheet)
    expect(await review(sheet, writes)).toStrictEqual({ ...version, ...body('q-uptown', {}) })
  })

  it('keeps the whole place name as the choice, however long, beside Everywhere', () => {
    installApi()
    const long = 'Acme Homes at Harbor Point Waterfront Residences'
    const { sheet } = renderSheet({ action: 'stop', rows: [rows.handPicked], place: { ...uptownPlace, label: long } })
    // Cut on screen with an ellipsis, never in its name.
    expect(radios(sheet, 'Applies to').map(radio => radio.textContent)).toEqual([`Only ${long}`, 'Everywhere'])
    expect(sheet.getByRole('radio', { name: `Only ${long}` })).toBeTruthy()
  })

  it.each(['change-subject', 'move-location'] as const)('is not offered for %s, which replaces every place the query is in', action => {
    installApi()
    const { sheet } = renderSheet({ action, rows: [rows.location], place: uptownPlace })
    expect(sheet.queryByRole('radiogroup', { name: 'Applies to' })).toBeNull()
  })
})

describe('Edit wording', () => {
  it('keeps Review off until the wording differs, then sends one edit', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'edit-wording', rows: [rows.location] })
    const field = sheet.getByLabelText<HTMLTextAreaElement>('Query')
    expect(field.value).toBe('Harbor Point reviews')
    expect(reviewButton(sheet).disabled).toBe(true)
    for (const same of ['  Harbor Point reviews ', '', '   ']) {
      fireEvent.change(field, { target: { value: same } })
      expect(reviewButton(sheet).disabled, JSON.stringify(same)).toBe(true)
    }
    // The caveat is a short label; its sentence is the note's name and tooltip, not a line in the form.
    const note = sheet.getByRole('button', { name: /^New trend line\. New wording is tracked as a new query\./ })
    expect(note.textContent).toBe('New trend line')

    fireEvent.change(field, { target: { value: ' Harbor Point resident reviews ' } })
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals: [], edits: [{ queryId: 'q-harbor', text: 'Harbor Point resident reviews' }] })
  })
})

describe('Change type', () => {
  const types = (sheet: Sheet) => radios(sheet, 'Type').map(radio => radio.textContent)
  /** The row's own type, printed over the control. */
  const now = (sheet: Sheet) => sheet.getByText('Now').nextElementSibling?.textContent
  const followsSubject = /^Type follows Subject\. Set a market query to Non-brand and a location query to Branded\. A hand-picked query takes either\.$/
  const setsSubject = /^Type sets Subject\. In a market with one location, the type decides the Subject\./

  it('offers a market query Non-brand, a location query Branded and a hand-picked query both', () => {
    installApi()
    const market = renderSheet({ action: 'change-type', rows: [rows.market] }).sheet
    expect(types(market)).toEqual(['Automatic', 'Non-brand'])
    // Why Branded is missing is a short label; its sentence is the note's name and tooltip.
    expect(market.getByRole('button', { name: followsSubject }).textContent).toBe('Type follows Subject')
    cleanup()
    const location = renderSheet({ action: 'change-type', rows: [rows.location] }).sheet
    expect(types(location)).toEqual(['Automatic', 'Branded'])
    expect(location.getByRole('button', { name: followsSubject })).toBeTruthy()
    cleanup()
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.handPicked] })
    expect(types(sheet)).toEqual(['Automatic', 'Branded', 'Non-brand'])
    // It takes every type, so there is nothing to explain.
    expect(sheet.queryByText('Type follows Subject')).toBeNull()
    expect(sheet.queryByText('Type sets Subject')).toBeNull()
    cleanup()
    // A type no selected row can take is not offered at all.
    expect(types(renderSheet({ action: 'change-type', rows: [rows.market, rows.marketB] }).sheet)).toEqual(['Automatic', 'Non-brand'])
  })

  it('shows the type one row has now, and none for several rows', () => {
    installApi()
    expect(now(renderSheet({ action: 'change-type', rows: [rows.market] }).sheet)).toBe('Non-brand')
    cleanup()
    expect(now(renderSheet({ action: 'change-type', rows: [rows.location] }).sheet)).toBe('Branded')
    cleanup()
    const mixed: TrackedRowVm = { ...rows.handPicked, type: 'mixed', queryClasses: ['branded', 'non-brand'] }
    expect(now(renderSheet({ action: 'change-type', rows: [mixed] }).sheet)).toBe('Mixed')
    cleanup()
    expect(now(renderSheet({ action: 'change-type', rows: [{ ...rows.handPicked, type: 'not-set', queryClasses: [] }] }).sheet)).toBe('Not set')
    cleanup()
    expect(renderSheet({ action: 'change-type', rows: [rows.market, rows.marketB] }).sheet.queryByText('Now')).toBeNull()
  })

  it('keeps Review off while the type is the one the server already chose', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.handPicked] })
    expect(checked(sheet, 'Type')).toBe('Automatic')
    expect(reviewButton(sheet).disabled).toBe(true)
    // Automatic is what the row has: choosing it by hand changes nothing either.
    choose(sheet, 'Type', 'Automatic')
    expect(reviewButton(sheet).disabled).toBe(true)
    choose(sheet, 'Type', 'Branded')
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals: [], edits: [{ queryId: 'q-picked', queryClass: 'branded' }] })
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    choose(sheet, 'Type', 'Automatic')
    expect(reviewButton(sheet).disabled).toBe(true)
  })

  it('opens one row on the type an operator set, keeps Review off until it changes, and sends null for Automatic', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-type', rows: [withSource(rows.location, 'operator')] })
    expect(checked(sheet, 'Type')).toBe('Branded')
    expect(now(sheet)).toBe('Branded')
    expect(reviewButton(sheet).disabled).toBe(true)
    // A press on the type it has is no change.
    choose(sheet, 'Type', 'Branded')
    expect(reviewButton(sheet).disabled).toBe(true)
    choose(sheet, 'Type', 'Automatic')
    expect((await review(sheet, writes)).edits).toStrictEqual([{ queryId: 'q-harbor', queryClass: null }])
  })

  it('never hands an operator\'s type back to the classifier unasked', async () => {
    const writes = installApi()
    // A location query an operator set to Non-brand, which a location query cannot be set to here: the control cannot show it.
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.operatorSet] })
    expect(now(sheet)).toBe('Non-brand')
    expect(types(sheet)).toEqual(['Automatic', 'Branded'])
    expect(checked(sheet, 'Type')).toBe('Automatic')
    // Automatic is only where the control opens. Review waits for a choice.
    expect(reviewButton(sheet).disabled).toBe(true)
    fireEvent.click(reviewButton(sheet))
    expect(writes).toEqual([])
    choose(sheet, 'Type', 'Automatic')
    expect((await review(sheet, writes)).edits).toStrictEqual([{ queryId: 'q-harbor-parking', queryClass: null }])
  })

  it('waits for a choice in bulk, where the control always opens on Automatic', async () => {
    const writes = installApi()
    const second: TrackedRowVm = { ...rows.operatorSet, queryId: 'q-harbor-gym', queryText: 'Harbor Point gym' }
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.operatorSet, second] })
    expect(checked(sheet, 'Type')).toBe('Automatic')
    expect(reviewButton(sheet).disabled).toBe(true)
    choose(sheet, 'Type', 'Automatic')
    expect((await review(sheet, writes)).edits).toStrictEqual([{ queryId: 'q-harbor-parking', queryClass: null }, { queryId: 'q-harbor-gym', queryClass: null }])

    cleanup()
    // Rows the server classified have nothing to hand back, so Automatic stays off for them even when chosen.
    const server = renderSheet({ action: 'change-type', rows: [rows.market, rows.marketB] }).sheet
    choose(server, 'Type', 'Automatic')
    expect(reviewButton(server).disabled).toBe(true)
    choose(server, 'Type', 'Non-brand')
    expect(reviewButton(server).disabled).toBe(false)
  })

  it('lets the server answer where the row cannot tell: no recorded source, or two search locations', async () => {
    const writes = installApi()
    // No recorded source: the server classifies it again under Automatic.
    const frozen = renderSheet({ action: 'change-type', rows: [withSource(rows.handPicked, 'frozen')] }).sheet
    expect(reviewButton(frozen).disabled).toBe(true)
    choose(frozen, 'Type', 'Automatic')
    expect((await review(frozen, writes)).edits).toStrictEqual([{ queryId: 'q-picked', queryClass: null }])

    cleanup()
    // The row shows only the first search location's type and who set it, so the type it opens on may still be a change.
    const twice = renderSheet({ action: 'change-type', rows: [withSecondSearchLocation(withSource(rows.handPicked, 'operator'))] }).sheet
    expect(checked(twice, 'Type')).toBe('Non-brand')
    expect(reviewButton(twice).disabled).toBe(true)
    choose(twice, 'Type', 'Non-brand')
    expect((await review(twice, writes)).edits).toStrictEqual([{ queryId: 'q-picked', queryClass: 'non-brand' }])
  })

  it('says the type sets the Subject in a one-location market and offers both types there', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.soloMarket] })
    expect(types(sheet)).toEqual(['Automatic', 'Branded', 'Non-brand'])
    const note = sheet.getByRole('button', { name: setsSubject })
    expect(note.textContent).toBe('Type sets Subject')
    expect(sheet.queryByText('Type follows Subject')).toBeNull()
    // Branded is what makes this market query its location's query.
    choose(sheet, 'Type', 'Branded')
    expect((await review(sheet, writes)).edits).toStrictEqual([{ queryId: 'q-solo', queryClass: 'branded' }])
  })

  it('changes 1 of 3 market rows and 1 hand-picked row to Branded, and lists the 3 skipped', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.market, rows.marketB, rows.handPicked, rows.marketC] })
    expect(sheet.getByText('4 queries')).toBeTruthy()
    // Every type some row can take is offered; Automatic fits every row, so nothing is skipped yet.
    expect(types(sheet)).toEqual(['Automatic', 'Branded', 'Non-brand'])
    expect(sheet.queryByText(/skipped$/)).toBeNull()

    choose(sheet, 'Type', 'Branded')
    const skipped = sheet.getByText('1 to change · 3 skipped', { selector: 'summary' })
    expect(within(skipped.parentElement!).getAllByRole('listitem').map(item => item.textContent))
      .toEqual(['best apartments uptown', 'uptown apartments with parking', 'pet friendly apartments uptown'])
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals: [], edits: [{ queryId: 'q-picked', queryClass: 'branded' }] })
  })

  it('moves no query to the other Subject in bulk: a one-location market row is skipped for Branded', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.market, rows.soloMarket, rows.handPicked] })
    expect(types(sheet)).toEqual(['Automatic', 'Branded', 'Non-brand'])
    // Automatic can still land a one-location market row on its location, so the form says so.
    expect(sheet.getByRole('button', { name: setsSubject })).toBeTruthy()

    choose(sheet, 'Type', 'Branded')
    const skipped = sheet.getByText('1 to change · 2 skipped', { selector: 'summary' })
    expect(within(skipped.parentElement!).getAllByRole('listitem').map(item => item.textContent)).toEqual(['best apartments uptown', 'apartments near the pier'])
    // No row left in the change has its Subject set by its type.
    expect(sheet.queryByText('Type sets Subject')).toBeNull()
    expect(await review(sheet, writes)).toStrictEqual({ ...version, additions: [], removals: [], edits: [{ queryId: 'q-picked', queryClass: 'branded' }] })

    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    choose(sheet, 'Type', 'Non-brand')
    expect(sheet.queryByText(/skipped$/)).toBeNull()
    expect(sheet.getByRole('button', { name: setsSubject })).toBeTruthy()
    expect((await review(sheet, writes)).edits).toStrictEqual([{ queryId: 'q-uptown', queryClass: 'non-brand' }, { queryId: 'q-solo', queryClass: 'non-brand' }, { queryId: 'q-picked', queryClass: 'non-brand' }])
  })

  it('skips a query that is not asked for every type, and lists every skipped row', () => {
    installApi()
    const unasked = Array.from({ length: 12 }, (_, index): TrackedRowVm => ({ ...rows.notAsked, queryId: `q-old-${index}`, queryText: `apartments in old town ${index}` }))
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.market, ...unasked] })
    const skipped = sheet.getByText('1 to change · 12 skipped', { selector: 'summary' })
    // The whole list, not a first few: the form is the one scroller.
    expect(within(skipped.parentElement!).getAllByRole('listitem').map(item => item.textContent)).toEqual(unasked.map(row => row.queryText))
  })
})

describe('Change Subject', () => {
  it('opens on the Subject the row has, with Review off, and Company off', () => {
    installApi()
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market] })
    expect(screen.getByRole('dialog', { name: 'Change Subject' })).toBeTruthy()
    expect(checked(sheet, 'Subject')).toBe('Market')
    expect(sheet.getByText('Uptown · Market', { selector: 'summary' })).toBeTruthy()
    expect(reviewButton(sheet).disabled).toBe(true)

    const company = within(sheet.getByRole('radiogroup', { name: 'Subject' })).getByRole('radio', { name: 'Company' })
    expect(company.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(company.getAttribute('aria-describedby')!)!.textContent).toBe('Not available yet')
    fireEvent.click(company)
    expect(checked(sheet, 'Subject')).toBe('Market')
    // A hover title shows on neither a tap nor keyboard focus, so the help beside the control says it too.
    expect(sheet.getByRole('button', { name: 'Company is not available yet.' })).toBeTruthy()
    // A press on the Subject it already has keeps the place.
    choose(sheet, 'Subject', 'Market')
    expect(sheet.getByText('Uptown · Market', { selector: 'summary' })).toBeTruthy()
  })

  it('sends one removal and one addition for a location, with the markets it counts in', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market] })
    choose(sheet, 'Subject', 'Location')
    // A query has one Subject, so the market is dropped and Review waits for a location.
    expect(reviewButton(sheet).disabled).toBe(true)
    pick(sheet, 'Choose a location', 'Harbor Point')
    expect(sheet.getByText('Counts in: Uptown, Downtown')).toBeTruthy()
    expect(sheet.getByRole('button', { name: "Asked with these markets' engines and search locations." })).toBeTruthy()
    expect(sheet.queryByText('Type sets Subject')).toBeNull()
    expect(await review(sheet, writes)).toStrictEqual({
      ...version,
      additions: [{ input: { source: 'manual', text: 'best apartments uptown' }, audience: { targetKeys: ['harbor'], marketKeys: ['uptown', 'downtown'] } }],
      removals: [{ queryId: 'q-uptown' }],
    })
  })

  it('sends one removal and one addition for another market, and nothing for the market it has', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market] })
    pick(sheet, 'Uptown · Market', 'Downtown')
    expect(await review(sheet, writes)).toStrictEqual({
      ...version,
      additions: [{ input: { source: 'manual', text: 'best apartments uptown' }, audience: { marketKeys: ['downtown'] } }],
      removals: [{ queryId: 'q-uptown' }],
    })
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    pick(sheet, 'Downtown · Market', 'Uptown')
    expect(reviewButton(sheet).disabled).toBe(true)
  })

  it('sends an operator-set type with the addition and starts a hand-picked row with no place', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.operatorSet] })
    expect(checked(sheet, 'Subject')).toBe('Location')
    choose(sheet, 'Subject', 'Market')
    pick(sheet, 'Choose a market', 'Uptown')
    expect((await review(sheet, writes)).additions).toStrictEqual([{ input: { source: 'manual', text: 'Harbor Point parking' }, audience: { marketKeys: ['uptown'] }, queryClass: 'non-brand' }])

    cleanup()
    const picked = renderSheet({ action: 'change-subject', rows: [rows.handPicked] }).sheet
    expect(checked(picked, 'Subject')).toBe('Market')
    expect(picked.getByText('Choose a market').closest('summary')).not.toBeNull()
    expect(reviewButton(picked).disabled).toBe(true)
  })

  it('drops the chosen place on a Subject change, even when a location has the market\'s key', () => {
    installApi()
    const shared = { ...workspace, scopeOptions: [...workspace.scopeOptions!, { id: 'uptown', label: 'Uptown House', kind: 'property' as const, targetCount: 1 }] }
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market], workspace: shared })
    choose(sheet, 'Subject', 'Location')
    expect(sheet.getByText('Choose a location').closest('summary')).not.toBeNull()
    expect(reviewButton(sheet).disabled).toBe(true)
  })

  it('warns that the type sets the Subject when the new place is a one-location market', () => {
    installApi()
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market] })
    pick(sheet, 'Uptown · Market', 'Solo')
    const note = sheet.getByRole('button', { name: /^Type sets Subject\. In a market with one location, the type decides the Subject\./ })
    // A caution here, not a tip: the publish can land as the other Subject than the one picked.
    expect(note.className).toContain('text-caution')
    choose(sheet, 'Subject', 'Location')
    pick(sheet, 'Choose a location', 'Pier House')
    expect(sheet.getByText('Counts in: Solo')).toBeTruthy()
    expect(sheet.getByRole('button', { name: /^Type sets Subject\./ }).className).toContain('text-caution')
  })

  it('counts a location\'s markets past two and names them in the help', () => {
    installApi()
    // River Point in three markets: the names would run to several lines on a phone.
    const edge = { executionNodeKey: 'node-q-river', targetKey: 'river', queryId: 'q-river' }
    const wide = { ...workspace, markets: workspace.markets.map(market => market.stableKey === 'uptown' ? market : { ...market, usageEdges: [...market.usageEdges, edge] }) }
    const { sheet } = renderSheet({ action: 'change-subject', rows: [rows.market], workspace: wide })
    choose(sheet, 'Subject', 'Location')
    pick(sheet, 'Choose a location', 'River Point')
    expect(sheet.getByText('Counts in 3 markets')).toBeTruthy()
    expect(sheet.getByRole('button', { name: "Uptown, Downtown, Solo. Asked with these markets' engines and search locations." })).toBeTruthy()
  })

  it.each([
    ['market', 'Market', 'No markets yet', rows.handPicked],
    ['property', 'Location', 'No locations yet', rows.location],
  ] as const)('says a project has no %s to choose and keeps Review off', (kind, label, none, row) => {
    const writes = installApi()
    const empty = { ...workspace, scopeOptions: workspace.scopeOptions!.filter(option => option.kind !== kind) }
    const { sheet } = renderSheet({ action: 'change-subject', rows: [row], workspace: empty })
    expect(checked(sheet, 'Subject')).toBe(label)
    // The field keeps its label over the note, so the note does not read as a caption of the Subject control.
    const note = sheet.getByText(none)
    expect(note.closest('div')!.textContent).toBe(`${label}${none}`)
    expect(sheet.queryByText(`Choose a ${label.toLowerCase()}`)).toBeNull()
    expect(reviewButton(sheet).disabled).toBe(true)
    fireEvent.click(reviewButton(sheet))
    expect(writes).toEqual([])
  })
})

describe('Move to another location', () => {
  it('shows the location picker alone, on the location the query has', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'move-location', rows: [rows.location] })
    expect(screen.getByRole('dialog', { name: 'Move to another location' })).toBeTruthy()
    expect(sheet.queryByRole('radiogroup', { name: 'Subject' })).toBeNull()
    expect(reviewButton(sheet).disabled).toBe(true)
    pick(sheet, 'Harbor Point · Location', 'River Point')
    expect(sheet.getByText('Counts in: Uptown')).toBeTruthy()
    expect(await review(sheet, writes)).toStrictEqual({
      ...version,
      additions: [{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { targetKeys: ['river'], marketKeys: ['uptown'] } }],
      removals: [{ queryId: 'q-harbor' }],
    })
  })

  it('needs a search location and engines for a location in no market', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'move-location', rows: [rows.location] })
    pick(sheet, 'Harbor Point · Location', 'Lone Pine')
    expect(sheet.getByRole('button', { name: /^In no market\./ }).textContent).toBe('In no market')
    expect(reviewButton(sheet).disabled).toBe(true)
    const select = sheet.getByLabelText('Search location and engines')
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose one', ...contextChoices.map(choice => choice.label)])
    fireEvent.change(select, { target: { value: contextChoices[1]!.label } })
    expect(await review(sheet, writes)).toStrictEqual({
      ...version,
      additions: [{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { targetKeys: ['lone'] }, contexts: [contextChoices[1]!.input] }],
      removals: [{ queryId: 'q-harbor' }],
    })
  })

  it('takes the only search location and engines without asking, and stays off when there is none', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'move-location', rows: [rows.location], contextChoices: [contextChoices[0]!] })
    pick(sheet, 'Harbor Point · Location', 'Lone Pine')
    expect(sheet.queryByLabelText('Search location and engines')).toBeNull()
    expect(sheet.getByText(`Search location and engines: ${contextChoices[0]!.label}`)).toBeTruthy()
    expect((await review(sheet, writes)).additions).toStrictEqual([{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { targetKeys: ['lone'] }, contexts: [contextChoices[0]!.input] }])

    cleanup()
    const none = renderSheet({ action: 'move-location', rows: [rows.location], contextChoices: [] }).sheet
    pick(none, 'Harbor Point · Location', 'Lone Pine')
    expect(none.getByRole('button', { name: /^No search location\./ }).textContent).toBe('No search location')
    expect(reviewButton(none).disabled).toBe(true)
  })
})

describe('review step', () => {
  it.each(['preview', 'commit'] as const)('keeps a refused %s in the sheet with the server message and Review again', async refused => {
    let stale = true
    const writes = installApi(write => {
      if (write.operation !== refused || !stale) return undefined
      stale = false
      return refusal()
    })
    const { sheet, onClose, onPublished } = renderSheet({ action: 'stop', rows: [rows.market] })
    fireEvent.click(reviewButton(sheet))
    if (refused === 'commit') fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))

    const message = `Could not ${refused === 'preview' ? 'review' : 'confirm'} tracking changes. Workspace changed. Review again.`
    await waitFor(() => expect(sheet.getByRole('alert').textContent).toBe(message))
    expect(onClose).not.toHaveBeenCalled()
    // Back shows the form again with the refusal still beside it.
    fireEvent.click(sheet.getByRole('button', { name: 'Back' }))
    expect(sheet.getByRole('alert').textContent).toBe(message)
    expect(sheet.getByText('best apartments uptown')).toBeTruthy()

    fireEvent.click(reviewButton(sheet))
    fireEvent.click(await sheet.findByRole('button', { name: 'Publish 1 change' }))
    await waitFor(() => expect(onPublished).toHaveBeenCalledOnce())
    const body = { ...version, additions: [], removals: [{ queryId: 'q-uptown' }] }
    // Both reviews carry the same change, each against the workspace version the form holds.
    expect(writes.filter(write => write.operation === 'preview').map(write => write.body)).toStrictEqual([body, body])
    expect(writes.at(-1)).toStrictEqual({ operation: 'commit', body: { ...body, expectedWorkspaceVersion: reviewedVersion, previewToken, reviewedAt } })
  })

  it('shows Reviewing while a review is out, sends no second one, and never shows the review of an older form', async () => {
    let answer: (() => void) | undefined
    const writes = installApi(write => writes.length === 1
      ? new Promise<Response>(resolve => { answer = () => resolve(jsonResponse(preview(write.body))) })
      : undefined)
    const { sheet } = renderSheet({ action: 'stop', rows: [rows.handPicked], place: uptownPlace })
    fireEvent.click(reviewButton(sheet))
    const reviewing = await sheet.findByRole<HTMLButtonElement>('button', { name: 'Reviewing…' })
    expect(reviewing.disabled).toBe(true)
    fireEvent.click(reviewing)
    expect(writes.map(write => write.body.removals)).toStrictEqual([[{ queryId: 'q-picked', audience: { marketKeys: ['uptown'] } }]])

    // The form changes while that review is still out: its answer is for a narrower change than the form now shows.
    choose(sheet, 'Applies to', 'Everywhere')
    await act(async () => { answer!() })
    await waitFor(() => expect(reviewButton(sheet).disabled).toBe(false))
    expect(sheet.queryByRole('heading', { name: /^Review \d+ changes?$/ })).toBeNull()
    expect(sheet.queryByRole('button', { name: /^Publish/ })).toBeNull()

    // The next review is of the form as it stands.
    expect((await review(sheet, writes)).removals).toStrictEqual([{ queryId: 'q-picked' }])
    fireEvent.click(sheet.getByRole('button', { name: 'Publish 1 change' }))
    await waitFor(() => expect(writes.at(-1)!.operation).toBe('commit'))
    expect(writes.at(-1)!.body.removals).toStrictEqual([{ queryId: 'q-picked' }])
  })

  it('sends the same change again from Review again', async () => {
    let stale = true
    const writes = installApi(write => {
      if (!stale) return undefined
      stale = false
      return write.operation === 'preview' ? refusal() : undefined
    })
    const { sheet } = renderSheet({ action: 'change-type', rows: [rows.handPicked] })
    choose(sheet, 'Type', 'Non-brand')
    fireEvent.click(reviewButton(sheet))
    fireEvent.click(await sheet.findByRole('button', { name: 'Review again' }))
    await sheet.findByRole('heading', { name: 'Review 1 change' })
    const body = { ...version, additions: [], removals: [], edits: [{ queryId: 'q-picked', queryClass: 'non-brand' }] }
    expect(writes).toStrictEqual([{ operation: 'preview', body }, { operation: 'preview', body }])
  })

  it('sends the reviewed change as it was when its place is gone from the refreshed workspace', async () => {
    const writes = installApi(write => writes.length === 1 && write.operation === 'preview' ? refusal() : undefined)
    const { sheet, show } = renderSheet({ action: 'change-subject', rows: [rows.market] })
    pick(sheet, 'Uptown · Market', 'Downtown')
    fireEvent.click(reviewButton(sheet))
    const again = await sheet.findByRole('button', { name: 'Review again' })

    // Read again, the workspace has a new version and no Downtown: the form cannot be rebuilt, so the server gets to say why.
    const refreshed = `qtw_${'e'.repeat(64)}`
    show({ workspace: { ...workspace, workspaceVersion: refreshed, scopeOptions: workspace.scopeOptions!.filter(option => option.id !== 'downtown') } })
    fireEvent.click(again)
    await sheet.findByRole('heading', { name: 'Review 1 change' })
    const change = { additions: [{ input: { source: 'manual', text: 'best apartments uptown' }, audience: { marketKeys: ['downtown'] } }], removals: [{ queryId: 'q-uptown' }] }
    expect(writes.map(write => write.body)).toStrictEqual([{ ...version, ...change }, { expectedWorkspaceVersion: refreshed, ...change }])
  })

  it('builds the change again from the refreshed workspace on Review again', async () => {
    const writes = installApi(write => writes.length === 1 && write.operation === 'preview' ? refusal() : undefined)
    const { sheet, show } = renderSheet({ action: 'move-location', rows: [rows.location] })
    pick(sheet, 'Harbor Point · Location', 'River Point')
    fireEvent.click(reviewButton(sheet))
    const again = await sheet.findByRole('button', { name: 'Review again' })

    // Read again, River Point is in Downtown too: the query must count there as well, which the first review did not say.
    const refreshed = `qtw_${'e'.repeat(64)}`
    const edge = { executionNodeKey: 'node-q-river', targetKey: 'river', queryId: 'q-river' }
    show({ workspace: { ...workspace, workspaceVersion: refreshed, markets: workspace.markets.map(market => market.stableKey === 'downtown' ? { ...market, usageEdges: [...market.usageEdges, edge] } : market) } })
    fireEvent.click(again)
    await sheet.findByRole('heading', { name: 'Review 1 change' })
    const change = (marketKeys: string[]) => ({ additions: [{ input: { source: 'manual', text: 'Harbor Point reviews' }, audience: { targetKeys: ['river'], marketKeys } }], removals: [{ queryId: 'q-harbor' }] })
    expect(writes.map(write => write.body)).toStrictEqual([{ ...version, ...change(['uptown']) }, { expectedWorkspaceVersion: refreshed, ...change(['uptown', 'downtown']) }])
  })

  it('pauses Publish while a sweep is queued or running', async () => {
    const writes = installApi()
    const { sheet } = renderSheet({ action: 'stop', rows: [rows.market], sweepActive: true })
    await review(sheet, writes)
    expect(sheet.getByRole<HTMLButtonElement>('button', { name: 'Publish 1 change' }).disabled).toBe(true)
    expect(sheet.getByRole('status').textContent).toBe('Sweep running')
    expect(within(sheet.getByRole('status')).getByRole('button', { name: 'Sweep running. A sweep is queued or running. Publish after it finishes.' })).toBeTruthy()
  })

  it.each(['stop', 'edit-wording', 'change-type', 'change-subject', 'move-location', 'remove'] as const)('draws no %s sheet for a viewer, so there is no dead control', action => {
    const writes = installApi()
    renderSheet({ action, rows: [rows.location] }, 'viewer')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(writes).toEqual([])
  })

  it('starts the form again when the action or the rows change, so one row never takes another\'s text', () => {
    installApi()
    const { sheet: first, show } = renderSheet({ action: 'edit-wording', rows: [rows.market] })
    fireEvent.change(first.getByLabelText('Query'), { target: { value: 'best apartments in uptown' } })
    expect(reviewButton(first).disabled).toBe(false)

    show({ rows: [rows.location] })
    const next = within(screen.getByRole('dialog', { name: 'Edit wording' }))
    expect(next.getByLabelText<HTMLTextAreaElement>('Query').value).toBe('Harbor Point reviews')
    expect(reviewButton(next).disabled).toBe(true)

    // Another action on the same row starts again too: a choice made for one is not carried into the next.
    show({ rows: [rows.handPicked], action: 'stop', place: uptownPlace })
    const stop = within(screen.getByRole('dialog', { name: 'Stop tracking' }))
    choose(stop, 'Applies to', 'Everywhere')
    show({ rows: [rows.handPicked], action: 'change-type', place: uptownPlace })
    expect(checked(within(screen.getByRole('dialog', { name: 'Change type' })), 'Applies to')).toBe('Only Uptown')

    // The same action and rows read again keep the form: a refreshed workspace hands over new row objects.
    show({ rows: [rows.location], action: 'edit-wording' })
    const kept = within(screen.getByRole('dialog', { name: 'Edit wording' }))
    fireEvent.change(kept.getByLabelText('Query'), { target: { value: 'Harbor Point tenant reviews' } })
    show({ rows: [{ ...rows.location }], action: 'edit-wording' })
    expect(within(screen.getByRole('dialog')).getByLabelText<HTMLTextAreaElement>('Query').value).toBe('Harbor Point tenant reviews')
  })
})

describe('focus', () => {
  it('closes the open place picker on Escape before the sheet', () => {
    installApi()
    const { sheet, onClose } = renderSheet({ action: 'move-location', rows: [rows.location] })
    fireEvent.click(sheet.getByText('Harbor Point · Location').closest('summary')!)
    const search = sheet.getByRole('searchbox', { name: 'Search places' })
    const picker = search.closest('details')!
    expect(picker.open).toBe(true)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(picker.open).toBe(false)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('returns to the control that opened the sheet when it closes', async () => {
    installApi()
    function Opened() {
      const [open, setOpen] = useState(false)
      const queryClient = new QueryClient()
      return <QueryClientProvider client={queryClient}>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        {open ? <TrackedActionSheet projectName="demo" workspace={workspace} action="stop" rows={[rows.market]} contextChoices={contextChoices} sweepActive={false} onClose={() => setOpen(false)} /> : null}
      </QueryClientProvider>
    }
    render(<Opened />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop tracking' })).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
