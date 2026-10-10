import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { QueryTrackingLimits, QueryTrackingSummary } from '@ainyc/canonry-contracts'

import { TrackedSummaryGrid, TrackedSummaryGridSkeleton, type TrackedSummaryPlace } from '../src/components/project/queries/advanced/TrackedSummaryGrid.js'
import { TrackedToolbar } from '../src/components/project/queries/advanced/TrackedToolbar.js'
import { parseTrackedFilters, trackedFiltersPatch } from '../src/components/project/queries/advanced/tracked-filters.js'
import { formatObservedInstantLabel, formatObservedInstantMonthDay, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { visibleText } from './caution-note.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

// The strip dates a sweep against today's year, so today is fixed. Only the clock is faked: nothing here waits on a timer.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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
// The strip dates a sweep in the viewer's own timezone, so the day it names is read the same way here: the 7th in most zones, the 8th east of UTC+9.
const LAST_SWEEP_DAY = formatObservedInstantMonthDay(observedInstant(LAST_SWEEP))
const DETAIL_LABELS = ['Market queries', 'Location queries', 'Hand-picked queries', 'Not asked', 'Location links', 'Non-brand links', 'Branded links']

/** The number under a label, as it reads. */
const stat = (label: string, scope: HTMLElement = document.body) => within(scope).getByText(label).closest('div')!.querySelector('dd')!.textContent
/** Every label of a list of numbers, in order. */
const labels = (list: HTMLElement) => [...list.querySelectorAll('dt')].map(term => term.firstChild!.textContent)
const details = () => screen.getByRole('button', { name: 'Details' })
const detailsList = () => document.getElementById(details().getAttribute('aria-controls')!)!
/** The sweep dates as they read, with the dot between two of them. */
const sweepLine = () => screen.getByText(/^Last sweep/).closest('p')!
/** The label a help button stands beside. */
const helpFor = (text: string) => screen.getByRole('button', { name: text }).closest('dt')!.firstChild!.textContent

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
    expect(helpFor('Answers one sweep collects: each query on every engine and search location it is asked on.')).toBe('Answers per sweep')
  })

  test('says when the last sweep was and when the next one is', () => {
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" />)
    expect(sweepLine().textContent).toBe(`Last sweep ${LAST_SWEEP_DAY}·Next Oct 21`)

    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={null} nextSweepDate="Oct 21" />)
    expect(sweepLine().textContent).toBe('Last sweep: none·Next Oct 21')

    // No date is named: the Next part is left out, with no dot left behind.
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} />)
    expect(sweepLine().textContent).toBe(`Last sweep ${LAST_SWEEP_DAY}`)

    // Not known yet: the strip does not claim there was none.
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} nextSweepDate="Oct 21" />)
    expect(screen.queryByText(/Last sweep/)).toBeNull()
    expect(screen.getByText('Next Oct 21')).toBeTruthy()
  })

  test('a sweep in this year is dated by month and day; one from another year keeps its year', () => {
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" />)
    expect(sweepLine().textContent).not.toContain('2026')

    // A year and three days ago: without its year it would read as this week's sweep.
    const lastYear = '2025-10-07T15:00:00.000Z'
    const dated = formatObservedInstantLabel(observedInstant(lastYear))
    expect(dated).toContain('2025')
    rerender(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={lastYear} nextSweepDate="Oct 21" />)
    expect(sweepLine().textContent).toBe(`Last sweep ${dated}·Next Oct 21`)
  })

  test('a running sweep takes the place of the next date, and its icon turns', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" sweepActive />)
    const note = screen.getByRole('button', { name: /^Sweep running\. / })
    expect(note.textContent).toBe('Sweep running')
    expect(sweepLine().textContent).toBe(`Last sweep ${LAST_SWEEP_DAY}·Sweep running`)
    expect(screen.queryByText(/Next/)).toBeNull()

    // A spinner that stands still reads as stalled. It holds still only where motion is reduced.
    const rules = await rulesFor(container)
    const icon = note.querySelector('svg')!
    expect([compiledElementProperty(rules, icon, 'animation'), compiledElementProperty(rules, icon, 'animation', '@media (prefers-reduced-motion: no-preference)')]).toEqual([undefined, 'var(--animate-spin)'])
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

  test('Details is closed until asked for, then lists the rarer numbers, each Subject named as queries', () => {
    render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} />)
    expect(details().getAttribute('aria-expanded')).toBe('false')
    expect(detailsList().hidden).toBe(true)

    fireEvent.click(details())
    expect(details().getAttribute('aria-expanded')).toBe('true')
    expect(detailsList().hidden).toBe(false)
    expect(labels(detailsList())).toEqual(DETAIL_LABELS)
    expect(DETAIL_LABELS.map(label => stat(label, detailsList()))).toEqual(['547', '371', '12', '38', '2,412', '2,017', '390'])
    expect(helpFor('One link for each query, location and search location it is asked for.')).toBe('Location links')

    fireEvent.click(details())
    expect(detailsList().hidden).toBe(true)
  })

  test('Company, Mixed type and Not set show only above zero', () => {
    const { rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} />)
    for (const label of ['Company queries', 'Mixed type', 'Not set']) expect(within(detailsList()).queryByText(label)).toBeNull()

    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, byFocus: { ...SUMMARY.byFocus, company: 7 } }} limits={LIMITS} />)
    expect(labels(detailsList())).toEqual(['Market queries', 'Location queries', 'Hand-picked queries', 'Company queries', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'])
    expect(stat('Company queries', detailsList())).toBe('7')

    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, byClass: { ...SUMMARY.byClass, mixed: 5, unknown: 2 } }} limits={LIMITS} />)
    expect(labels(detailsList())).toEqual(['Market queries', 'Location queries', 'Hand-picked queries', 'Mixed type', 'Not set', 'Not asked', 'Location links', 'Non-brand links', 'Branded links'])
    expect([stat('Mixed type', detailsList()), stat('Not set', detailsList())]).toEqual(['5', '2'])
  })

  test('the not-asked count asks for the rows that are not asked, and is absent at zero', () => {
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

  test('beside the toolbar, the not-asked count sets Status to Not asked and leaves the other filters alone', () => {
    // The filters live in the URL search, as on the page: the strip patches it and the toolbar reads it back.
    function Host() {
      const [search, setSearch] = useState<Record<string, unknown>>({ trackedType: 'branded' })
      return <>
        <TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} onShowNotAsked={() => setSearch(current => ({ ...current, ...trackedFiltersPatch({ status: 'not-asked' }) }))} />
        <TrackedToolbar search="" onSearchChange={() => {}} filters={parseTrackedFilters(search)} onFiltersChange={filters => setSearch(trackedFiltersPatch(filters))} />
      </>
    }
    render(<Host />)
    const chosen = () => ['Subject', 'Type', 'Status', 'Source', 'Result'].map(name => screen.getByRole<HTMLSelectElement>('combobox', { name }).selectedOptions[0]!.textContent)
    expect(chosen()).toEqual(['Any', 'Branded', 'Measured + First answers', 'Any', 'Any'])
    fireEvent.click(screen.getByRole('button', { name: '38 not asked' }))
    expect(chosen()).toEqual(['Any', 'Branded', 'Not asked', 'Any', 'Any'])
  })

  test('without the numbers it says so and offers Retry, and still dates the sweeps', () => {
    const onRetry = vi.fn()
    const { container, rerender } = render(<TrackedSummaryGrid summary={undefined} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" onRetry={onRetry} />)
    expect(screen.getByRole('button', { name: 'Numbers unavailable. These numbers did not load.' }).textContent).toBe('Numbers unavailable')
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(sweepLine().textContent).toBe(`Last sweep ${LAST_SWEEP_DAY}·Next Oct 21`)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<TrackedSummaryGrid summary={undefined} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

const market: TrackedSummaryPlace = { kind: 'market', market: { stableKey: 'm1', label: 'Harbor District', usageEdges: [], targetKeys: ['t1', 't2', 't3'], counts: { marketQueries: 4, propertyQueries: 6, answersPerSweep: 31 } } }
const location: TrackedSummaryPlace = { kind: 'location', target: { stableKey: 't1', label: 'Acme Homes Harbor Point', marketKeys: ['m1', 'm2'], counts: { propertyQueries: 2, marketQueries: 8, customQueries: 0, answersPerSweep: 29 } } }
const group: TrackedSummaryPlace = { kind: 'group', group: { stableKey: 'g1', label: 'Northbridge', targetKeys: Array.from({ length: 23 }, (_, index) => `t${index}`), counts: { queries: 118, markets: 17, answersPerSweep: 354 } } }

describe('TrackedSummaryGrid, place strip', () => {
  const numbers = (container: HTMLElement) => labels(container.querySelector('dl')!).map(label => [label, stat(label!)])
  const PLACE_ANSWERS = 'Answers one sweep collects for this place. Places share answers, so they do not add up to the project total.'

  test('a market prints its own counts and how many locations it lists', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={market} />)
    expect(numbers(container)).toEqual([['Market queries', '4'], ['Location queries', '6'], ['Locations', '3'], ['Answers per sweep', '31']])
    expect(helpFor(PLACE_ANSWERS)).toBe('Answers per sweep')
  })

  test('a location prints its own counts and how many markets it is in', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={location} />)
    expect(numbers(container)).toEqual([['Location queries', '2'], ['Market queries', '8'], ['Markets', '2'], ['Answers counted', '29']])
    expect(helpFor('Answers per sweep that count for this location, its market queries included. Locations share answers, so they do not add up to the project total.')).toBe('Answers counted')
  })

  test('a location\'s hand-picked queries show only above zero', () => {
    const picked: TrackedSummaryPlace = { kind: 'location', target: { ...location.target, counts: { ...location.target.counts!, customQueries: 3 } } }
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} place={picked} />)
    expect(numbers(container)).toEqual([['Location queries', '2'], ['Market queries', '8'], ['Hand-picked queries', '3'], ['Markets', '2'], ['Answers counted', '29']])
  })

  test('a group prints its own counts and how many locations it lists', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={group} />)
    expect(numbers(container)).toEqual([['Queries', '118'], ['Locations', '23'], ['Markets', '17'], ['Answers per sweep', '354']])
    expect(helpFor(PLACE_ANSWERS)).toBe('Answers per sweep')
  })

  test('a place shows none of the project\'s numbers, Details or not-asked count, and keeps the sweep dates', () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} place={market} lastSweepAt={LAST_SWEEP} sweepActive onShowNotAsked={() => {}} />)
    expect(screen.queryByText('Queries asked')).toBeNull()
    expect(screen.queryByText('Left under limit')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    expect(visibleText(container)).not.toContain('not asked')
    expect(sweepLine().textContent).toBe(`Last sweep ${LAST_SWEEP_DAY}·Sweep running`)
  })

  test('a list the server left out gives no cell, and no counts gives no numbers', () => {
    const { container, rerender } = render(<TrackedSummaryGrid summary={SUMMARY} place={{ kind: 'market', market: { ...market.market, targetKeys: undefined } }} />)
    expect(numbers(container)).toEqual([['Market queries', '4'], ['Location queries', '6'], ['Answers per sweep', '31']])

    rerender(<TrackedSummaryGrid summary={SUMMARY} place={{ kind: 'group', group: { ...group.group, counts: undefined } }} />)
    expect(container.querySelector('dl')).toBeNull()
    expect(screen.getByRole('button', { name: /^Numbers unavailable\. / })).toBeTruthy()
  })
})

