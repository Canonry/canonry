import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AlertTriangle, Check, Info, RotateCcw } from 'lucide-react'

import { InfoTooltip } from '../src/components/shared/InfoTooltip.js'
import { StatusNote } from '../src/components/shared/StatusNote.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../src/components/ui/sheet.js'
import { visibleText } from './caution-note.js'
import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LABEL = 'Resets all numbers'
const DETAIL = 'Every location and market shows no current numbers until the next sweep. Past answers are kept.'
/** The open bubble. It is decorative: the note's accessible name already carries the sentence. */
const bubble = () => [...document.body.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')].find(element => element.style.zIndex === '9999') ?? null
const expanded = (trigger: HTMLElement) => trigger.getAttribute('aria-expanded')
const compiledRules = async (elements: Element[]) => parseCompiledCss(await compileAppStyles(elements.flatMap(element => [...element.classList])))
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
/**
 * Lay the page out by hand: jsdom gives every box a zero rect. The open bubble is a 54px box placed
 * as its own style says, so the note can find out that it does not fit.
 */
function layOut(note: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = Number.parseFloat(this.style.top) + (this.style.transform.endsWith('translateY(8px)') ? 8 : -62)
    const rect = this.tagName === 'BUTTON' ? note : this.style.zIndex === '9999' ? { left: 0, top, width: 224, height: 54 } : { left: 0, top: 0, width: 0, height: 0 }
    return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }
  })
}

