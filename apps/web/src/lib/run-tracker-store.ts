import type { ApiRun } from '../api.js'

export type TrackedRunSourceAction =
  | 'project-run'
  | 'setup-launch'
  | 'run-all'
  | 'gsc-sync'
  | 'gbp-sync'
  | 'site-audit'
  | 'discover-sitemaps'
  | 'inspect-sitemap'

export interface TrackedRun {
  runId: string
  projectId: string
  projectLabel?: string
  kind: ApiRun['kind']
  sourceAction: TrackedRunSourceAction
  lastAnnouncedStatus: string
  /** Epoch ms when the run was first tracked. Used to give up on a run that has
   *  aged out of the capped /runs window (see `selectStaleTrackedRuns`).
   *  Optional: rows persisted before this field existed hydrate without it. */
  trackedAt?: number
}

export interface TrackedBatch {
  batchId: string
  runIds: string[]
  queuedCount: number
  skippedCount: number
}

export interface RunTrackerState {
  runs: Record<string, TrackedRun>
  batches: Record<string, TrackedBatch>
}

type Listener = (state: RunTrackerState) => void

const STORAGE_KEY = 'canonry.run-tracker'
const listeners = new Set<Listener>()
let hydrated = false
let batchCounter = 0
let state: RunTrackerState = {
  runs: {},
  batches: {},
}

function emit() {
  const snapshot = getRunTrackerState()
  for (const listener of listeners) listener(snapshot)
}

function parseState(raw: string | null): RunTrackerState {
  if (!raw) {
    return { runs: {}, batches: {} }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RunTrackerState>
    return {
      runs: parsed.runs ?? {},
      batches: parsed.batches ?? {},
    }
  } catch {
    return { runs: {}, batches: {} }
  }
}

function persistState() {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function hydrateState() {
  if (hydrated) return
  hydrated = true
  if (typeof window === 'undefined') return
  state = parseState(window.sessionStorage.getItem(STORAGE_KEY))
}

function updateState(nextState: RunTrackerState) {
  state = nextState
  persistState()
  emit()
}

export function getRunTrackerState(): RunTrackerState {
  hydrateState()
  return state
}

export function subscribeRunTracker(listener: Listener): () => void {
  hydrateState()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function trackRun(run: Pick<ApiRun, 'id' | 'projectId' | 'kind'> & {
  projectLabel?: string
  sourceAction: TrackedRunSourceAction
  lastAnnouncedStatus?: string
  /** Override the tracked-at stamp (tests); defaults to now. */
  trackedAt?: number
}) {
  const snapshot = getRunTrackerState()
  updateState({
    ...snapshot,
    runs: {
      ...snapshot.runs,
      [run.id]: {
        runId: run.id,
        projectId: run.projectId,
        projectLabel: run.projectLabel,
        kind: run.kind,
        sourceAction: run.sourceAction,
        lastAnnouncedStatus: run.lastAnnouncedStatus ?? 'queued',
        trackedAt: run.trackedAt ?? Date.now(),
      },
    },
  })
}

export function removeTrackedRun(runId: string) {
  const snapshot = getRunTrackerState()
  if (!snapshot.runs[runId]) return
  const { [runId]: _removed, ...restRuns } = snapshot.runs
  updateState({
    ...snapshot,
    runs: restRuns,
  })
}

export function createTrackedBatch(input: {
  runIds: string[]
  queuedCount: number
  skippedCount: number
}): string {
  const snapshot = getRunTrackerState()
  const batchId = `batch_${Date.now()}_${++batchCounter}`
  updateState({
    ...snapshot,
    batches: {
      ...snapshot.batches,
      [batchId]: {
        batchId,
        runIds: input.runIds,
        queuedCount: input.queuedCount,
        skippedCount: input.skippedCount,
      },
    },
  })
  return batchId
}

export function removeTrackedBatch(batchId: string) {
  const snapshot = getRunTrackerState()
  if (!snapshot.batches[batchId]) return
  const { [batchId]: _removed, ...restBatches } = snapshot.batches
  updateState({
    ...snapshot,
    batches: restBatches,
  })
}

export function resetRunTracker() {
  state = { runs: {}, batches: {} }
  hydrated = false
  batchCounter = 0
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(STORAGE_KEY)
  }
  emit()
}

export const runTrackerStorageKey = STORAGE_KEY

export function isTerminalRunStatus(status: string) {
  return status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled'
}

/**
 * How long a tracked run may be ABSENT from the GET /runs response before the
 * observer gives up on it. GET /runs is capped (default 500 rows / a since
 * window), so a tracked run can age out of that window — cron syncs alone can
 * fill it in under an hour — after which the observer never sees it reach a
 * terminal status and its trigger button would wedge on "Syncing…"/"Running…"
 * forever. Absence is only ever the aged-out case (an in-flight run is still in
 * the window), so this is purely a backstop; a page reload clears it sooner.
 */
export const STALE_TRACKED_RUN_MS = 10 * 60_000

/**
 * Pure give-up rule: return the tracked runs that have aged out of the /runs
 * window and should be cleared. A run still PRESENT in `presentRunIds` is
 * never stale (the observer is still watching it); a run ABSENT for at least
 * `staleMs` (relative to `now`) has aged out. A run with no `trackedAt` (a row
 * persisted before this field existed) is treated as infinitely old, so any
 * pre-existing wedged run is cleared on the next poll.
 */
export function selectStaleTrackedRuns(
  trackedRuns: TrackedRun[],
  presentRunIds: Set<string>,
  now: number,
  staleMs: number,
): TrackedRun[] {
  return trackedRuns.filter(
    (run) => !presentRunIds.has(run.runId) && now - (run.trackedAt ?? 0) >= staleMs,
  )
}

export function summarizeBatchStatuses(runIds: string[], runsById: Record<string, ApiRun | undefined>) {
  let completed = 0
  let partial = 0
  let failed = 0
  let cancelled = 0
  let pending = 0

  for (const runId of runIds) {
    const status = runsById[runId]?.status
    if (status === 'completed') completed += 1
    else if (status === 'partial') partial += 1
    else if (status === 'failed') failed += 1
    else if (status === 'cancelled') cancelled += 1
    else pending += 1
  }

  return {
    completed,
    partial,
    failed,
    cancelled,
    pending,
    finished: pending === 0,
  }
}
