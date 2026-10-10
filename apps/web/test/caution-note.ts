import { act, fireEvent, within } from '@testing-library/react'
import { expect } from 'vitest'

/** What a sighted reader sees: the text with every screen-reader-only node removed. */
export function visibleText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove()
  return copy.textContent ?? ''
}

/** The open tooltip bubbles showing exactly `note`. A bubble is decorative, so it is hidden from assistive tech. */
function openBubbles(note: string): Element[] {
  return [...document.body.querySelectorAll('span[aria-hidden="true"]')].filter(bubble => bubble.textContent === note)
}

/**
 * A note that sits behind a caution icon inside `scope`: the sentence is not
 * visible text anywhere on the page, a real button in `scope` carries it as its
 * exact accessible name, the button sits on the line reading `beside`, and
 * keyboard focus shows the bubble with the same words until Escape closes it.
 */
export function expectCautionNote(scope: HTMLElement, note: string, beside: string): HTMLButtonElement {
  expect(visibleText(document.body)).not.toContain(note)
  const button = within(scope).getByRole<HTMLButtonElement>('button', { name: note })
  expect(button.type).toBe('button')
  expect(button.classList.contains('info-tooltip-trigger-caution')).toBe(true)
  expect(button.closest('.info-tooltip-wrapper')!.parentElement!.textContent).toBe(beside)

  expect([button.getAttribute('aria-expanded'), openBubbles(note).length]).toEqual(['false', 0])
  act(() => button.focus())
  expect([button.getAttribute('aria-expanded'), openBubbles(note).length]).toEqual(['true', 1])
  fireEvent.keyDown(button, { key: 'Escape' })
  expect([button.getAttribute('aria-expanded'), openBubbles(note).length]).toEqual(['false', 0])
  act(() => button.blur())
  return button
}
