import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { SignalLegend, SignalPair, type EngineSignal } from '../src/components/shared/SignalCells.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../src/components/ui/sheet.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss, type CompiledRule } from './compiled-app-css.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The open bubble. It is decorative: the pair's name and description already carry its words. */
const bubble = () => [...document.body.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].find(element => element.style.zIndex === '9999') ?? null
const compiledRules = async (elements: Element[]) => parseCompiledCss(await compileAppStyles(elements.flatMap(element => [...element.classList])))
/** What a reader of the text gets: every node hidden from assistive tech removed. */
function spokenText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return copy.textContent ?? ''
}

type Drawn = 'lit' | 'grey' | 'dashed'
/** Each state's border style, border color, fill and letter color. The dashes of an empty box are brighter than the box around a grey letter. */
const LOOKS: Record<Drawn, (string | undefined)[]> = {
  lit: ['var(--tw-border-style)', 'var(--color-positive-border)', 'var(--color-positive-bg-soft)', 'var(--color-positive-text)'],
  grey: ['var(--tw-border-style)', 'var(--color-border-strong)', undefined, 'var(--color-text-faint)'],
  dashed: ['dashed', 'var(--color-mono-500)', undefined, undefined],
}
/**
 * How a chip is drawn, read from the compiled stylesheet because jsdom lays nothing out. `letter` is the one a
 * reader can see. A chip that matches no state in full comes back as its raw styles, so it equals none of them.
 */
function drawn(rules: CompiledRule[], chip: Element): { letter: string; drawn: string } {
  const look = ['border-style', 'border-color', 'background-color', 'color'].map(property => compiledElementProperty(rules, chip, property))
  const state = (Object.keys(LOOKS) as Drawn[]).find(name => LOOKS[name].every((value, index) => value === look[index]))
  const seen = [...chip.children].filter(part => compiledElementProperty(rules, part, 'visibility') !== 'hidden')
  return { letter: seen.map(part => part.textContent).join(''), drawn: state ?? look.join(' / ') }
}
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
/** Lay the page out by hand: jsdom gives every box a zero rect. `trigger` is read on each call, so a test can move it. */
function layOut(trigger: () => { left: number; top: number; width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = this.tagName === 'BUTTON' ? trigger() : { left: 0, top: 0, width: 0, height: 0 }
    return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }
  })
}
async function chipsOf(pair: Element) {
  const chips = [...pair.children]
  const rules = await compiledRules(chips.flatMap(chip => [chip, ...chip.children]))
  return chips.map(chip => drawn(rules, chip))
}

