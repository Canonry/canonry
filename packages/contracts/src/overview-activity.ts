import { RunKinds, RunStatuses, RunTriggers, type RunKind, type RunStatus } from './run.js'
import { compareText } from './text-order.js'

/**
 * How Overview's Activity reads the instance's run list: the newest jobs, with
 * per-URL inspections and routine traffic pulls left out so they cannot crowd
 * out the jobs a person acts on. The dashboard and `canonry overview --all`
 * read `GET /runs` with these parameters.
 */
export const OVERVIEW_ACTIVITY_RUN_WINDOW = 100
export const OVERVIEW_ACTIVITY_EXCLUDED_KINDS: readonly RunKind[] = [RunKinds['bing-inspect'], RunKinds['traffic-sync']]

/** A latest run in one of these states needs a person or is still working. */
const ACTIVITY_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatuses.failed,
  RunStatuses.partial,
  RunStatuses.cancelled,
  RunStatuses.queued,
  RunStatuses.running,
])

export interface OverviewActivityRun {
  id: string
  projectId: string
  kind: RunKind
  status: RunStatus
  trigger: string
  createdAt: string
}

/**
 * Overview's Activity: for each project and kind of job, its latest run, kept
 * only when it failed, finished partly, was cancelled, or is still queued or
 * running. A job that failed and then succeeded is fixed, so it is not listed.
 * Probes are operator inspections and never count. Newest first, ties by id.
 */
export function overviewActivityRuns<T extends OverviewActivityRun>(runs: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const run of runs) {
    if (run.trigger === RunTriggers.probe) continue
    const key = `${run.projectId}\u0000${run.kind}`
    const seen = latest.get(key)
    if (seen === undefined || newestFirst(run, seen) < 0) latest.set(key, run)
  }
  return [...latest.values()]
    .filter(run => ACTIVITY_STATUSES.has(run.status))
    .sort(newestFirst)
}

function newestFirst(left: OverviewActivityRun, right: OverviewActivityRun): number {
  return compareText(right.createdAt, left.createdAt) || compareText(right.id, left.id)
}
