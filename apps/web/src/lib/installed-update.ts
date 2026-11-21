import { compareSemver, isStrictSemver } from '@canonry/canonry-contracts'
import { releaseHighlightsForVersion } from './release-notes.js'

export type InstalledBuild = { version: string; commit?: string }
export type InstalledUpdate = { from?: InstalledBuild; current: InstalledBuild; includeFromHighlights?: true }
type StoredUpdate = InstalledUpdate & { pending: boolean }

function readBuild(value: unknown): InstalledBuild | null {
  if (!value || typeof value !== 'object' || !('version' in value) ||
      typeof value.version !== 'string' || !isStrictSemver(value.version)) return null
  const { version } = value
  if (prerelease(version).some(part => /^0\d+$/.test(part))) return null
  if ('commit' in value && typeof value.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(value.commit)) {
    return { version, commit: value.commit }
  }
  return { version }
}

function readState(raw: string | null): StoredUpdate | null {
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || !('current' in value) ||
      !('pending' in value) || typeof value.pending !== 'boolean') return null
  const current = readBuild(value.current)
  if (!current) return null
  if ('from' in value) {
    const from = readBuild(value.from)
    if (!value.pending || !from || compareVersions(from.version, current.version) >= 0) return null
    const state: StoredUpdate = { current, from, pending: true }
    if ('includeFromHighlights' in value && value.includeFromHighlights === true) state.includeFromHighlights = true
    return state
  }
  return { current, pending: value.pending }
}

function prerelease(version: string): string[] {
  return /^[^-+]+-([^+]+)/.exec(version)?.[1]?.split('.') ?? []
}

function compareVersions(left: string, right: string): number {
  const core = compareSemver(left, right)
  if (core) return core
  const a = prerelease(left)
  const b = prerelease(right)
  if (!a.length || !b.length) return b.length - a.length
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (xNumeric && x.length !== y.length) return x.length - y.length
    return x < y ? -1 : 1
  }
  return a.length - b.length
}

function pendingUpdate(state: StoredUpdate | null, current: InstalledBuild): InstalledUpdate | null {
  if (!state?.pending || compareVersions(current.version, state.current.version) !== 0) return null
  const update: InstalledUpdate = { current }
  if (state.from) update.from = state.from
  if (state.includeFromHighlights) update.includeFromHighlights = true
  return update
}

/** Read a cross-tab notification against the build this tab has actually observed. */
export function readInstalledUpdate(storage: Storage, key: string, current: InstalledBuild): InstalledUpdate | null {
  const build = readBuild(current)
  if (!build) return null
  try {
    return pendingUpdate(readState(storage.getItem(key)), build)
  } catch {
    return null
  }
}

export function observeInstalledBuild(storage: Storage, key: string, current: InstalledBuild): InstalledUpdate | null {
  const build = readBuild(current)
  if (!build) return null
  try {
    const raw = storage.getItem(key)
    const state = readState(raw)
    let next: StoredUpdate
    if (!state) {
      // A corrupt record loses its baseline. Recover quietly, without repeating a first-visit notice.
      next = { current: build, pending: raw === null && releaseHighlightsForVersion(build.version).length > 0 }
    } else {
      const order = compareVersions(build.version, state.current.version)
      if (order > 0) {
        next = { from: state.from ?? state.current, current: build, pending: true }
        // The first-visit notice contains the starting release itself, which an ordinary upgrade range excludes.
        if (state.includeFromHighlights || (state.pending && !state.from)) next.includeFromHighlights = true
      } else if (order < 0) {
        // An older tab or rolled-back server must leave the newer tab's receipt intact.
        return null
      } else {
        next = state.current.version !== build.version || state.current.commit !== build.commit
          ? { ...state, current: build }
          : state
      }
    }
    if (state !== next) storage.setItem(key, JSON.stringify(next))
    return pendingUpdate(next, build)
  } catch {
    // Browsers can disable storage or refuse writes after the initial read.
    return null
  }
}

export function dismissInstalledBuild(storage: Storage, key: string, version: string): void {
  if (!version || !isStrictSemver(version)) return
  try {
    const state = readState(storage.getItem(key))
    if (state?.pending && compareVersions(version, state.current.version) === 0) {
      storage.setItem(key, JSON.stringify({ current: state.current, pending: false }))
    }
  } catch { /* Storage is optional. */ }
}