describe('SignalPair', () => {
  it.each<{ signal: EngineSignal | null; chips: [Drawn, Drawn]; name: string }>([
    { signal: { mentioned: true, cited: true }, chips: ['lit', 'lit'], name: 'ChatGPT: Mentioned, Cited' },
    { signal: { mentioned: true, cited: false }, chips: ['lit', 'grey'], name: 'ChatGPT: Mentioned, Not cited' },
    { signal: { mentioned: false, cited: true }, chips: ['grey', 'lit'], name: 'ChatGPT: Not mentioned, Cited' },
    { signal: { mentioned: false, cited: false }, chips: ['grey', 'grey'], name: 'ChatGPT: Not mentioned, Not cited' },
    // Each chip reads its own field: a mention says nothing about the sources, and the other way round.
    { signal: { mentioned: true, cited: null }, chips: ['lit', 'dashed'], name: 'ChatGPT: Mentioned, Citation not checked' },
    { signal: { mentioned: false, cited: null }, chips: ['grey', 'dashed'], name: 'ChatGPT: Not mentioned, Citation not checked' },
    { signal: { mentioned: null, cited: true }, chips: ['dashed', 'lit'], name: 'ChatGPT: Mention not checked, Cited' },
    { signal: { mentioned: null, cited: false }, chips: ['dashed', 'grey'], name: 'ChatGPT: Mention not checked, Not cited' },
    { signal: { mentioned: null, cited: null }, chips: ['dashed', 'dashed'], name: 'ChatGPT: Not checked' },
    // No result for the query at all.
    { signal: null, chips: ['dashed', 'dashed'], name: 'ChatGPT: Not checked' },
  ])('draws $chips for $signal and names it "$name"', async ({ signal, chips, name }) => {
    render(<SignalPair signal={signal} engineLabel="ChatGPT" />)
    const pair = screen.getByRole<HTMLButtonElement>('button', { name })
    expect(pair.type).toBe('button')
    expect(pair.hasAttribute('title')).toBe(false)
    // A not-checked chip is an empty box, so it never reads as a grey letter.
    expect(await chipsOf(pair)).toEqual([
      { letter: chips[0] === 'dashed' ? '' : 'M', drawn: chips[0] },
      { letter: chips[1] === 'dashed' ? '' : 'C', drawn: chips[1] },
    ])
    // The letters are a drawing; the name carries the words.
    expect(spokenText(pair)).toBe('')
  })

  it.each<{ case: string; signal: EngineSignal | null; detail: string; counted?: false }>([
    { case: 'both counts', signal: { mentioned: true, cited: false, answers: 3, mentionedAnswers: 2, citedAnswers: 0 }, detail: '2 of 3 answers mention it. 0 of 3 cite it.' },
    { case: 'a count of one', signal: { mentioned: true, cited: true, answers: 4, mentionedAnswers: 1, citedAnswers: 1 }, detail: '1 of 4 answers mentions it. 1 of 4 cites it.' },
    { case: 'one answer', signal: { mentioned: true, cited: false, answers: 1, mentionedAnswers: 1, citedAnswers: 0 }, detail: '1 of 1 answer mentions it. 0 of 1 cite it.' },
    { case: 'thousands', signal: { mentioned: true, cited: true, answers: 1644, mentionedAnswers: 1200, citedAnswers: 12 }, detail: '1,200 of 1,644 answers mention it. 12 of 1,644 cite it.' },
    // The server leaves a signal unchecked while answers are missing, whatever the counts so far say.
    { case: 'counts under an unchecked mention', signal: { mentioned: null, cited: false, answers: 2, mentionedAnswers: 0, citedAnswers: 0 }, detail: 'Mention not checked. 0 of 2 answers cite it.' },
    { case: 'counts under unchecked sources', signal: { mentioned: true, cited: null, answers: 3, mentionedAnswers: 2, citedAnswers: 0, uncheckedSourceAnswers: 3 }, detail: '2 of 3 answers mention it. Citation not checked.' },
    { case: 'counts under two unchecked signals', signal: { mentioned: null, cited: null, answers: 1, mentionedAnswers: 0, citedAnswers: 0 }, detail: 'Not checked.', counted: false },
    // Cited is yes as soon as one answer cites it. The answers whose sources were not checked are in neither side of that count.
    { case: 'answers with sources not checked', signal: { mentioned: true, cited: true, answers: 3, mentionedAnswers: 2, citedAnswers: 1, uncheckedSourceAnswers: 1 }, detail: '2 of 3 answers mention it. 1 of 3 cites it. 1 had sources not checked.' },
    { case: 'every source checked', signal: { mentioned: false, cited: false, answers: 2, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0 }, detail: '0 of 2 answers mention it. 0 of 2 cite it.' },
    { case: 'no counts', signal: { mentioned: true, cited: false }, detail: 'Mentioned. Not cited.', counted: false },
    { case: 'no saved answer to count', signal: { mentioned: false, cited: false, answers: 0, mentionedAnswers: 0, citedAnswers: 0 }, detail: 'Not mentioned. Not cited.', counted: false },
    { case: 'a base and one count', signal: { mentioned: false, cited: true, answers: 3, citedAnswers: 2 }, detail: 'Not mentioned. 2 of 3 answers cite it.' },
    { case: 'no result', signal: null, detail: 'Not checked.', counted: false },
  ])('says the server counts in its bubble, and in its description when there is a count: $case', ({ signal, detail, counted }) => {
    render(<SignalPair signal={signal} engineLabel="Gemini" />)
    const pair = screen.getByRole('button', { name: /^Gemini: / })
    // With no count the bubble only repeats the name, so a screen reader is not told the states twice.
    expect(pair.getAttribute('aria-description')).toBe(counted === false ? null : detail)
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
    act(() => pair.focus())
    expect([pair.getAttribute('aria-expanded'), bubble()?.textContent]).toEqual(['true', detail])
    fireEvent.keyDown(pair, { key: 'Escape' })
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
  })

  it('opens under a resting pointer, not one on its way down the column', () => {
    vi.useFakeTimers()
    render(<SignalPair signal={{ mentioned: true, cited: false }} engineLabel="Claude" />)
    const pair = screen.getByRole('button', { name: 'Claude: Mentioned, Not cited' })
    fireEvent.mouseEnter(pair)
    act(() => { vi.advanceTimersByTime(299) })
    expect(bubble()).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    fireEvent.mouseLeave(pair)
    expect(bubble()).toBeNull()

    // A pointer that crossed the pair and left opens nothing, then or later. React can report the one entry twice.
    fireEvent.mouseEnter(pair)
    fireEvent.mouseEnter(pair)
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.mouseLeave(pair)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(bubble()).toBeNull()

    // A pair that goes away under the pointer leaves no timer running.
    fireEvent.mouseEnter(pair)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens at once on a tap and on keyboard focus, and a second tap closes it for good', () => {
    vi.useFakeTimers()
    render(<SignalPair signal={{ mentioned: true, cited: false }} engineLabel="Claude" />)
    const pair = screen.getByRole('button', { name: 'Claude: Mentioned, Not cited' })
    // A tap hovers, focuses and clicks in one go.
    fireEvent.mouseEnter(pair)
    fireEvent.pointerDown(pair)
    act(() => pair.focus())
    fireEvent.click(pair, { detail: 1 })
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    fireEvent.pointerDown(pair)
    fireEvent.click(pair, { detail: 1 })
    expect(bubble()).toBeNull()
    // The hover that came with the first tap never opens it again.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(bubble()).toBeNull()

    act(() => pair.blur())
    act(() => pair.focus())
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
  })

  it('closes a bubble opened by the pointer when its row scrolls, and leaves it for a scroll elsewhere', () => {
    vi.useFakeTimers()
    render(<>
      <div data-testid="frame"><SignalPair signal={{ mentioned: true, cited: false }} engineLabel="Claude" /></div>
      <div data-testid="elsewhere" />
    </>)
    const pair = screen.getByRole('button', { name: 'Claude: Mentioned, Not cited' })
    const hover = () => {
      fireEvent.mouseEnter(pair)
      act(() => { vi.advanceTimersByTime(300) })
    }
    hover()
    fireEvent.scroll(screen.getByTestId('elsewhere'))
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    // The page scrolls: the bubble is fixed where it opened, and would end up over another row.
    fireEvent.scroll(document)
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
    // A frame around the pair scrolls, such as a wide table inside its own frame.
    hover()
    fireEvent.scroll(screen.getByTestId('frame'))
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
    // A tap leaves focus on the pair, but not keyboard focus: a finger that then scrolls the page closes it too.
    fireEvent.pointerDown(pair)
    act(() => pair.focus())
    fireEvent.click(pair, { detail: 1 })
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    fireEvent.scroll(document)
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
  })

  it('moves the bubble of a pair under keyboard focus with its row, and draws none while the row is out of view', () => {
    vi.stubGlobal('innerHeight', 800)
    let top = 900
    layOut(() => ({ left: 600, top, width: 41, height: 19 }))
    render(<SignalPair signal={{ mentioned: true, cited: false }} engineLabel="Claude" />)
    const pair = screen.getByRole('button', { name: 'Claude: Mentioned, Not cited' })
    // Focus lands on a pair below the fold. The browser scrolls it into view only after that.
    act(() => pair.focus())
    expect([pair.getAttribute('aria-expanded'), bubble()]).toEqual(['true', null])
    // jsdom shows keyboard focus on a button once a key has reached it, here the one that scrolls the page.
    fireEvent.keyDown(pair, { key: 'ArrowDown' })
    top = 400
    fireEvent.scroll(document)
    expect([bubble()!.textContent, bubble()!.style.top]).toEqual(['Mentioned. Not cited.', '419px'])
    top = 250
    fireEvent.scroll(document)
    expect(bubble()!.style.top).toBe('269px')
    // Scrolled off the top: no bubble is left behind over the rows now showing.
    top = -65
    fireEvent.scroll(document)
    expect(bubble()).toBeNull()
    top = 10
    fireEvent.scroll(document)
    expect(bubble()!.style.top).toBe('29px')
  })

  it.each([
    { edge: 'left edge', left: 4 },
    { edge: 'middle', left: 173 },
    { edge: 'right edge', left: 340 },
  ])('opens below the pair and inside a 390px viewport from a pair at the $edge', ({ left }) => {
    vi.stubGlobal('innerWidth', 390)
    layOut(() => ({ left, top: 300, width: 44, height: 44 }))
    render(<SignalPair signal={{ mentioned: true, cited: false, answers: 3, mentionedAnswers: 2, citedAnswers: 0 }} engineLabel="ChatGPT" />)
    act(() => screen.getByRole('button').focus())
    // Centered on the pair where there is room, and never past the 8px gutters.
    const center = Number.parseFloat(bubble()!.style.left)
    expect(center).toBe(Math.max(120, Math.min(left + 22, 270)))
    expect([center - 112, center + 112].every(edge => edge >= 8 && edge <= 382)).toBe(true)
    expect([bubble()!.style.top, bubble()!.style.transform, bubble()!.style.fontSize]).toEqual(['344px', 'translateX(-50%) translateY(8px)', '13px'])
  })

  it('shows keyboard focus as a ring, the only mark of it once the outline is off', async () => {
    render(<SignalPair signal={{ mentioned: true, cited: false }} engineLabel="ChatGPT" />)
    const focus = await stateStyle(screen.getByRole('button'), 'focus-visible')
    expect(focus).toMatchObject({
      'outline-style': 'none',
      '--tw-ring-color': 'var(--color-mono-400)',
      '--tw-ring-offset-width': '2px',
      '--tw-ring-offset-color': 'var(--color-bg)',
    })
    expect(focus['--tw-ring-shadow']).toContain('calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color')
    expect(focus['box-shadow']).toContain('var(--tw-ring-shadow)')
  })

  it('says N, Named and Not named in research, and keeps C for the sources', async () => {
    render(<>
      <SignalPair variant="research" signal={{ mentioned: true, cited: null }} engineLabel="ChatGPT" />
      <SignalPair variant="research" signal={{ mentioned: false, cited: true, answers: 2, mentionedAnswers: 0, citedAnswers: 2 }} engineLabel="Gemini" />
      <SignalPair variant="research" signal={{ mentioned: null, cited: false }} engineLabel="Claude" />
    </>)
    const named = screen.getByRole('button', { name: 'ChatGPT: Named, Citation not checked' })
    expect(await chipsOf(named)).toEqual([{ letter: 'N', drawn: 'lit' }, { letter: '', drawn: 'dashed' }])
    act(() => named.focus())
    expect(bubble()!.textContent).toBe('Named. Citation not checked.')

    const notNamed = screen.getByRole('button', { name: 'Gemini: Not named, Cited' })
    expect(await chipsOf(notNamed)).toEqual([{ letter: 'N', drawn: 'grey' }, { letter: 'C', drawn: 'lit' }])
    expect(notNamed.getAttribute('aria-description')).toBe('0 of 2 answers name it. 2 of 2 cite it.')

    act(() => screen.getByRole('button', { name: 'Claude: Name not checked, Not cited' }).focus())
    expect(bubble()!.textContent).toBe('Name not checked. Not cited.')
  })

  it('names each pair of a query asked both ways by its type, and never joins the two', async () => {
    render(<table><tbody><tr><td>
      <SignalPair signal={{ mentioned: true, cited: false, answers: 3, mentionedAnswers: 3, citedAnswers: 0 }} engineLabel="ChatGPT" classLabel="Branded" />
      <SignalPair signal={{ mentioned: false, cited: null, answers: 3, mentionedAnswers: 0, citedAnswers: 0 }} engineLabel="ChatGPT" classLabel="Non-brand" />
    </td></tr></tbody></table>)
    const branded = screen.getByRole('button', { name: 'ChatGPT, Branded: Mentioned, Not cited' })
    const nonBrand = screen.getByRole('button', { name: 'ChatGPT, Non-brand: Not mentioned, Citation not checked' })
    expect(await chipsOf(branded)).toEqual([{ letter: 'M', drawn: 'lit' }, { letter: 'C', drawn: 'grey' }])
    expect(await chipsOf(nonBrand)).toEqual([{ letter: 'M', drawn: 'grey' }, { letter: '', drawn: 'dashed' }])
    // The type leads the bubble, the only place a sighted reader of a stacked cell can tell the two apart.
    expect(branded.getAttribute('aria-description')).toBe('Branded. 3 of 3 answers mention it. 0 of 3 cite it.')
    expect(nonBrand.getAttribute('aria-description')).toBe('Non-brand. 0 of 3 answers mention it. Citation not checked.')
    act(() => nonBrand.focus())
    expect(bubble()!.textContent).toBe('Non-brand. 0 of 3 answers mention it. Citation not checked.')
  })

  it('is one tab stop per pair in a table row', () => {
    render(<table><tbody><tr>
      <td><SignalPair signal={{ mentioned: true, cited: true }} engineLabel="ChatGPT" /></td>
      <td><SignalPair signal={{ mentioned: false, cited: null }} engineLabel="Gemini" /></td>
      <td><SignalPair signal={null} engineLabel="Claude" /></td>
    </tr></tbody></table>)
    const cells = screen.getAllByRole('cell')
    expect(cells.map(cell => cell.querySelectorAll('button, a[href], input, select, textarea, [tabindex]').length)).toEqual([1, 1, 1])
    expect(cells.map(cell => within(cell).getByRole('button').getAttribute('aria-label'))).toEqual([
      'ChatGPT: Mentioned, Cited',
      'Gemini: Not mentioned, Citation not checked',
      'Claude: Not checked',
    ])
    // A cell holds only its pair: the bubble opens outside the table, so it never widens a column.
    act(() => within(cells[1]!).getByRole('button').focus())
    expect(bubble()!.textContent).toBe('Not mentioned. Citation not checked.')
    expect(screen.getByRole('table').contains(bubble())).toBe(false)
  })

  it('draws a skeleton while the result loads: no button, no tab stop, nothing to read', async () => {
    const { container } = render(<SignalPair signal={undefined} engineLabel="ChatGPT" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('button, [tabindex]')).toBeNull()
    expect(spokenText(container)).toBe('')
    const skeleton = container.firstElementChild!
    const skeletonRules = await compiledRules([skeleton, ...skeleton.children, ...[...skeleton.children].flatMap(box => [...box.children])])
    // Two pulsing boxes with no letter to see and no outline of a state.
    expect([...skeleton.children].map(box => [drawn(skeletonRules, box).letter, compiledElementProperty(skeletonRules, box, 'animation'), compiledElementProperty(skeletonRules, box, 'border-color')]))
      .toEqual(Array(2).fill(['', 'skeleton-pulse 1.5s ease-in-out infinite', 'transparent']))

    // The skeleton fills the box the pair will: nothing moves when the result arrives.
    cleanup()
    render(<SignalPair signal={null} engineLabel="ChatGPT" />)
    const pair = screen.getByRole('button')
    const pairRules = await compiledRules([pair, ...pair.children])
    const box = (rules: CompiledRule[], element: Element) => [
      compiledElementProperty(rules, element, 'display'),
      compiledElementProperty(rules, element, 'gap'),
      compiledElementProperty(rules, element, 'min-height', '@media (pointer: coarse)'),
      compiledElementProperty(rules, element, 'min-width', '@media (width < 48rem)'),
      ...[...element.children].flatMap(child => [compiledElementProperty(rules, child, 'width'), compiledElementProperty(rules, child, 'height'), compiledElementProperty(rules, child, 'border-width')]),
    ]
    expect(box(skeletonRules, skeleton)).toEqual(box(pairRules, pair))
    expect(box(pairRules, pair)).toEqual(['inline-flex', '3px', 'calc(var(--spacing) * 11)', 'calc(var(--spacing) * 11)', '19px', '19px', '1px', '19px', '19px', '1px'])
  })

  it('drops an open bubble when the result goes back to loading, and comes back closed', () => {
    const signal = { mentioned: true, cited: false }
    const { rerender } = render(<SignalPair signal={signal} engineLabel="ChatGPT" />)
    act(() => screen.getByRole('button').focus())
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    rerender(<SignalPair signal={undefined} engineLabel="ChatGPT" />)
    expect([screen.queryByRole('button'), bubble()]).toEqual([null, null])
    rerender(<SignalPair signal={signal} engineLabel="ChatGPT" />)
    expect([screen.getByRole('button').getAttribute('aria-expanded'), bubble()]).toEqual(['false', null])
  })

  it('takes taps on a 44px box where a finger is the pointer, and stays chip-sized for a mouse', async () => {
    render(<SignalPair signal={{ mentioned: true, cited: false }} engineLabel="ChatGPT" />)
    const pair = screen.getByRole('button')
    const rules = await compiledRules([pair])
    expect([compiledElementProperty(rules, pair, 'min-height'), compiledElementProperty(rules, pair, 'min-width')]).toEqual([undefined, undefined])
    for (const context of ['@media (pointer: coarse)', '@media (width < 48rem)']) {
      expect(['min-height', 'min-width'].map(property => cssLengthPx(compiledElementProperty(rules, pair, property, context)!, rules)), context).toEqual([44, 44])
    }
  })

  it('inside a sheet, Escape closes its open bubble and leaves the sheet up', () => {
    const onOpenChange = vi.fn()
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader><SheetTitle>Results</SheetTitle><SheetDescription className="sr-only">One query, by engine.</SheetDescription></SheetHeader>
          <textarea aria-label="Query" />
          <SignalPair signal={{ mentioned: true, cited: false }} engineLabel="ChatGPT" />
        </SheetContent>
      </Sheet>,
    )
    const pair = screen.getByRole('button', { name: 'ChatGPT: Mentioned, Not cited' })
    act(() => pair.focus())
    expect(bubble()!.textContent).toBe('Mentioned. Not cited.')
    fireEvent.keyDown(pair, { key: 'Escape' })
    expect(bubble()).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(pair, { key: 'Escape' })
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })
})

