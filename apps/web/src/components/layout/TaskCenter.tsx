import { useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { Link } from '@tanstack/react-router'

import { getApiV1RunsOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { formatTrackedRunKind } from '../../lib/run-labels.js'
import {
  getRunTrackerState,
  subscribeRunTracker,
} from '../../lib/run-tracker-store.js'
import { RUNS_STALE_MS } from '../../queries/query-client.js'
import { ToneBadge } from '../shared/ToneBadge.js'

function statusLabel(status: string) {
  if (status === 'running') return 'Running'
  if (status === 'queued') return 'Queued'
  if (status === 'partial') return 'Partial'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  return 'Starting'
}

export function TaskCenter() {
  const trackedState = useSyncExternalStore(subscribeRunTracker, getRunTrackerState, getRunTrackerState)
  const trackedRuns = useMemo(() => Object.values(trackedState.runs), [trackedState.runs])
  const hasTasks = trackedRuns.length > 0
  const runsQuery = useQuery({
    ...getApiV1RunsOptions({ client: heyClient }),
    enabled: hasTasks,
    staleTime: RUNS_STALE_MS,
  })
  const statuses = useMemo(
    () => new Map((runsQuery.data ?? []).map((run) => [run.id, run.status])),
    [runsQuery.data],
  )

  if (!hasTasks) return null

  const tasks = trackedRuns.map((run) => ({
    ...run,
    status: statuses.get(run.runId) ?? run.lastAnnouncedStatus,
  }))
  const summary = tasks.length === 1
    ? formatTrackedRunKind(tasks[0]!.kind)
    : `${tasks.length} active tasks`

  return (
    <div className="task-center">
      <p className="sr-only" role="status" aria-live="polite">
        {tasks.length} active {tasks.length === 1 ? 'task' : 'tasks'}.{' '}
        {tasks.map((task) => `${formatTrackedRunKind(task.kind)} ${statusLabel(task.status)}`).join('. ')}.
      </p>
      <details className="task-center-details">
        <summary className="task-center-trigger">
          <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          <span className="task-center-summary">{summary}</span>
          <span className="task-center-count" aria-hidden="true">{tasks.length}</span>
          <ChevronDown className="task-center-chevron size-3.5 shrink-0" aria-hidden="true" />
        </summary>
        <div className="task-center-panel">
          <div className="task-center-heading">
            <span>Active tasks</span>
            <span className="tabular-nums text-faint">{tasks.length}</span>
          </div>
          <ul className="task-center-list">
            {tasks.map((task) => (
              <li key={task.runId} className="task-center-item">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-strong">
                    {formatTrackedRunKind(task.kind)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {task.projectLabel ?? task.projectId}
                  </p>
                </div>
                <ToneBadge tone={task.status === 'failed' ? 'negative' : task.status === 'partial' ? 'caution' : 'neutral'}>
                  {statusLabel(task.status)}
                </ToneBadge>
              </li>
            ))}
          </ul>
          <Link to="/runs" className="task-center-footer-link">
            View all runs
          </Link>
        </div>
      </details>
    </div>
  )
}
