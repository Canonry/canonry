import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  resetRunTracker,
  selectStaleTrackedRuns,
  STALE_TRACKED_RUN_MS,
  type TrackedRun,
} from '../src/lib/run-tracker-store.js'

beforeEach(() => {
  resetRunTracker()
  window.sessionStorage.clear()
})

afterEach(() => {
  resetRunTracker()
  window.sessionStorage.clear()
})

function tracked(partial: Partial<TrackedRun> & { runId: string }): TrackedRun {
  return {
    projectId: 'p1',
    kind: 'gbp-sync',
    sourceAction: 'gbp-sync',
    lastAnnouncedStatus: 'queued',
    trackedAt: 1_000,
    ...partial,
  }
}

// `selectStaleTrackedRuns` is the give-up rule for tracked runs that have aged
// out of the capped GET /runs window: a run still PRESENT in /runs is never
// stale (the observer is still watching it), while a run ABSENT from /runs for
// longer than the TTL has aged out and must be cleared so its trigger button
// cannot wedge on "Syncing…"/"Running…" forever.

test('a tracked run still present in /runs is never stale, even when old', () => {
  const runs = [tracked({ runId: 'r1', trackedAt: 0 })]
  expect(selectStaleTrackedRuns(runs, new Set(['r1']), 9_999_999, 1_000)).toEqual([])
})

test('a tracked run absent from /runs past the TTL is stale', () => {
  const runs = [tracked({ runId: 'r1', trackedAt: 0 })]
  expect(selectStaleTrackedRuns(runs, new Set(), 1_000, 1_000).map((r) => r.runId)).toEqual(['r1'])
})

test('a tracked run absent but within the TTL grace is not cleared (covers the just-queued race)', () => {
  const runs = [tracked({ runId: 'r1', trackedAt: 0 })]
  expect(selectStaleTrackedRuns(runs, new Set(), 999, 1_000)).toEqual([])
})

test('a legacy tracked run with no trackedAt, absent from /runs, is cleared', () => {
  const legacy = tracked({ runId: 'r1', trackedAt: undefined })
  expect(selectStaleTrackedRuns([legacy], new Set(), 1_000, 1_000).map((r) => r.runId)).toEqual(['r1'])
})

test('from a mixed set, only the absent-past-TTL runs are returned', () => {
  const runs = [
    tracked({ runId: 'present', trackedAt: 0 }),
    tracked({ runId: 'fresh-absent', trackedAt: 950 }),
    tracked({ runId: 'stale-absent', trackedAt: 0 }),
  ]
  const staleIds = selectStaleTrackedRuns(runs, new Set(['present']), 1_000, 1_000).map((r) => r.runId)
  expect(staleIds.sort()).toEqual(['stale-absent'])
})

test('STALE_TRACKED_RUN_MS is a sane positive duration well above the poll interval', () => {
  expect(STALE_TRACKED_RUN_MS).toBeGreaterThan(60_000)
})
