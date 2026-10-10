import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingLimits, QueryTrackingSummary } from '@ainyc/canonry-contracts'

import { TrackedSummaryGrid, TrackedSummaryGridSkeleton, type TrackedSummaryPlace } from '../src/components/project/queries/advanced/TrackedSummaryGrid.js'
import { visibleText } from './caution-note.js'
import { compileAppStyles, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'

afterEach(cleanup)

// No number here can be worked out from the others: asked is not a sum of its types or its Subjects, the
// links are not a sum of theirs, and what is left is not the limit less the count. Only printing the
// server's own field gives each cell its number.
const SUMMARY: QueryTrackingSummary = {
  asked: 932,
  notAsked: 38,
  byClass: { branded: 384, nonBrand: 541, mixed: 0, unknown: 0 },
  byFocus: { market: 547, property: 371, company: 0, custom: 12 },
  assignments: { total: 2412, branded: 390, nonBrand: 2017, unknown: 5 },
  answersPerSweep: 2796,
  structure: { targets: 192, markets: 137, groups: 14, topLevelGroups: 9, competitors: 61 },
}
const LIMITS: QueryTrackingLimits = { queries: { current: 932, next: 932, max: 1000, left: { current: 61, next: 61 } } }
const LAST_SWEEP = '2026-10-07T15:00:00.000Z'

/** The number under a label, as it reads. */
const stat = (label: string, scope: HTMLElement = document.body) => within(scope).getByText(label).closest('div')!.querySelector('dd')!.textContent
/** Every label of a list of numbers, in order. */
const labels = (list: HTMLElement) => [...list.querySelectorAll('dt')].map(term => term.firstChild!.textContent)
const details = () => screen.getByRole('button', { name: 'Details' })
const detailsList = () => document.getElementById(details().getAttribute('aria-controls')!)!

describe('TrackedSummaryGrid, project strip', () => {
  test('prints the server\'s own fields, branded and non-brand in separate cells', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" />)
    expect(labels(container.querySelector('dl')!)).toEqual(['Queries asked', 'Non-brand', 'Branded', 'Answers per sweep', 'Left under limit'])
    expect(stat('Queries asked')).toBe('932')
    expect(stat('Non-brand')).toBe('541')
    expect(stat('Branded')).toBe('384')
    expect(stat('Answers per sweep')).toBe('2,796')
    // The server's `left.current`, never the limit less the count (which would read 68).
    expect(stat('Left under limit')).toBe('61 of 1,000')
    expect(visibleText(container)).not.toContain('68')
  })

  test('says when the last sweep was and when the next one is', () => {
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" />)
    expect(screen.getByText('Last sweep Oct 7').parentElement!.textContent).toBe('Last sweep Oct 7·Next Oct 21')

    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={null} nextSweepDate="Oct 21" />)
    expect(screen.getByText('Last sweep: none').parentElement!.textContent).toBe('Last sweep: none·Next Oct 21')

    // No date is named: the Next part is left out, with no dot left behind.
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} />)
    expect(screen.getByText('Last sweep Oct 7').parentElement!.textContent).toBe('Last sweep Oct 7')

    // Not known yet: the strip does not claim there was none.
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} nextSweepDate="Oct 21" />)
    expect(screen.queryByText(/Last sweep/)).toBeNull()
    expect(screen.getByText('Next Oct 21')).toBeTruthy()
  })

  test('a running sweep takes the place of the next date', () => {
    render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" sweepActive />)
    const note = screen.getByRole('button', { name: /^Sweep running\. / })
    expect(note.textContent).toBe('Sweep running')
    expect(screen.getByText('Last sweep Oct 7').parentElement!.textContent).toBe('Last sweep Oct 7·Sweep running')
    expect(screen.queryByText(/Next/)).toBeNull()
  })

  test('a spent limit reads Limit reached, with the limit behind it', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={{ queries: { current: 1004, next: 1004, max: 1000, left: { current: 0, next: 0 } } }} />)
    expect(stat('Left under limit')).toBe('Limit reached')
    expect(screen.getByRole('button', { name: 'Limit reached. The limit is 1,000 queries. Stop tracking one to add another.' })).toBeTruthy()
    expect(visibleText(container)).not.toContain('of 1,000')
  })

  test('leaves out Left under limit when the server sent no limit or no count of what is left', () => {
    const { container, rerender } = render(<TrackedSummaryGrid summary={SUMMARY} />)
    expect(labels(container.querySelector('dl')!)).toEqual(['Queries asked', 'Non-brand', 'Branded', 'Answers per sweep'])
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={{ queries: { current: 932, next: 932, max: 1000 } }} />)
    expect(screen.queryByText('Left under limit')).toBeNull()
  })

  test('Details is closed until asked for, then lists the rarer numbers', () => {
    render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} />)
    expect(details().getAttribute('aria-expanded')).toBe('false')
    expect(detailsList().hidden).toBe(true)

    fireEvent.click(details())
    expect(details().getAttribute('aria-expanded')).toBe('true')
    expect(detailsList().hidden).toBe(false)
    expect(labels(detailsList())).toEqual(['Market', 'Location', 'Hand-picked', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'])
    expect(['Market', 'Location', 'Hand-picked', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'].map(label => stat(label, detailsList())))
      .toEqual(['547', '371', '12', '38', '2,412', '2,017', '390'])

    fireEvent.click(details())
    expect(detailsList().hidden).toBe(true)
  })

  test('Company, Mixed type and Not set show only above zero', () => {
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} />)
    for (const label of ['Company', 'Mixed type', 'Not set']) expect(within(detailsList()).queryByText(label)).toBeNull()

    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, byFocus: { ...SUMMARY.byFocus, company: 7 } }} limits={LIMITS} />)
    expect(labels(detailsList())).toEqual(['Market', 'Location', 'Hand-picked', 'Company', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'])
    expect(stat('Company', detailsList())).toBe('7')

    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, byClass: { ...SUMMARY.byClass, mixed: 5, unknown: 2 } }} limits={LIMITS} />)
    expect(labels(detailsList())).toEqual(['Market', 'Location', 'Hand-picked', 'Mixed type', 'Not set', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'])
    expect([stat('Mixed type', detailsList()), stat('Not set', detailsList())]).toEqual(['5', '2'])
  })

  test('the not-asked count sets Status to Not asked, and is absent at zero', () => {
    const onShowNotAsked = vi.fn()
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} onShowNotAsked={onShowNotAsked} />)
    fireEvent.click(screen.getByRole('button', { name: '38 not asked' }))
    expect(onShowNotAsked).toHaveBeenCalledTimes(1)

    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, notAsked: 0 }} limits={LIMITS} onShowNotAsked={onShowNotAsked} />)
    expect(screen.queryByText(/not asked$/)).toBeNull()
    // Details still counts it, as a number among the others.
    expect(stat('Not asked', detailsList())).toBe('0')

    // With nothing to set, the count is text, not a button that does nothing.
    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, notAsked: 1204 }} limits={LIMITS} />)
    expect(screen.getByText('1,204 not asked').tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: /not asked/ })).toBeNull()
  })

  test('without the numbers it says so and offers Retry, and still dates the sweeps', () => {
    const onRetry = vi.fn()
    const { container, rerender } = render(<TrackedSummaryGrid summary={undefined} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" onRetry={onRetry} />)
    expect(screen.getByRole('button', { name: /^Numbers unavailable\. / }).textContent).toBe('Numbers unavailable')
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(screen.getByText('Last sweep Oct 7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<TrackedSummaryGrid summary={undefined} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('TrackedSummaryGrid, place strip', () => {
  const market: TrackedSummaryPlace = { kind: 'market', market: { stableKey: 'm1', label: 'Harbor District', usageEdges: [], targetKeys: ['t1', 't2', 't3'], counts: { marketQueries: 4, propertyQueries: 6, answersPerSweep: 31 } } }
  const location: TrackedSummaryPlace = { kind: 'location', target: { stableKey: 't1', label: 'Acme Homes Harbor Point', marketKeys: ['m1', 'm2'], counts: { propertyQueries: 2, marketQueries: 8, customQueries: 0, answersPerSweep: 29 } } }
  const group: TrackedSummaryPlace = { kind: 'group', group: { stableKey: 'g1', label: 'Northbridge', targetKeys: Array.from({ length: 23 }, (_, index) => `t${index}`), counts: { queries: 118, markets: 17, answersPerSweep: 354 } } }
  const numbers = (container: HTMLElement) => labels(container.querySelector('dl')!).map(label => [label, stat(label!)])

  test('a market prints its own counts and how many locations it lists', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={market} />)
    expect(numbers(container)).toEqual([['Market queries', '4'], ['Location queries', '6'], ['Locations', '3'], ['Answers per sweep', '31']])
  })

  test('a location prints its own counts and how many markets it is in', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={location} />)
    expect(numbers(container)).toEqual([['Location queries', '2'], ['Market queries', '8'], ['Markets', '2'], ['Answers counted', '29']])
  })

  test('a location\'s hand-picked queries show only above zero', () => {
    const picked: TrackedSummaryPlace = { kind: 'location', target: { ...location.target, counts: { ...location.target.counts!, customQueries: 3 } } }
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} place={picked} />)
    expect(numbers(container)).toEqual([['Location queries', '2'], ['Market queries', '8'], ['Hand-picked', '3'], ['Markets', '2'], ['Answers counted', '29']])
  })

  test('a group prints its own counts and how many locations it lists', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={group} />)
    expect(numbers(container)).toEqual([['Queries', '118'], ['Locations', '23'], ['Markets', '17'], ['Answers per sweep', '354']])
  })

  test('a place shows none of the project\'s numbers, Details or not-asked count, and keeps the sweep dates', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={market} lastSweepAt={LAST_SWEEP} sweepActive onShowNotAsked={() => {}} />)
    expect(screen.queryByText('Queries asked')).toBeNull()
    expect(screen.queryByText('Left under limit')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(visibleText(container)).not.toContain('not asked')
    expect(screen.getByText('Last sweep Oct 7').parentElement!.textContent).toBe('Last sweep Oct 7·Sweep running')
  })

  test('a list the server left out gives no cell, and no counts gives no numbers', () => {
    const { container, rerender } = render(<TrackedSummaryGrid summary={SUMMARY} place={{ kind: 'market', market: { ...market.market, targetKeys: undefined } }} />)
    expect(numbers(container)).toEqual([['Market queries', '4'], ['Location queries', '6'], ['Answers per sweep', '31']])

    rerender(<TrackedSummaryGrid summary={SUMMARY} place={{ kind: 'group', group: { ...group.group, counts: undefined } }} />)
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.getByRole('button', { name: /^Numbers unavailable\. / })).toBeTruthy()
  })
})

