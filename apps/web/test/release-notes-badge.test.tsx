import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ReleaseNotesBadge } from '../src/components/layout/ReleaseNotesBadge.js'

const props = { storageKey: 'release-notes-test', showResourceLinks: true, whatsNewOnly: false }
const current = { version: '7.117.0' }
const patch = { version: '7.117.1' }
const unread = 'What’s new, unread release notes'
const open = () => screen.getByRole('dialog', { name: 'What’s new' })

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('opens the authored release on demand, clears unread and keeps the note accessible after a patch', async () => {
  const first = render(<ReleaseNotesBadge {...props} build={patch} />)
  const button = screen.getByRole('button', { name: unread })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Join our Discord' })).toBeNull()
  button.focus()
  fireEvent.click(button)
  const notes = within(open())
  expect(notes.getByText('v7.117.0')).toBeTruthy()
  const invitation = notes.getByRole<HTMLAnchorElement>('link', { name: 'Join our Discord' })
  expect(invitation.href).toBe('https://discord.gg/8K9yY7GywJ')
  expect(invitation.target).toBe('_blank')
  expect(invitation.relList.contains('noopener')).toBe(true)
  expect(invitation.relList.contains('noreferrer')).toBe(true)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(button))
  expect(screen.queryByRole('button', { name: unread })).toBeNull()

  first.unmount()
  render(<ReleaseNotesBadge {...props} build={{ version: '7.117.2' }} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'What’s new' }))
  expect(within(open()).getByRole('link', { name: 'Join our Discord' })).toBeTruthy()
})

it('updates the unread indicator across mounted tabs without opening a dialog in the other tab', () => {
  const other = render(<ReleaseNotesBadge {...props} build={current} />)
  const tab = render(<ReleaseNotesBadge {...props} build={current} />)
  const otherView = within(other.container)
  const clickedView = within(tab.container)
  const keys = new Set(Object.keys(localStorage))
  fireEvent.click(clickedView.getByRole('button', { name: unread }))
  const receipt = Object.keys(localStorage).find(key => !keys.has(key))!
  expect(receipt).toBeTruthy()
  act(() => window.dispatchEvent(new StorageEvent('storage', {
    key: receipt, newValue: localStorage.getItem(receipt), storageArea: localStorage,
  })))
  expect(otherView.getByRole('button', { name: 'What’s new' })).toBeTruthy()
  expect(otherView.queryByRole('dialog')).toBeNull()
  expect(clickedView.getByRole('dialog')).toBeTruthy()
})

it('keeps an available update ahead of the notes and opens only after the offer is dismissed', () => {
  const offer = <a href="https://www.npmjs.com/package/@canonry/canonry">Update available</a>
  const view = render(<ReleaseNotesBadge {...props} availableUpdate={offer} build={current} />)
  expect(screen.getByRole('link', { name: 'Update available' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: unread })).toBeNull()
  view.rerender(<ReleaseNotesBadge {...props} build={current} />)
  expect(screen.getByRole('button', { name: unread })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})