describe('SignalLegend', () => {
  async function legend() {
    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    const samples = items.map(item => item.firstElementChild!)
    const rules = await compiledRules(samples.flatMap(sample => [sample, ...sample.children]))
    return { read: items.map(spokenText), samples: samples.map(sample => drawn(rules, sample)) }
  }

  it('explains the tracked chips: M Mentioned, C Cited, No, Not checked', async () => {
    render(<SignalLegend />)
    expect(await legend()).toEqual({
      read: ['M Mentioned', 'C Cited', 'No', 'Not checked'],
      samples: [{ letter: 'M', drawn: 'lit' }, { letter: 'C', drawn: 'lit' }, { letter: 'M', drawn: 'grey' }, { letter: '', drawn: 'dashed' }],
    })
  })

  it('names the company and the domain research checks, behind N and C', async () => {
    render(<SignalLegend variant="research" company="Acme Homes" domain="example.com" />)
    expect(await legend()).toEqual({
      read: ['N Names Acme Homes', 'C Cites example.com', 'No', 'Not checked'],
      samples: [{ letter: 'N', drawn: 'lit' }, { letter: 'C', drawn: 'lit' }, { letter: 'N', drawn: 'grey' }, { letter: '', drawn: 'dashed' }],
    })
  })

  it('draws its samples exactly as the cells draw the same states', () => {
    render(<>
      <SignalLegend />
      <SignalPair signal={{ mentioned: true, cited: false }} engineLabel="ChatGPT" />
      <SignalPair signal={{ mentioned: null, cited: null }} engineLabel="Gemini" />
    </>)
    const [yes, , no, unchecked] = within(screen.getByRole('list')).getAllByRole('listitem').map(item => item.firstElementChild!.className)
    const [lit, grey] = [...screen.getByRole('button', { name: 'ChatGPT: Mentioned, Not cited' }).children].map(chip => chip.className)
    const dashed = screen.getByRole('button', { name: 'Gemini: Not checked' }).firstElementChild!.className
    expect([yes, no, unchecked]).toEqual([lit, grey, dashed])
    expect(new Set([lit, grey, dashed]).size).toBe(3)
  })

  it('wraps onto more lines on a narrow screen, and a long name wraps inside its own entry', async () => {
    render(<SignalLegend variant="research" company="Acme Homes of North Springfield and the Residences at Example Canyon" domain="residences-at-example-canyon.example.com" />)
    const list = screen.getByRole('list')
    const items = [...list.children]
    const rules = await compiledRules([list, ...items, ...items.map(item => item.firstElementChild!)])
    expect(compiledElementProperty(rules, list, 'flex-wrap')).toBe('wrap')
    // A name or a domain can be wider than a phone. Its entry stays inside the list and breaks where it must; the two fixed words never break.
    expect(items.map(item => [compiledElementProperty(rules, item, 'white-space'), compiledElementProperty(rules, item, 'max-width'), compiledElementProperty(rules, item, 'overflow-wrap')])).toEqual([
      [undefined, '100%', 'anywhere'],
      [undefined, '100%', 'anywhere'],
      ['nowrap', undefined, undefined],
      ['nowrap', undefined, undefined],
    ])
    // An entry is one row that never wraps as a row, so a chip is never a line away from its word. Beside a wrapped name it keeps its size, on the first line.
    expect(items.map(item => ['display', 'flex-wrap', 'align-items'].map(property => compiledElementProperty(rules, item, property)))).toEqual(Array(4).fill(['inline-flex', undefined, 'flex-start']))
    expect(items.map(item => compiledElementProperty(rules, item.firstElementChild!, 'flex-shrink'))).toEqual(Array(4).fill('0'))
    // Supporting copy a reader needs: readable size, and not the muted metadata color.
    expect([compiledElementProperty(rules, list, 'font-size'), compiledElementProperty(rules, list, 'color')]).toEqual(['13px', 'var(--color-text-secondary)'])
  })
})
