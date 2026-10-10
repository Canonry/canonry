import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { TrackedRowMenu } from '../src/components/project/queries/advanced/TrackedRowMenu.js'
import type { TrackedRowVm } from '../src/components/project/queries/advanced/tracked-types.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { rows, workspace } from './support/tracked-action-fixtures.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderMenu(row: TrackedRowVm, role?: 'viewer') {
  const onAction = vi.fn()
  const menu = <TrackedRowMenu row={row} workspace={workspace} onAction={onAction} />
  render(role ? <AccountProvider account={{ name: role, role }}>{menu}</AccountProvider> : menu)
  return { onAction, trigger: screen.getByRole('button', { name: `Actions for ${row.queryText}` }) }
}

const menu = () => screen.queryByRole('menu')
const items = () => within(screen.getByRole('menu')).getAllByRole('menuitem')
const labels = () => items().map(item => item.textContent)

describe('TrackedRowMenu', () => {
  it.each([
    ['a market query', rows.market, ['Edit wording', 'Change Subject', 'Change type', 'Stop tracking', 'Copy link']],
    ['a location query', rows.location, ['Edit wording', 'Change Subject', 'Move to another location', 'Change type', 'Stop tracking', 'Copy link']],
    ['a hand-picked query', rows.handPicked, ['Edit wording', 'Change Subject', 'Change type', 'Stop tracking', 'Copy link']],
    // Solo has one location, so the type decides the Subject there and Change Subject is not offered.
    ['a query in a one-location market', rows.soloMarket, ['Edit wording', 'Change type', 'Stop tracking', 'Copy link']],
    ['a query that is not asked', rows.notAsked, ['Track', 'Remove query', 'Copy link']],
  ] as const)('lists the actions of %s for a writer', (_name, row, expected) => {
    const { trigger } = renderMenu(row)
    expect(menu()).toBeNull()
    fireEvent.click(trigger)
    expect(labels()).toEqual(expected)
    expect(screen.getByRole('menu', { name: `Actions for ${row.queryText}` })).toBeTruthy()
  })

  it.each([rows.market, rows.location, rows.notAsked])('gives a viewer only Copy link, with no dead control', row => {
    const { trigger, onAction } = renderMenu(row, 'viewer')
    fireEvent.click(trigger)
    expect(labels()).toEqual(['Copy link'])
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(onAction).toHaveBeenCalledExactlyOnceWith('copy-link', row)
  })

  it('reports the chosen action with its row, closes, and leaves focus on the button', () => {
    const { trigger, onAction } = renderMenu(rows.location)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id)
    // Focus is on the button before the page hears the choice: a sheet it opens returns focus there when it closes.
    onAction.mockImplementation(() => expect(document.activeElement).toBe(trigger))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to another location' }))
    expect(onAction).toHaveBeenCalledExactlyOnceWith('move-location', rows.location)
    expect(menu()).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('opens from the keyboard on the first or the last item and moves through the items with the arrow keys', () => {
    const { trigger } = renderMenu(rows.market)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const [first, second] = items()
    const last = items().at(-1)!
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second!, { key: 'ArrowUp' })
    fireEvent.keyDown(first!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first!, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    // Only the button is a tab stop; the items are reached with the arrows.
    expect(items().map(item => item.tabIndex)).toEqual(items().map(() => -1))

    // Escape is marked handled, so a page shortcut on the same key can tell the menu took it.
    expect(fireEvent.keyDown(first!, { key: 'Escape' })).toBe(false)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(true)

    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items().at(-1))
  })

  it('marks the keys it moves with as handled, so the page does not scroll under the menu and close it', () => {
    const { trigger } = renderMenu(rows.market)
    expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
    const [first] = items()
    for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home']) expect(fireEvent.keyDown(first!, { key }), key).toBe(false)
    // Any other key is left alone.
    expect(fireEvent.keyDown(first!, { key: 'a' })).toBe(true)
  })

  it('keeps its keys and clicks from the row around it, the page and a dialog', () => {
    const row = { keys: vi.fn<(key: string) => void>(), click: vi.fn() }
    const page = { early: vi.fn(), capture: vi.fn(), window: vi.fn() }
    // A page shortcut registered before the menu opens, in either phase, and one on the window.
    document.addEventListener('keydown', page.early)
    document.addEventListener('keydown', page.capture, true)
    window.addEventListener('keydown', page.window)
    try {
      const onAction = vi.fn()
      render(
        <table><tbody><tr onKeyDown={event => row.keys(event.key)} onClick={row.click}>
          <td><TrackedRowMenu row={rows.market} workspace={workspace} onAction={onAction} /></td>
        </tr></tbody></table>,
      )
      const trigger = screen.getByRole('button', { name: `Actions for ${rows.market.queryText}` })
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
      for (const key of ['ArrowDown', 'End', 'Home', 'Enter']) fireEvent.keyDown(document.activeElement!, { key })
      expect(row.keys).not.toHaveBeenCalled()

      for (const listener of Object.values(page)) listener.mockClear()
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(menu()).toBeNull()
      expect(row.keys).not.toHaveBeenCalled()
      expect(page.early).not.toHaveBeenCalled()
      expect(page.capture).not.toHaveBeenCalled()
      expect(page.window).not.toHaveBeenCalled()
      // Closed, the menu takes no key: the next Escape is the page's.
      fireEvent.keyDown(trigger, { key: 'Escape' })
      expect(row.keys).toHaveBeenCalledExactlyOnceWith('Escape')
      expect(page.early).toHaveBeenCalledOnce()

      fireEvent.click(trigger)
      row.click.mockClear()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking' }))
      expect(onAction).toHaveBeenCalledExactlyOnceWith('stop', rows.market)
      expect(row.click).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', page.early)
      document.removeEventListener('keydown', page.capture, true)
      window.removeEventListener('keydown', page.window)
    }
  })

  it('reads the row\'s actions only for the open menu', () => {
    // A closed menu sits on every row of a long table, so it must not walk the workspace.
    const unread = new Proxy(workspace, { get: (_target, key) => { throw new Error(`read ${String(key)} while closed`) } })
    render(<TrackedRowMenu row={rows.location} workspace={unread} onAction={vi.fn()} />)
    expect(screen.getByRole('button', { name: `Actions for ${rows.location.queryText}` }).getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Tab from the button, on a press outside and on a scroll of the page, and not on a press inside', () => {
    const { trigger, onAction } = renderMenu(rows.market)
    fireEvent.click(trigger)
    fireEvent.pointerDown(items()[0]!)
    expect(menu()).not.toBeNull()
    fireEvent.keyDown(items()[0]!, { key: 'Tab' })
    expect(menu()).toBeNull()
    // Tab then moves on from the button, to the control after it.
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(menu()).toBeNull()

    // The menu is fixed where it opened, so it does not stay behind when its row scrolls away.
    fireEvent.click(trigger)
    fireEvent.scroll(screen.getByRole('menu'))
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(items()[0])
    fireEvent.scroll(document)
    expect(menu()).toBeNull()
    // The focus was in the menu: it goes back to the button, not to the page.
    expect(document.activeElement).toBe(trigger)

    // A resize moves the row under the menu too.
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(items()[0])
    fireEvent(window, new Event('resize'))
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(menu()).toBeNull()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('opens under the button, and above it when the viewport ends first', () => {
    const { trigger } = renderMenu(rows.market)
    const lay = (button: { top: number; bottom: number; right: number }, height = 200) => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const rect = this === trigger ? { ...button, left: button.right - 28, width: 28, height: 28 } : { top: 0, bottom: height, left: 0, right: 208, width: 208, height }
        return { ...rect, x: rect.left, y: rect.top, toJSON: () => rect }
      })
    }
    const position = () => {
      const { top, left } = screen.getByRole('menu').style
      return { top, left }
    }
    // jsdom's viewport is 1024 by 768.
    lay({ top: 100, bottom: 128, right: 1000 })
    fireEvent.click(trigger)
    expect(position()).toEqual({ top: '132px', left: '792px' })
    fireEvent.click(trigger)

    lay({ top: 700, bottom: 728, right: 1000 })
    fireEvent.click(trigger)
    expect(position()).toEqual({ top: '496px', left: '792px' })
    fireEvent.click(trigger)

    // Near the left edge the menu stays inside the viewport.
    lay({ top: 100, bottom: 128, right: 100 })
    fireEvent.click(trigger)
    expect(position()).toEqual({ top: '132px', left: '8px' })
    fireEvent.click(trigger)

    // With room on neither side it stays whole inside the viewport, over its button: a scroll to reach the rest would close it.
    lay({ top: 300, bottom: 328, right: 1000 }, 500)
    fireEvent.click(trigger)
    expect(position()).toEqual({ top: '260px', left: '792px' })
    // Never taller than the viewport less its margins, where it scrolls in itself.
    expect(screen.getByRole('menu').style.maxHeight).toBe('752px')
    fireEvent.click(trigger)
    lay({ top: 300, bottom: 328, right: 1000 }, 752)
    fireEvent.click(trigger)
    expect(position().top).toBe('8px')
    fireEvent.click(trigger)
    // A button half under the top edge still opens a menu that starts inside the viewport.
    lay({ top: -26, bottom: 2, right: 1000 })
    fireEvent.click(trigger)
    expect(position().top).toBe('8px')
  })
})
