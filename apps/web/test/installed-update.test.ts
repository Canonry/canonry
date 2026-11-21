import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissInstalledBuild, observeInstalledBuild, readInstalledUpdate, type InstalledBuild } from '../src/lib/installed-update.js'

const key = 'installed-update-test'
const initial = { version: '7.116.0', commit: '0123456' }
const featured = { version: '7.117.0', commit: '1234567' }
const later = { version: '7.118.0', commit: '2345678' }
const observe = (current: InstalledBuild) => observeInstalledBuild(localStorage, key, current)
const read = (current: InstalledBuild) => readInstalledUpdate(localStorage, key, current)
const dismiss = (version: string) => dismissInstalledBuild(localStorage, key, version)

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(key)
  localStorage.removeItem('another-base-path')
})

describe('installed update notices', () => {
  it('shows first-visit highlights only for the installed release and remembers a dismissal', () => {
    expect(observe(featured)).toEqual({ current: featured })
    expect(observe(featured)).toEqual({ current: featured })
    dismiss(featured.version)
    expect(observe(featured)).toBeNull()
    expect(observe(later)).toEqual({ from: featured, current: later })
    expect(observeInstalledBuild(localStorage, 'another-base-path', later)).toBeNull()
  })

  it('carries unread first-visit highlights across upgrades and reloads until dismissal', () => {
    expect(observe(featured)).toEqual({ current: featured })
    const range = { from: featured, current: later, includeFromHighlights: true }
    expect(observe(later)).toEqual(range)
    expect(read(later)).toEqual(range)
    const next = { version: '7.119.0' }
    const extended = { ...range, current: next }
    expect(observe(next)).toEqual(extended)
    expect(observe(next)).toEqual(extended)
    dismiss(next.version)
    expect(read(next)).toBeNull()
    const afterDismissal = { version: '7.120.0' }
    expect(observe(afterDismissal)).toEqual({ from: next, current: afterDismissal })
  })

  it('persists upgrades and preserves the original baseline as pending releases advance', () => {
    expect(observe(initial)).toBeNull()
    const pending = { from: initial, current: featured }
    expect(observe(featured)).toEqual(pending)
    expect(observe(featured)).toEqual(pending)
    expect(observe(later)).toEqual({ from: initial, current: later })
    dismiss(featured.version)
    expect(observe(later)).toEqual({ from: initial, current: later })
    dismiss(later.version)
    const next = { version: '8.0.0' }
    expect(observe(next)).toEqual({ from: later, current: next })
  })

  it('leaves a newer tab’s pending state alone when an older build is observed', () => {
    expect(observe(initial)).toBeNull()
    expect(observe(featured)).toEqual({ from: initial, current: featured })
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(observe(initial)).toBeNull()
    expect(observe(featured)).toEqual({ from: initial, current: featured })
    expect(write).not.toHaveBeenCalled()
    dismiss(featured.version)
    write.mockClear()
    expect(observe(initial)).toBeNull()
    expect(observe(featured)).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('fills a missing commit once and records version metadata without announcing a release', () => {
    const unstamped = { version: '7.116.0+first' }
    const stamped = { ...initial, version: '7.116.0+second' }
    expect(observe(unstamped)).toBeNull()
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(observe(stamped)).toBeNull()
    expect(observe(stamped)).toBeNull()
    expect(write).toHaveBeenCalledTimes(1)
    expect(observe(featured)).toEqual({ from: stamped, current: featured })
    dismiss('7.117.0+build')
    expect(observe(featured)).toBeNull()
  })

  it.each([
    { version: featured.version, commit: 'abcdef0' },
    { version: featured.version + '+custom', commit: featured.commit },
  ])('retargets an existing notice to rebuild %o without announcing it again', rebuilt => {
    expect(observe(initial)).toBeNull()
    expect(observe(featured)).toEqual({ from: initial, current: featured })
    expect(observe(rebuilt)).toEqual({ from: initial, current: rebuilt })
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(read(featured)).toEqual({ from: initial, current: featured })
    expect(read(initial)).toBeNull()
    expect(read(later)).toBeNull()
    expect(observe(rebuilt)).toEqual({ from: initial, current: rebuilt })
    expect(write).not.toHaveBeenCalled()
    dismiss(rebuilt.version)
    const lastRebuild = { ...rebuilt, commit: 'abc1234' }
    expect(observe(lastRebuild)).toBeNull()
    expect(read(featured)).toBeNull()
    expect(observe(later)).toEqual({ from: lastRebuild, current: later })
  })

  it('reads empty storage and an unknown commit without writing or borrowing another tab’s SHA', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(read(featured)).toBeNull()
    expect(write).not.toHaveBeenCalled()
    expect(observe(featured)).toEqual({ current: featured })
    write.mockClear()
    const unstamped = { version: featured.version }
    expect(read(unstamped)).toEqual({ current: unstamped })
    expect(write).not.toHaveBeenCalled()
  })

  it('compares prereleases numerically and puts the stable release last', () => {
    expect(observe({ version: '7.117.0-rc.2' })).toBeNull()
    expect(observe({ version: '7.117.0-rc.10' })?.current.version).toBe('7.117.0-rc.10')
    expect(observe({ version: '7.117.0-rc.3' })).toBeNull()
    expect(observe(featured)?.current.version).toBe('7.117.0')
  })

  it('ignores unavailable versions and quietly recovers a corrupt storage record', () => {
    expect(observe({ version: 'unknown' })).toBeNull()
    expect(observe({ version: '7.117.0-rc.01' })).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
    localStorage.setItem(key, '{')
    expect(observe(featured)).toBeNull()
    expect(observe(later)).toEqual({ from: featured, current: later })
  })

  it.each(['getItem', 'setItem'] as const)('suppresses notices if storage.%s throws', method => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('storage unavailable') })
    expect(observe(featured)).toBeNull()
    expect(() => dismiss(featured.version)).not.toThrow()
  })
})
