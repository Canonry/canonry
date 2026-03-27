import type { ApiRun } from '../api.js'

export type TrackedRunSourceAction =
  | 'project-run'
  | 'setup-launch'
  | 'run-all'
  | 'gsc-sync'
  | 'discover-sitemaps'
  | 'inspect-sitemap'

export interface TrackedRun {
  runId: string
  projectId: string
  projectLabel?: string
  kind: string
  sourceAction: TrackedRunSourceAction
  lastAnnouncedStatus: string
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

export function hasTrackedRunsOrBatches() {
  const snapshot = getRunTrackerState()
  return Object.keys(snapshot.runs).length > 0 || Object.keys(snapshot.batches).length > 0
}

export function trackRun(run: Pick<ApiRun, 'id' | 'projectId' | 'kind'> & {
  projectLabel?: string
  sourceAction: TrackedRunSourceAction
  lastAnnouncedStatus?: string
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
