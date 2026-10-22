import React from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSheetDiscardGuard } from '../src/components/ui/sheet.js'

const routing = vi.hoisted(() => ({ block: vi.fn(), blocker: null as (() => boolean | Promise<boolean>) | null }))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { block: routing.block } }) }))

beforeEach(() => {
  routing.block.mockImplementation(({ blockerFn }: { blockerFn: () => boolean | Promise<boolean> }) => {
    routing.blocker = blockerFn
    return vi.fn()
  })
})
afterEach(() => { cleanup(); routing.blocker = null; vi.clearAllMocks() })

function Draft({ dirty = true, busy = false, onClose = vi.fn() }: { dirty?: boolean; busy?: boolean; onClose?: () => void }) {
  const guard = useSheetDiscardGuard({ dirty, busy, onClose })
  return <>
    <button onClick={guard.requestClose}>Close draft</button>
    <div data-testid="outside" onPointerDown={guard.onPointerDownOutside}>Outside</div>
    {guard.prompt}
  </>
}

test('ignores outside press for a dirty draft and asks before browser unload', () => {
  render(<Draft />)
  expect(fireEvent.pointerDown(screen.getByTestId('outside'), { cancelable: true })).toBe(false)
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
})

test('lets an untouched draft close without a confirmation or unload guard', () => {
  const onClose = vi.fn()
  render(<Draft dirty={false} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(false)
})

test('holds in-app Back until Discard and keeps navigation blocked after Keep editing', async () => {
  render(<Draft />)
  let decision: boolean | Promise<boolean> | undefined
  act(() => { decision = routing.blocker!() })
  expect(screen.getByRole('group', { name: 'Discard this change?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(await decision).toBe(true)
  act(() => { decision = routing.blocker!() })
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(await decision).toBe(false)
})

test('blocks navigation, outside press and close even for a clean draft while publishing', () => {
  const onClose = vi.fn()
  render(<Draft dirty={false} busy onClose={onClose} />)
  expect(routing.blocker!()).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }))
  expect(onClose).not.toHaveBeenCalled()
  expect(fireEvent.pointerDown(screen.getByTestId('outside'), { cancelable: true })).toBe(false)
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
})