describe('TrackedSummaryGrid, layout', () => {
  const rulesFor = async (container: HTMLElement) => parseCompiledCss(await compileAppStyles([...container.querySelectorAll('*')].flatMap(element => [...element.classList])))
  const WIDE = '@container (width >= 52rem)'
  const NARROW = '@container (width < 52rem)'

  test('is one row of cells in a wide strip and pairs of cells in a narrow one, decided by the strip\'s own width', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} />)
    const rules = await rulesFor(container)
    const root = container.firstElementChild!
    const row = root.firstElementChild!
    const cells = [...container.querySelector('dl')!.children]
    expect(compiledElementProperty(rules, root, 'container-type')).toBe('inline-size')
    expect([compiledElementProperty(rules, row, 'display'), compiledElementProperty(rules, row, 'grid-template-columns')]).toEqual(['grid', 'repeat(2, minmax(0, 1fr))'])
    expect(compiledElementProperty(rules, row, 'display', WIDE)).toBe('flex')
    // In the row no cell is squeezed under its own label and number, so a label never wraps.
    expect(cells.map(cell => compiledElementProperty(rules, cell, 'min-width', WIDE))).toEqual(Array(5).fill('max-content'))
    // Five numbers: the first takes a row to itself in the narrow strip, so the rest pair up.
    expect(cells.map(cell => compiledElementProperty(rules, cell, 'grid-column', NARROW))).toEqual(['span 2 / span 2', undefined, undefined, undefined, undefined])
  })

  test('an even count of numbers pairs up from the first cell', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} />)
    const rules = await rulesFor(container)
    expect([...container.querySelector('dl')!.children].map(cell => compiledElementProperty(rules, cell, 'grid-column', NARROW))).toEqual([undefined, undefined, undefined, undefined])
  })

  test('the skeleton is the same strip with nothing to read', async () => {
    const { container } = render(<><TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} /><TrackedSummaryGridSkeleton /></>)
    const [grid, skeleton] = [...container.children] as [HTMLElement, HTMLElement]
    expect(skeleton.getAttribute('aria-hidden')).toBe('true')
    expect(skeleton.textContent).toBe('')
    // The same row, cell for cell, so nothing moves when the numbers land.
    expect([...skeleton.firstElementChild!.children].map(cell => cell.className)).toEqual([...grid.querySelector('dl')!.children, grid.firstElementChild!.lastElementChild!].map(cell => cell.className))
  })
})
