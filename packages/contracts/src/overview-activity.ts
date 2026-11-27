import { z } from 'zod'
import { RunKinds, RunStatuses, RunTriggers, runDtoSchema, type RunKind, type RunStatus, type RunTrigger } from './run.js'
import { compareText } from './text-order.js'

/**
 * Overview's Activity reads the runs of this many days by default
 * (`GET /runs/attention` `since`). A job with no run since then is not listed.
 */
export const OVERVIEW_ACTIVITY_DEFAULT_DAYS = 30

/**
 * Per-URL inspections are left out: each URL is its own run, and one URL's
 * failed lookup is not a job a person acts on. Traffic syncs stay in: a sync
 * that keeps failing (revoked credentials) is exactly what Activity is for.
 */
export const OVERVIEW_ACTIVITY_EXCLUDED_KINDS: readonly RunKind[] = [RunKinds['bing-inspect']]

/** A latest run in one of these states needs a person or is still working. */
const ACTIVITY_STATUSES: ReadonlySet<RunStatus> = new Set([
  RunStatuses.failed,
  RunStatuses.partial,
  RunStatuses.cancelled,
  RunStatuses.queued,
  RunStatuses.running,
])

/** The run fields that identify a job and its state. A `RunDto` has them all. */
export interface OverviewActivityRun {
  id: string
  projectId: string
  kind: RunKind
  status: RunStatus
  trigger: RunTrigger
  createdAt: string
  /** Where the run measured. Runs at different locations are different jobs. */
  location?: string | null
  /** The source a sync read (a traffic source, an account). Different sources are different jobs. */
  sourceId?: string | null
  /** A spot check's query list. A spot check is a different job from a full sweep. */
  queries?: readonly string[] | null
  /** A spot check's plan scope (groups or targets). */
  measurementScope?: unknown
}

/** One job: a project's runs of one kind, at one location, from one source, full sweeps apart from spot checks. */
function jobKey(run: OverviewActivityRun): string {
  const spotCheck = run.queries != null || run.measurementScope != null
  return [run.projectId, run.kind, run.location ?? '', run.sourceId ?? '', spotCheck ? 'spot-check' : 'full'].join('\u0000')
}

/**
 * Overview's Activity: each job's latest run, kept only when it failed,
 * finished partly, was cancelled, or is still queued or running. A job that
 * failed and then succeeded is fixed, so it is not listed; runs at other
 * locations, from other sources or of spot checks never stand in for it.
 * Probes are operator inspections and never count. Newest first, ties by id.
 *
 * `GET /runs/attention` applies this to every run of its window, so the
 * dashboard, `canonry activity`, `canonry overview --all` and MCP agree.
 */
export function overviewActivityRuns<T extends OverviewActivityRun>(runs: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const run of runs) {
    if (run.trigger === RunTriggers.probe) continue
    const key = jobKey(run)
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

/** `GET /runs/attention`: the jobs that need attention across the projects the key can see. */
export const runsAttentionDtoSchema = z.object({
  /** Runs created at or after this time were read. A job with no run since then is not listed. */
  since: z.string(),
  /** `overviewActivityRuns` of those runs, newest first, each with its project. Runs come without their measurement manifests. */
  items: z.array(z.object({
    project: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
    run: runDtoSchema,
  })),
})
export type RunsAttentionDto = z.infer<typeof runsAttentionDtoSchema>
