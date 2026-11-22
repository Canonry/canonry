import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { InstalledUpdateNotice } from '../src/components/layout/InstalledUpdateNotice.js'

const storageKey = 'installed-update-notice-test'
const previous = { version: '7.116.1', commit: '1234567890abcdef1234567890abcdef12345678' }
const current = { version: '7.117.0', commit: '9876543210abcdef9876543210abcdef98765432' }
const firstVisitTitle = 'What’s new in v7.117.0'
const upgradeTitle = 'Updated to v7.117.0'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem(storageKey)
})

it('introduces a known release on first visit and anchors the changes link to the running commit', () => {
  render(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  expect(screen.getByText(firstVisitTitle)).toBeTruthy()
  const invitation = screen.getByRole<HTMLAnchorElement>('link', { name: 'Join our Discord' })
  expect(invitation.href).toBe('https://discord.gg/8K9yY7GywJ')
  expect(invitation.relList.contains('noopener')).toBe(true)
  expect(invitation.relList.contains('noreferrer')).toBe(true)
  expect(invitation.target).toBe('_blank')
  expect(screen.getByRole('link', { name: 'View changes' }).getAttribute('href')).toBe(`https://github.com/Canonry/canonry/commits/${current.commit}`)
})

it('opens the exact installed package in an isolated tab when the build has no commit', () => {
  render(<InstalledUpdateNotice build={{ version: current.version }} storageKey={storageKey} />)
  const link = screen.getByRole<HTMLAnchorElement>('link', { name: 'View package on npm' })
  expect(link.href).toBe('https://www.npmjs.com/package/@canonry/canonry/v/7.117.0')
  expect(link.target).toBe('_blank')
  expect(link.relList.contains('noopener')).toBe(true)
  expect(link.relList.contains('noreferrer')).toBe(true)
  expect(fireEvent.click(link)).toBe(true)
  expect(screen.getByText(firstVisitTitle)).toBeTruthy()
})

it('keeps a first visit quiet with resource links disabled and describes a subsequent self-hosted upgrade', () => {
  const install = render(<InstalledUpdateNotice build={current} storageKey={storageKey} showResourceLinks={false} />)
  expect(screen.queryByRole('status')).toBeNull()
  install.rerender(<InstalledUpdateNotice build={{ version: '7.117.1' }} storageKey={storageKey} showResourceLinks={false} />)
  expect(screen.getByText('Updated to v7.117.1')).toBeTruthy()
  expect(screen.getByText('Previously v7.117.0.')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Join our Discord' })).toBeNull()
})

it('labels first-visit highlights with their authored version when the install has advanced', () => {
  render(<InstalledUpdateNotice build={{ version: '7.117.1', commit: 'aaaaaaa' }} storageKey={storageKey} />)
  expect(screen.getByText(firstVisitTitle)).toBeTruthy()
  expect(screen.getByRole<HTMLAnchorElement>('link', { name: 'View package on npm' }).href)
    .toBe('https://www.npmjs.com/package/@canonry/canonry/v/7.117.0')
})

it('compares observed builds and remembers dismissal across remounts', () => {
  const install = render(<InstalledUpdateNotice build={previous} storageKey={storageKey} />)
  expect(screen.queryByRole('status')).toBeNull()
  install.rerender(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  expect(screen.getByText(upgradeTitle)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'View changes' }).getAttribute('href')).toBe(`https://github.com/Canonry/canonry/compare/${previous.commit}...${current.commit}`)

  install.unmount()
  const reopened = render(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  expect(screen.getByText(upgradeTitle)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
  expect(screen.queryByText(upgradeTitle)).toBeNull()
  reopened.unmount()
  render(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  expect(screen.queryByText(upgradeTitle)).toBeNull()
  expect(screen.queryByText(firstVisitTitle)).toBeNull()
})

it('applies a dismissal received from another tab while the notice is visible', () => {
  const otherTab = render(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  const pending = window.localStorage.getItem(storageKey)!
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
  const dismissed = window.localStorage.getItem(storageKey)!
  expect(dismissed).not.toBe(pending)
  otherTab.unmount()

  window.localStorage.setItem(storageKey, pending)
  render(<InstalledUpdateNotice build={current} storageKey={storageKey} />)
  expect(screen.getByText(firstVisitTitle)).toBeTruthy()
  act(() => {
    window.localStorage.setItem(storageKey, dismissed)
    window.dispatchEvent(new StorageEvent('storage', {
      key: storageKey, oldValue: pending, newValue: dismissed, storageArea: window.localStorage,
    }))
  })
  expect(screen.queryByText(firstVisitTitle)).toBeNull()
})

it('shows only customer-facing highlights after a hosted rollout and stays quiet for a release without highlights', () => {
  const view = render(<InstalledUpdateNotice build={previous} storageKey={storageKey} whatsNewOnly />)
  expect(screen.queryByRole('status')).toBeNull()
  view.rerender(<InstalledUpdateNotice build={current} storageKey={storageKey} whatsNewOnly />)
  expect(screen.getByText('What’s new')).toBeTruthy()
  expect(screen.getByRole('status').textContent).not.toMatch(/7\.117|Previously|upgrade|npm/i)
  expect(screen.getAllByRole('link')).toEqual([screen.getByRole('link', { name: 'Join our Discord' })])
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss what’s new' }))
  view.unmount()
  const reopened = render(<InstalledUpdateNotice build={current} storageKey={storageKey} whatsNewOnly />)
  expect(screen.queryByRole('status')).toBeNull()
  reopened.rerender(<InstalledUpdateNotice build={{ version: '7.117.1' }} storageKey={storageKey} whatsNewOnly />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('retains the unread Discord invitation when a first visit and subsequent upgrades skip the featured release', () => {
  const view = render(<InstalledUpdateNotice build={{ version: '7.117.1' }} storageKey={storageKey} whatsNewOnly />)
  expect(screen.getByRole('link', { name: 'Join our Discord' })).toBeTruthy()
  view.rerender(<InstalledUpdateNotice build={{ version: '7.118.0' }} storageKey={storageKey} whatsNewOnly />)
  expect(screen.getByRole('link', { name: 'Join our Discord' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss what’s new' }))
  view.rerender(<InstalledUpdateNotice build={{ version: '7.118.1' }} storageKey={storageKey} whatsNewOnly />)
  expect(screen.queryByRole('status')).toBeNull()
})