describe('StatusNote', () => {
  it('is one real button holding the icon and the label, named by the label and then the sentence', () => {
    const { container } = render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />)
    const note = screen.getByRole<HTMLButtonElement>('button', { name: `${LABEL}. ${DETAIL}` })
    expect(screen.getAllByRole('button')).toEqual([note])
    expect(note.type).toBe('button')
    // The label is the only visible text; the sentence is nowhere on the page until the bubble opens.
    expect(note.textContent).toBe(LABEL)
    expect(visibleText(document.body)).toBe(LABEL)
    expect(note.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    // A title shows on neither a tap nor keyboard focus, so the sentence never rides on one.
    expect(container.querySelector('[title]')).toBeNull()
    expect([expanded(note), bubble()]).toEqual(['false', null])
  })

  it('opens on hover, keyboard focus and tap, and closes on leave, blur, a second tap and Escape', () => {
    render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} />)
    const note = screen.getByRole('button', { name: `${LABEL}. ${DETAIL}` })

    fireEvent.mouseEnter(note)
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
    fireEvent.mouseLeave(note)
    expect([expanded(note), bubble()]).toEqual(['false', null])

    act(() => note.focus())
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
    fireEvent.keyDown(note, { key: 'Escape' })
    expect([expanded(note), bubble()]).toEqual(['false', null])
    act(() => note.blur())

    // A touch tap focuses before it clicks; the first tap must leave the bubble open.
    fireEvent.pointerDown(note)
    act(() => note.focus())
    fireEvent.click(note, { detail: 1 })
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
    fireEvent.pointerDown(note)
    fireEvent.click(note, { detail: 1 })
    expect([expanded(note), bubble()]).toEqual(['false', null])
    act(() => note.blur())
    expect(expanded(note)).toBe('false')

    // Safari moves no focus to a tapped button, so the click alone has to open it.
    fireEvent.pointerDown(note)
    fireEvent.click(note, { detail: 1 })
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
    fireEvent.mouseLeave(note)

    // Enter or Space on the focused note is a click with no pointer behind it: it toggles.
    act(() => note.focus())
    fireEvent.click(note, { detail: 0 })
    expect([expanded(note), bubble()]).toEqual(['false', null])
    fireEvent.click(note, { detail: 0 })
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
  })

  it.each([
    { name: 'default', tone: undefined, color: 'var(--color-text-secondary)', hover: 'var(--color-text-heading)' },
    { name: 'neutral', tone: 'neutral', color: 'var(--color-text-secondary)', hover: 'var(--color-text-heading)' },
    { name: 'caution', tone: 'caution', color: 'var(--color-caution-text)', hover: 'var(--color-caution-200)' },
    { name: 'negative', tone: 'negative', color: 'var(--color-negative-text)', hover: 'var(--color-negative-200)' },
    { name: 'positive', tone: 'positive', color: 'var(--color-positive-text)', hover: 'var(--color-positive-200)' },
  ] as const)('draws the $name tone in its semantic color, icon and label alike, a step brighter under the pointer', async ({ tone, color, hover }) => {
    render(<StatusNote icon={Info} label="Company names only" detail="Research checks company names, not a location's own names." tone={tone} />)
    const note = screen.getByRole('button')
    const rules = await compiledRules([note])
    expect(compiledElementProperty(rules, note, 'color')).toBe(color)
    expect(await stateStyle(note, 'hover')).toEqual({ color: hover })
    // The icon takes the note's color: it sets none of its own.
    expect(compiledElementProperty(await compiledRules([note.querySelector('svg')!]), note.querySelector('svg')!, 'color')).toBeUndefined()
  })

  it('shows keyboard focus as a ring, the only mark of it once the outline is off', async () => {
    render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />)
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

  it('marks a label that has a sentence behind it with a dotted underline, and no other label', async () => {
    render(<>
      <StatusNote icon={Info} label="Company names only" detail="Research checks company names, not a location's own names." />
      <StatusNote icon={Info} label="View only" />
    </>)
    const [opens, plain] = [screen.getByRole('button'), screen.getByText('View only')]
    const rules = await compiledRules([opens, plain])
    const underline = (note: Element) => ['text-decoration-line', 'text-decoration-style', 'text-underline-offset'].map(property => compiledElementProperty(rules, note, property))
    expect(underline(opens)).toEqual(['underline', 'dotted', '4px'])
    expect(underline(plain)).toEqual([undefined, undefined, undefined])
    // In the tone's own color, fainter than the label.
    expect(compiledElementProperty(rules, opens, 'text-decoration-color', '@supports (color: color-mix(in lab, red, red))')).toBe('color-mix(in oklab, currentcolor 40%, transparent)')
  })

  it('wraps a label too long for its box under itself, with the icon on the first line', async () => {
    const { container } = render(<StatusNote icon={AlertTriangle} label="Tracking changed Oct 9" detail="Showing the Oct 7 results, from before the change." tone="caution" action={<button type="button">Retry</button>} />)
    const note = screen.getByRole('button', { name: /^Tracking changed Oct 9\. / })
    const icon = note.querySelector('svg')!
    const rules = await compiledRules([container.firstElementChild!, note, icon])
    // Supporting copy a reader needs: readable size. It never runs past a narrow card or cell.
    expect(['font-size', 'white-space', 'max-width', 'text-align'].map(property => compiledElementProperty(rules, note, property))).toEqual(['13px', undefined, '100%', 'left'])
    // The icon has its own column, at the top of it: a 14px icon centered on the first 20px line.
    expect(['display', 'grid-template-columns', 'align-items', 'line-height'].map(property => compiledElementProperty(rules, note, property))).toEqual(['inline-grid', 'auto minmax(0,1fr)', 'flex-start', 'calc(var(--spacing) * 5)'])
    expect([cssLengthPx(compiledElementProperty(rules, icon, 'height')!, rules), compiledElementProperty(rules, icon, 'margin-top')]).toEqual([14, '3px'])
    // The action drops under a note that fills the line.
    expect(['flex-wrap', 'max-width'].map(property => compiledElementProperty(rules, container.firstElementChild!, property))).toEqual(['wrap', '100%'])
  })

  it('is a 44px row where a finger is the pointer, with a sentence or without, its label centered in it', async () => {
    render(<>
      <StatusNote icon={AlertTriangle} label="In no market" detail="This location is in no market, so it needs a search location." tone="caution" />
      <StatusNote icon={Check} label="No change" tone="positive" />
    </>)
    // One row height for a table of notes, whichever kind each row holds.
    for (const note of [screen.getByRole('button'), screen.getByText('No change')]) {
      const rules = await compiledRules([note])
      expect([compiledElementProperty(rules, note, 'min-height'), compiledElementProperty(rules, note, 'align-content')], note.textContent!).toEqual([undefined, 'center'])
      for (const context of ['@media (pointer: coarse)', '@media (width < 48rem)']) {
        expect(cssLengthPx(compiledElementProperty(rules, note, 'min-height', context)!, rules), `${note.textContent} ${context}`).toBe(44)
      }
    }
  })

  it.each([
    { where: 'with room', width: 1440, left: 741, edge: 741 },
    { where: 'at the left edge of a phone', width: 390, left: 4, edge: 8 },
    { where: 'at the right edge of a phone', width: 390, left: 257, edge: 158 },
  ])('hangs its bubble below it from the label\'s own left edge, inside the viewport: $where', ({ width, left, edge }) => {
    vi.stubGlobal('innerWidth', width)
    layOut({ left, top: 300, width: 117, height: 20 })
    render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />)
    act(() => screen.getByRole('button').focus())
    // The bubble is 14rem wide and centered on `left`. In a sheet, a bubble centered on a label at the sheet's edge would hang outside it.
    expect(Number.parseFloat(bubble()!.style.left) - 112).toBe(edge)
    expect([bubble()!.style.top, bubble()!.style.transform, bubble()!.style.fontSize]).toEqual(['320px', 'translateX(-50%) translateY(8px)', '13px'])
  })

  it('opens above itself with no room below, so the bubble never covers the label it explains', () => {
    vi.stubGlobal('innerHeight', 844)
    // A note in the footer of a sheet: 16px above the bottom of the screen.
    layOut({ left: 257, top: 784, width: 117, height: 44 })
    render(<StatusNote icon={RotateCcw} label="Sweep running" detail="Publishing waits until the running sweep finishes." tone="caution" />)
    act(() => screen.getByRole('button').focus())
    // Anchored to the top of the note and lifted by its own height and the same 8px gap, at the same size.
    expect([bubble()!.style.top, bubble()!.style.transform, bubble()!.style.fontSize, bubble()!.style.lineHeight]).toEqual(['784px', 'translateX(-50%) translateY(calc(-100% - 8px))', '13px', '18px'])
    expect(bubble()!.getBoundingClientRect().bottom).toBe(776)
  })

  it('stays below a note that has no room above it either, moved up to fit', () => {
    vi.stubGlobal('innerHeight', 100)
    layOut({ left: 16, top: 40, width: 117, height: 20 })
    render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />)
    act(() => screen.getByRole('button').focus())
    expect([bubble()!.style.top, bubble()!.style.transform]).toEqual(['30px', 'translateX(-50%) translateY(8px)'])
    expect(bubble()!.getBoundingClientRect().bottom).toBe(92)
  })

  it('sits in a table cell as the cell text, with its bubble outside the table', () => {
    render(<table><tbody><tr><td>3 <StatusNote icon={AlertTriangle} label="Loses 2 locations" detail="Two locations leave this market when you publish." tone="caution" /></td></tr></tbody></table>)
    const cell = screen.getByRole('cell')
    const note = within(cell).getByRole('button', { name: 'Loses 2 locations. Two locations leave this market when you publish.' })
    expect(cell.textContent).toBe('3 Loses 2 locations')
    act(() => note.focus())
    expect(bubble()!.textContent).toBe('Two locations leave this market when you publish.')
    expect(screen.getByRole('table').contains(bubble())).toBe(false)
    expect(cell.textContent).toBe('3 Loses 2 locations')
  })

  it('inside a sheet, Escape closes the open bubble first and the sheet only after it', () => {
    const onOpenChange = vi.fn()
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader><SheetTitle>Edit wording</SheetTitle><SheetDescription className="sr-only">Change the text of one query.</SheetDescription></SheetHeader>
          {/* The sheet focuses its first control when it opens, and focus opens a bubble. */}
          <textarea aria-label="Query" />
          <StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />
          <InfoTooltip text="Blank lines are skipped." />
        </SheetContent>
      </Sheet>,
    )
    const sheet = screen.getByRole('dialog', { name: 'Edit wording' })
    const note = within(sheet).getByRole('button', { name: `${LABEL}. ${DETAIL}` })
    expect([expanded(note), bubble()]).toEqual(['false', null])

    act(() => note.focus())
    expect([expanded(note), bubble()?.textContent]).toEqual(['true', DETAIL])
    fireEvent.keyDown(note, { key: 'Escape' })
    expect([expanded(note), bubble()]).toEqual(['false', null])
    expect(onOpenChange).not.toHaveBeenCalled()

    // A help icon in the same sheet answers the key the same way: the sheet has no handler of its own for either.
    const help = within(sheet).getByRole('button', { name: 'Blank lines are skipped.' })
    act(() => help.focus())
    expect([expanded(help), bubble()?.textContent]).toEqual(['true', 'Blank lines are skipped.'])
    fireEvent.keyDown(help, { key: 'Escape' })
    expect([expanded(help), bubble()]).toEqual(['false', null])
    expect(onOpenChange).not.toHaveBeenCalled()

    // With the bubble closed, the same key on the same note is the sheet's, and on the help icon too.
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(onOpenChange.mock.calls).toEqual([[false]])
    fireEvent.keyDown(help, { key: 'Escape' })
    expect(onOpenChange.mock.calls).toEqual([[false], [false]])
  })

  it('leaves Escape to the sheet while the bubble is open by hover and focus is elsewhere', () => {
    const onOpenChange = vi.fn()
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader><SheetTitle>Edit wording</SheetTitle><SheetDescription className="sr-only">Change the text of one query.</SheetDescription></SheetHeader>
          <textarea aria-label="Query" />
          <StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} tone="caution" />
        </SheetContent>
      </Sheet>,
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: `${LABEL}. ${DETAIL}` }))
    expect(bubble()!.textContent).toBe(DETAIL)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Query' }), { key: 'Escape' })
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })

  it('keeps its one action beside the note, outside the note and its name', () => {
    const retry = vi.fn()
    render(<StatusNote icon={AlertTriangle} label="Could not load" detail="The server did not answer." tone="negative" action={<button type="button" onClick={retry}>Retry</button>} />)
    const note = screen.getByRole('button', { name: 'Could not load. The server did not answer.' })
    const action = screen.getByRole('button', { name: 'Retry' })
    expect(note.contains(action)).toBe(false)
    expect(note.parentElement).toBe(action.parentElement)
    expect(note.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // The action is its own control: pointing at it or pressing it never opens the note.
    fireEvent.mouseEnter(action)
    fireEvent.click(action, { detail: 1 })
    expect(retry).toHaveBeenCalledTimes(1)
    expect([expanded(note), bubble()]).toEqual(['false', null])
  })

  it('is plain text, not a button, when there is no sentence to open', async () => {
    const { container } = render(<StatusNote icon={Check} label="Saved to draft" tone="positive" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('Saved to draft')
    const note = screen.getByText('Saved to draft')
    expect(note.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(note.hasAttribute('aria-expanded')).toBe(false)
    expect(compiledElementProperty(await compiledRules([note]), note, 'color')).toBe('var(--color-positive-text)')
    fireEvent.mouseEnter(note)
    expect(bubble()).toBeNull()
  })

  it('drops an open bubble when its sentence goes away, and comes back closed', () => {
    const { rerender } = render(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} />)
    act(() => screen.getByRole('button').focus())
    expect(bubble()!.textContent).toBe(DETAIL)
    rerender(<StatusNote icon={RotateCcw} label={LABEL} />)
    expect([screen.queryByRole('button'), bubble()]).toEqual([null, null])
    rerender(<StatusNote icon={RotateCcw} label={LABEL} detail={DETAIL} />)
    expect([expanded(screen.getByRole('button')), bubble()]).toEqual(['false', null])
  })
})
