import { availableReleaseNotes, compareReleaseBoundaries, validBuildVersion, type ReleaseNotes } from './release-notes.js'

export type InstalledBuild = { version: string; commit?: string }
type Baseline = { version: string; includeLatest: boolean }
type ReleaseSelection = { releases: ReleaseNotes[]; unread: boolean }

function baselineForFirstVisit(legacyReceipt: string | null, version: string): Baseline {
  if (legacyReceipt === null) return { version, includeLatest: true }
  try {
    // Old notices tracked the last installed build and, for an unread upgrade, the starting build.
    const receipt = JSON.parse(legacyReceipt) as {
      current?: InstalledBuild | null; from?: InstalledBuild | null; pending?: boolean; includeFromHighlights?: boolean
    } | null
    if (validBuildVersion(receipt?.current?.version) && typeof receipt.pending === 'boolean') {
      if (!receipt.pending || receipt.from === undefined) {
        return { version: receipt.current.version, includeLatest: receipt.pending }
      }
      if (validBuildVersion(receipt.from?.version) && compareReleaseBoundaries(receipt.from.version, receipt.current.version) <= 0) {
        return { version: receipt.from.version, includeLatest: receipt.includeFromHighlights === true }
      }
    }
  } catch { /* A corrupt legacy baseline cannot establish which earlier releases were unread. */ }
  return { version, includeLatest: false }
}

function firstVisit(storage: Storage, scope: string, version: string): Baseline {
  // Concurrent first loads may establish different baselines. Each writes its own immutable key.
  // The earliest wins, so neither a delayed old tab nor a rollback can erase another tab’s history.
  const prefix = scope + ':first:'
  let earliest: Baseline | undefined
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    const [mode, candidate] = suffix.split(':')
    if ((mode !== 'at' && mode !== 'after') || !validBuildVersion(candidate)) continue
    const order = earliest ? compareReleaseBoundaries(candidate, earliest.version) : -1
    if (order < 0 || (order === 0 && mode === 'at')) earliest = { version: candidate, includeLatest: mode === 'at' }
  }
  if (earliest) return earliest
  const baseline = baselineForFirstVisit(storage.getItem(scope), version)
  storage.setItem(prefix + (baseline.includeLatest ? 'at:' : 'after:') + baseline.version, '1')
  return baseline
}

export function observeReleaseNotes(storage: Storage | undefined, scope: string, runningVersion: string, showResourceLinks = true): ReleaseSelection {
  const available = availableReleaseNotes(runningVersion, showResourceLinks)
  const quiet = { releases: available.slice(0, 1), unread: false }
  if (!storage || !validBuildVersion(runningVersion)) return quiet

  try {
    const baseline = firstVisit(storage, scope, runningVersion)
    if (compareReleaseBoundaries(runningVersion, baseline.version) < 0) return quiet
    const firstNote = baseline.includeLatest ? available.find(note => compareReleaseBoundaries(note.version, baseline.version) <= 0) : undefined
    const unread = available.filter(note =>
      (note === firstNote || compareReleaseBoundaries(note.version, baseline.version) > 0)
      && storage.getItem(scope + ':read:' + note.version) === null,
    )
    return unread.length ? { releases: unread, unread: true } : quiet
  } catch {
    // The notes can still be opened when the browser blocks persistent storage.
    return quiet
  }
}

export function markReleaseRead(storage: Storage, scope: string, version: string): boolean {
  if (!validBuildVersion(version)) return false
  try {
    // Only the authored release actually opened by this tab is acknowledged.
    storage.setItem(scope + ':read:' + version, '1')
    return true
  } catch {
    return false
  }
}
