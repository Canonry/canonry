import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InfoTooltip } from '../src/components/shared/InfoTooltip.js'
import { compileAppStyles, compiledDeclarations, compiledDeclarationValues, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const NOTE = '1 of 1644 answers had sources that could not be checked'
/** The open bubble. It is decorative: the trigger's accessible name already carries the words. */
const bubble = () => document.body.querySelector<HTMLElement>('span[aria-hidden="true"]')
const expanded = (trigger: HTMLElement) => trigger.getAttribute('aria-expanded')

describe('InfoTooltip caution variant', () => {
  it('is a real button named by its note, behind a triangle in the caution tone', () => {
    render(<InfoTooltip variant="caution" text={NOTE} />)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: NOTE })
    expect(trigger.type).toBe('button')
    expect(trigger.getAttribute('aria-label')).toBe(NOTE)
    expect([...trigger.classList]).toEqual(['info-tooltip-trigger', 'info-tooltip-trigger-caution'])
    // A triangle, not the info circle, and no text of its own.
    expect(trigger.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(trigger.querySelector('circle')).toBeNull()
    expect(trigger.textContent).toBe('')
    expect(bubble()).toBeNull()
  })

  it('opens on hover, keyboard focus and tap, and closes on leave, blur, a second tap and Escape', () => {
    render(<InfoTooltip variant="caution" text={NOTE} />)
    const trigger = screen.getByRole('button', { name: NOTE })

    fireEvent.mouseEnter(trigger.parentElement!)
    expect([expanded(trigger), bubble()?.textContent]).toEqual(['true', NOTE])
    fireEvent.mouseLeave(trigger.parentElement!)
    expect([expanded(trigger), bubble()]).toEqual(['false', null])

    act(() => trigger.focus())
    expect([expanded(trigger), bubble()?.textContent]).toEqual(['true', NOTE])
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect([expanded(trigger), bubble()]).toEqual(['false', null])
    act(() => trigger.blur())

    // A touch tap focuses before it clicks; the first tap must leave the bubble open.
    fireEvent.pointerDown(trigger)
    act(() => trigger.focus())
    fireEvent.click(trigger, { detail: 1 })
    expect([expanded(trigger), bubble()?.textContent]).toEqual(['true', NOTE])
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger, { detail: 1 })
    expect([expanded(trigger), bubble()]).toEqual(['false', null])
    act(() => trigger.blur())
    expect(expanded(trigger)).toBe('false')
  })

  it.each([
    { edge: 'left edge', triggerLeft: 4 },
    { edge: 'middle', triggerLeft: 187 },
    { edge: 'right edge', triggerLeft: 370 },
  ])('keeps the bubble inside a 390px viewport from a trigger at the $edge', ({ triggerLeft }) => {
    vi.stubGlobal('innerWidth', 390)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = this.tagName === 'BUTTON' ? { left: triggerLeft, top: 300, width: 16, height: 16 } : { left: 0, top: 0, width: 0, height: 0 }
      return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }
    })
    render(<InfoTooltip variant="caution" text={NOTE} />)
    act(() => screen.getByRole('button', { name: NOTE }).focus())
    // The bubble is centered on `left` and at most 14rem wide, never wider than the viewport less its gutters.
    const center = Number.parseFloat(bubble()!.style.left)
    const halfWidth = Math.min(224, 390 - 16) / 2
    expect(center - halfWidth).toBeGreaterThanOrEqual(8)
    expect(center + halfWidth).toBeLessThanOrEqual(390 - 8)
    // It opens below the trigger, at readable size.
    expect([bubble()!.style.top, bubble()!.style.fontSize]).toEqual(['316px', '13px'])
  })
})

describe('InfoTooltip caution hit area', () => {
  it('takes taps on a 24px square around its 16px icon, and leaves the info trigger as it was', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const trigger = compiledDeclarations(css, '.info-tooltip-trigger')
    const hit = compiledDeclarations(css, '.info-tooltip-trigger-caution::before')
    expect(compiledDeclarations(css, '.info-tooltip-trigger-caution').position).toBe('relative')
    expect(hit.position).toBe('absolute')
    expect(hit.content).toMatch(/^(['"])\1$/)
    const box = cssLengthPx(compiledDeclarations(css, '.info-tooltip-icon').width!, css) + 2 * cssLengthPx(trigger.padding!, css)
    expect([box, box - 2 * cssLengthPx(hit.inset!, css)], 'drawn box, then tap target, at the default 16px root').toEqual([16, 24])
    // Only the caution variant grows: the shared trigger is not positioned and has no box around it.
    expect(trigger.position).toBeUndefined()
    expect(compiledDeclarationValues(css, '.info-tooltip-trigger::before', 'inset')).toEqual([])
  })
})

describe('InfoTooltip default variant', () => {
  it('keeps the info circle, the neutral trigger and the bubble above it', () => {
    render(<InfoTooltip text="Help for a label." />)
    const trigger = screen.getByRole('button', { name: 'Help for a label.' })
    expect([...trigger.classList]).toEqual(['info-tooltip-trigger'])
    expect(trigger.querySelector('circle')).not.toBeNull()
    act(() => trigger.focus())
    expect([bubble()!.textContent, bubble()!.style.fontSize, bubble()!.style.transform]).toEqual(['Help for a label.', '11px', 'translateX(-50%) translateY(calc(-100% - 8px))'])
  })
})