const rulesFor = async (container: HTMLElement) => parseCompiledCss(await compileAppStyles([...container.querySelectorAll('*')].flatMap(element => [...element.classList])))
type Rules = Awaited<ReturnType<typeof rulesFor>>
/**
 * What an element's classes set in one state, such as keyboard focus. Read from the compiled rule text: the
 * shared parser keeps a nested state rule but not the class it belongs to.
 */
async function stateStyle(element: Element, variant: string): Promise<Record<string, string>> {
  const classes = [...element.classList].filter(candidate => candidate.startsWith(`${variant}:`))
  const css = await compileAppStyles(classes)
  return Object.fromEntries(classes.flatMap(candidate => {
    const start = css.indexOf(`.${candidate.replace(/([^\w-])/g, '\\$1')} {`)
    const rule = css.slice(start, css.indexOf('}', start))
    expect(start >= 0 && rule.includes(`&:${variant}`), candidate).toBe(true)
    return [...rule.slice(rule.lastIndexOf('{') + 1).matchAll(/([\w-]+):([^;]+);/g)].map(([, property, value]) => [property!, value!.trim()])
  }))
}

describe('TrackedSummaryGrid, layout', () => {
  // The strip's own width decides its shape: pairs under 36rem, three columns from there, one row from 52rem.
  const PAIRS = '@container (width < 36rem)'
  const THREE = '@container (width >= 36rem)'
  const ROW = '@container (width >= 52rem)'
  const ROW_COLUMNS = 'repeat(var(--tracked-strip-columns),minmax(max-content,1fr))'
  const COARSE = '@media (pointer: coarse)'
  const BELOW_MD = '@media (width < 48rem)'
  const strip = (container: HTMLElement) => container.firstElementChild!.firstElementChild as HTMLElement
  const cellsOf = (container: HTMLElement) => [...container.querySelector('dl')!.children]
  const columns = (rules: Rules, element: Element, context?: string) => compiledElementProperty(rules, element, 'grid-template-columns', context)
  const span = (rules: Rules, element: Element, context?: string) => compiledElementProperty(rules, element, 'grid-column', context)
  const lineAbove = (rules: Rules, element: Element, context?: string) => compiledElementProperty(rules, element, 'border-top-width', context)
  const lineBefore = (rules: Rules, element: Element, context?: string) => compiledElementProperty(rules, element, 'border-left-width', context)

  test('is pairs of cells on a phone, three columns in a middling strip and one row in a wide one, by the strip\'s own width', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} />)
    const rules = await rulesFor(container)
    const cells = cellsOf(container)
    const last = details().parentElement!.parentElement!
    expect(compiledElementProperty(rules, container.firstElementChild!, 'container-type')).toBe('inline-size')
    expect([compiledElementProperty(rules, strip(container), 'display'), columns(rules, strip(container)), columns(rules, strip(container), THREE), columns(rules, strip(container), ROW)])
      .toEqual(['grid', 'repeat(2, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))', ROW_COLUMNS])
    // The row: a column for each number and two for the last cell, none narrower than its own label and number.
    expect(strip(container).style.getPropertyValue('--tracked-strip-columns')).toBe('7')
    // Five numbers: the first takes a row of the pairs to itself, so the rest pair up.
    expect(cells.map(cell => span(rules, cell, PAIRS))).toEqual(['span 2 / span 2', undefined, undefined, undefined, undefined])
    // The last cell is a row of the pairs, the sixth cell of three columns, and two columns of the row.
    expect([span(rules, last), span(rules, last, THREE), span(rules, last, ROW)]).toEqual(['span 2 / span 2', 'span 1 / span 1', 'span 2 / span 2'])

    // Hairlines. Pairs: a line over every row but the first. Three columns: a line over the second row, and before every column but the first.
    expect(cells.map(cell => [lineAbove(rules, cell), lineAbove(rules, cell, PAIRS)])).toEqual([[undefined, undefined], [undefined, '1px'], [undefined, '1px'], ['1px', undefined], ['1px', undefined]])
    expect(cells.map(cell => lineBefore(rules, cell, THREE))).toEqual([undefined, '1px', '1px', undefined, '1px'])
    expect([lineAbove(rules, last), lineBefore(rules, last, THREE)]).toEqual(['1px', '1px'])
    // The row: no line over any cell, and one before every cell but the first.
    expect([cells[3]!, cells[4]!, last].map(cell => lineAbove(rules, cell, ROW))).toEqual(['0px', '0px', '0px'])
    expect(lineBefore(rules, cells[3]!, ROW)).toBe('1px')
    // No cell holds its column wider than the strip gives it, so a phone has no sideways scroll (checked in a browser at 390px and 320px).
    expect([...cells, last].map(cell => cssLengthPx(compiledElementProperty(rules, cell, 'min-width')!, rules))).toEqual(Array(6).fill(0))
  })

  test('an even count of numbers pairs up from the first cell, and the last cell takes the two columns they leave of three', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} lastSweepAt={LAST_SWEEP} />)
    const rules = await rulesFor(container)
    const last = details().parentElement!.parentElement!
    expect(cellsOf(container).map(cell => span(rules, cell, PAIRS))).toEqual([undefined, undefined, undefined, undefined])
    expect([span(rules, last), span(rules, last, THREE), lineBefore(rules, last, THREE)]).toEqual(['span 2 / span 2', undefined, '1px'])
    expect(strip(container).style.getPropertyValue('--tracked-strip-columns')).toBe('6')
  })

  test('a place\'s four numbers are one row sooner, from 44rem', async () => {
    const { container } = render(<><TrackedSummaryGrid summary={SUMMARY} place={market} lastSweepAt={LAST_SWEEP} /><TrackedSummaryGridSkeleton cells={4} /></>)
    const rules = await rulesFor(container)
    for (const root of container.children) {
      const row = root.firstElementChild as HTMLElement
      expect([columns(rules, row), columns(rules, row, THREE), columns(rules, row, '@container (width >= 44rem)'), columns(rules, row, ROW)])
        .toEqual(['repeat(2, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))', ROW_COLUMNS, undefined])
      expect(row.style.getPropertyValue('--tracked-strip-columns')).toBe('6')
    }
    // Five numbers, as a location with hand-picked queries has, wait for 52rem like the project's.
    cleanup()
    const picked = render(<TrackedSummaryGrid summary={SUMMARY} place={{ kind: 'location', target: { ...location.target, counts: { ...location.target.counts!, customQueries: 3 } } }} />)
    expect(columns(await rulesFor(picked.container), strip(picked.container), ROW)).toBe(ROW_COLUMNS)
  })

  test('Details opens on the strip\'s own columns, and the row keeps room for its labels so opening it moves nothing', async () => {
    const { container, rerender } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} />)
    fireEvent.click(details())
    const rules = await rulesFor(container)
    const list = detailsList()
    // A grid of the strip's own columns, across all of them: two, three, then the columns of the row.
    expect(list.parentElement).toBe(strip(container))
    expect([compiledElementProperty(rules, list, 'display'), columns(rules, list), span(rules, list)]).toEqual(['grid', 'subgrid', '1 / -1'])
    // A row under 62rem cannot hold every label on its own columns: there Details is four columns of its own.
    expect(columns(rules, list, '@container (width < 62rem)')).toBe('repeat(4, minmax(0, 1fr))')
    // From 62rem each number's cell holds the label that opens under it, unseen and as generated text.
    const reserved = () => cellsOf(container).map(cell => [...cell.querySelectorAll<HTMLElement>('[data-reserve]')].map(room => room.dataset.reserve))
    expect(reserved()).toEqual([['Market queries'], ['Location queries'], ['Hand-picked queries'], ['Not asked'], ['Location links']])
    const room = cellsOf(container)[4]!.querySelector('[data-reserve]')!
    expect([room.textContent, room.getAttribute('aria-hidden')]).toEqual(['', 'true'])
    expect([compiledElementProperty(rules, room, 'display'), compiledElementProperty(rules, room, 'display', '@container (width >= 62rem)'), compiledElementProperty(rules, room, 'visibility'), compiledElementProperty(rules, room, 'white-space')])
      .toEqual(['none', 'block', 'hidden', 'nowrap'])
    expect(cssLengthPx(compiledElementProperty(rules, room, 'height')!, rules)).toBe(0)
    // Location links has a help icon beside it: its room is that much wider.
    expect(cssLengthPx(compiledElementProperty(rules, room, 'padding-right')!, rules)).toBe(20)

    // The rare numbers wrap to a second row of the same columns, so a cell holds room for both labels under it.
    rerender(<TrackedSummaryGrid summary={{ ...SUMMARY, byFocus: { ...SUMMARY.byFocus, company: 7 }, byClass: { ...SUMMARY.byClass, mixed: 5, unknown: 2 } }} limits={LIMITS} />)
    expect(reserved()).toEqual([['Market queries', 'Location links'], ['Location queries', 'Non-brand links'], ['Hand-picked queries', 'Branded links'], ['Company queries'], ['Mixed type']])
    // The eighth number starts that second row: no line before it, as before no first cell.
    const eighth = [...detailsList().querySelectorAll('dl > div')][7]!
    const wide = await rulesFor(container)
    expect([lineBefore(wide, eighth, '@container (width >= 62rem)'), lineBefore(wide, eighth.previousElementSibling!, '@container (width >= 62rem)')]).toEqual([undefined, '1px'])
  })

  test('the sweep dates wrap as whole dates: a dot shows between two on a line and never at the end of one', async () => {
    const { container } = render(<TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} nextSweepDate="Oct 21" />)
    const rules = await rulesFor(container)
    const line = sweepLine()
    const parts = [...line.children]
    expect([compiledElementProperty(rules, line, 'display'), compiledElementProperty(rules, line, 'flex-wrap')]).toEqual(['flex', 'wrap'])
    expect(parts.map(part => compiledElementProperty(rules, part, 'white-space'))).toEqual(['nowrap', 'nowrap'])
    // Each date carries its dot before it, in a gutter as wide as the line is pulled out to the left, where it is cut off.
    const gutters = parts.map(part => part.firstElementChild!)
    expect(gutters.map(gutter => [gutter.getAttribute('aria-hidden'), gutter.textContent])).toEqual([['true', ''], ['true', '·']])
    expect(gutters.map(gutter => cssLengthPx(compiledElementProperty(rules, gutter, 'width')!, rules))).toEqual([16, 16])
    expect(cssLengthPx(compiledElementProperty(rules, line, 'margin-left')!, rules)).toBe(-16)
    expect(compiledElementProperty(rules, line.parentElement!, 'clip-path')).toBe('inset(-0.25rem -0.25rem -0.25rem 0)')
    // The dates never widen the cell they sit in.
    expect(compiledElementProperty(rules, line.parentElement!, '--tw-contain-size')).toBe('inline-size')
  })

  test('the links and Retry are 44px targets under a finger, and the links show keyboard focus as a ring', async () => {
    const { container } = render(<><TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} onShowNotAsked={() => {}} /><TrackedSummaryGrid summary={undefined} onRetry={() => {}} /></>)
    const rules = await rulesFor(container)
    const links = [details(), screen.getByRole('button', { name: '38 not asked' })]
    for (const control of [...links, screen.getByRole('button', { name: 'Retry' })]) {
      for (const context of [COARSE, BELOW_MD]) expect(cssLengthPx(compiledElementProperty(rules, control, 'min-height', context)!, rules), `${control.textContent} ${context}`).toBe(44)
    }
    for (const link of links) {
      const focus = await stateStyle(link, 'focus-visible')
      expect(focus, link.textContent!).toMatchObject({ 'outline-style': 'none', '--tw-ring-color': 'var(--color-mono-400)' })
      expect(focus['--tw-ring-shadow'], link.textContent!).toContain('calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color')
    }
  })

  test('the skeleton is the same strip with nothing to read', async () => {
    const { container } = render(<><TrackedSummaryGrid summary={SUMMARY} limits={LIMITS} lastSweepAt={LAST_SWEEP} /><TrackedSummaryGridSkeleton /></>)
    const [grid, skeleton] = [...container.children] as [HTMLElement, HTMLElement]
    expect(skeleton.getAttribute('aria-hidden')).toBe('true')
    expect(skeleton.textContent).toBe('')
    // The same strip, cell for cell, so nothing moves when the numbers land.
    const [row, bones] = [grid.firstElementChild as HTMLElement, skeleton.firstElementChild as HTMLElement]
    expect([bones.className, bones.style.getPropertyValue('--tracked-strip-columns')]).toEqual([row.className, row.style.getPropertyValue('--tracked-strip-columns')])
    expect([...bones.children].map(cell => cell.className)).toEqual([...grid.querySelector('dl')!.children, details().parentElement!.parentElement!].map(cell => cell.className))
  })
})
