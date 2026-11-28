import { and, count, desc, eq, gte, gt, inArray, isNull, notInArray, or } from 'drizzle-orm'
import { RunStatuses, formatRunErrorOneLine, parseRunError, type RunKind, type RunStatus } from '@canonry/canonry-contracts'
import { runs } from '@canonry/canonry-db'
import type { DoctorContext } from '../types.js'

/** Finished runs in a row that make a failure streak worth an alert. */
export const SYNC_FAILURE_WINDOW = 3

const FINISHED_STATUSES = [RunStatuses.completed, RunStatuses.partial, RunStatuses.failed]
const SUCCESS_STATUSES = [RunStatuses.completed, RunStatuses.partial]

export function latestErrorText(raw: string | null): string {
  const parsed = parseRunError(raw)
  return parsed ? formatRunErrorOneLine(parsed) : 'no error was recorded'
}

export interface SyncRunState {
  latestStatus: RunStatus | null
  latestRunAt: string | null
  latestRunId: string | null
  latestTrigger: string | null
  latestError: string | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  repeatedFailure: boolean
}

export function readSyncRunState(
  db: DoctorContext['db'],
  projectId: string,
  kind: RunKind,
  options: { since?: string | null; nothingToSyncErrors?: readonly string[]; sourceId?: string | null } = {},
): SyncRunState {
  const scope = and(
    eq(runs.projectId, projectId),
    eq(runs.kind, kind),
    ...(options.sourceId ? [eq(runs.sourceId, options.sourceId)] : []),
    ...(options.nothingToSyncErrors?.length ? [or(isNull(runs.error), notInArray(runs.error, [...options.nothingToSyncErrors]))] : []),
  )
  const graded = options.since ? and(scope, gte(runs.createdAt, options.since)) : scope
  const recent = db
    .select({ id: runs.id, status: runs.status, trigger: runs.trigger, error: runs.error, createdAt: runs.createdAt })
    .from(runs)
    .where(and(graded, inArray(runs.status, FINISHED_STATUSES)))
    .orderBy(desc(runs.createdAt))
    .limit(SYNC_FAILURE_WINDOW)
    .all()
  const lastSuccess = db
    .select({ createdAt: runs.createdAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(graded, inArray(runs.status, SUCCESS_STATUSES)))
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  const failureCount = db
    .select({ count: count() })
    .from(runs)
    .where(and(lastSuccess ? and(graded, gt(runs.createdAt, lastSuccess.createdAt)) : graded, eq(runs.status, RunStatuses.failed)))
    .get()
  const failuresSinceSuccess = Number(failureCount?.count ?? 0)
  const latest = recent[0]
  return {
    latestStatus: latest?.status as RunStatus | undefined ?? null,
    latestRunAt: latest?.createdAt ?? null,
    latestRunId: latest?.id ?? null,
    latestTrigger: latest?.trigger ?? null,
    latestError: latest?.status === RunStatuses.failed ? latestErrorText(latest.error) : null,
    lastSuccessAt: lastSuccess ? lastSuccess.finishedAt ?? lastSuccess.createdAt : null,
    consecutiveFailures: failuresSinceSuccess,
    repeatedFailure: recent.length >= SYNC_FAILURE_WINDOW && recent.every(run => run.status === RunStatuses.failed),
  }
}

