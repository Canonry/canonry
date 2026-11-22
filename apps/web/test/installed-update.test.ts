import { afterEach, expect, it, vi } from 'vitest'
import { markReleaseRead, observeReleaseNotes } from '../src/lib/installed-update.js'
import * as catalog from '../src/lib/release-notes.js'

const scope = 'dashboard/user'
const old = { version: '7.117.0', highlights: [{ text: 'First feature' }] }
const middle = { version: '7.118.0', highlights: [{ text: 'Second feature' }] }
const recent = { version: '8.0.0', highlights: [{ text: 'Third feature' }] }

function futureNotes(...notes: catalog.ReleaseNotes[]) {
  vi.spyOn(catalog, 'availableReleaseNotes').mockReturnValue(notes)
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

it('shows only the latest eligible note on first visit, then carries unread notes across skipped releases', () => {
  const older = { version: '7.110.0', highlights: [{ text: 'Before the first visit' }] }
  futureNotes(old, older)
  expect(observeReleaseNotes(localStorage, scope, '7.117.2')).toEqual({ releases: [old], unread: true })
  futureNotes(recent, middle, old, older)
  expect(observeReleaseNotes(localStorage, scope, '8.0.1')).toEqual({ releases: [recent, middle, old], unread: true })
  for (const note of [recent, middle, old]) markReleaseRead(localStorage, scope, note.version)
  expect(observeReleaseNotes(localStorage, scope, '8.0.2')).toEqual({ releases: [recent], unread: false })
})

it('remembers a first visit before any notes exist and includes every subsequent eligible release', () => {
  expect(observeReleaseNotes(localStorage, scope, '7.116.0')).toEqual({ releases: [], unread: false })
  futureNotes(middle, old)
  expect(observeReleaseNotes(localStorage, scope, '7.118.1')).toEqual({ releases: [middle, old], unread: true })
})

it('isolates an older tab’s in-flight acknowledgment from a newer release, account and rollback', () => {
  futureNotes(old)
  const opened = observeReleaseNotes(localStorage, scope, '7.117.0').releases
  const setItem = Storage.prototype.setItem
  const paused = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(function (this: Storage, key, value) {
    // A newly loaded tab observes the later release between the old click and its storage write.
    futureNotes(middle, old)
    expect(observeReleaseNotes(localStorage, scope, '7.118.0').releases).toContain(middle)
    setItem.call(this, key, value)
  })
  for (const note of opened) markReleaseRead(localStorage, scope, note.version)
  paused.mockRestore()
  expect(observeReleaseNotes(localStorage, scope, '7.118.1')).toEqual({ releases: [middle], unread: true })
  futureNotes(old)
  expect(observeReleaseNotes(localStorage, scope, '7.117.0+rollback')).toEqual({ releases: [old], unread: false })
  expect(observeReleaseNotes(localStorage, 'dashboard/other-user', '7.117.0')).toEqual({ releases: [old], unread: true })
})

it('keeps concurrent first visits to different builds from skipping the older tab’s unread notes', () => {
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(function (this: Storage, key, value) {
    futureNotes(middle, old)
    expect(observeReleaseNotes(localStorage, scope, '7.118.1').releases).toEqual([middle])
    setItem.call(this, key, value)
  })
  futureNotes(old)
  expect(observeReleaseNotes(localStorage, scope, '7.117.0').releases).toEqual([old])
  expect(observeReleaseNotes(localStorage, scope, '7.118.1')).toEqual({ releases: [middle, old], unread: true })
})

it.each([
  [false, undefined, false, [middle]],
  [true, undefined, false, [middle, old]],
  [true, { version: '7.117.0' }, false, [middle]],
  [true, { version: '7.117.0' }, true, [middle, old]],
] as const)('preserves old receipts with pending=%s, from=%o and includeFromHighlights=%s', (pending, from, includeFromHighlights, expected) => {
  const current = { version: from ? '7.118.0' : '7.117.2' }
  localStorage.setItem(scope, JSON.stringify({ current, pending, from, includeFromHighlights }))
  futureNotes(middle, old)
  expect(observeReleaseNotes(localStorage, scope, '7.118.2')).toEqual({ releases: expected, unread: true })
})

it('recovers a corrupt old baseline quietly and announces a later authored release', () => {
  localStorage.setItem(scope, '{')
  futureNotes(old)
  expect(observeReleaseNotes(localStorage, scope, '7.117.2')).toEqual({ releases: [old], unread: false })
  futureNotes(middle, old)
  expect(observeReleaseNotes(localStorage, scope, '7.118.0')).toEqual({ releases: [middle], unread: true })
})

it('keeps notes manually accessible if the browser denies storage', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
  futureNotes(old)
  expect(observeReleaseNotes(localStorage, scope, '7.117.0')).toEqual({ releases: [old], unread: false })
  expect(markReleaseRead(localStorage, scope, old.version)).toBe(false)
})
