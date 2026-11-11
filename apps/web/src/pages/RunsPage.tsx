import { useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { RunKinds, RunStatuses, type RunKind, type RunStatus } from '@canonry/canonry-contracts'
import { getApiV1ProjectsOptions, getApiV1RunsOptions } from '@canonry/canonry-api-client/react-query'

import { MANAGED_SWEEPS_COPY } from '../components/project/ManagedSweepStatus.js'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { WriteButton } from '../components/shared/AccessControls.js'
import { RunDetailLink } from '../components/shared/RunDetailLink.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { heyClient, isEmbed, isDashboardManagedSweeps } from '../api.js'
import { toRunListItem } from '../build-dashboard.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { toTitleCase } from '../lib/format-helpers.js'
import { extractErrorMessage } from '../lib/extract-error-message.js'
import { formatTrackedRunKind } from '../lib/run-labels.js'
import { useTriggerAllRuns } from '../queries/mutations.js'
import { RUNS_STALE_MS } from '../queries/query-client.js'
import type { RunListItemVm } from '../view-models.js'

type RunsSearch = {
  runStatus?: string
  runKind?: string
  runProject?: string
  runWindow?: string
  runQuery?: string
}

const RUN_WINDOWS = {
  '30d': { label: 'Last 30 days', days: 30 },
  '90d': { label: 'Last 90 days', days: 90 },
  '365d': { label: 'Last year', days: 365 },
} as const

function runSince(window: keyof typeof RUN_WINDOWS): string {
  return new Date(Date.now() - RUN_WINDOWS[window].days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Run all queues a paid AI Visibility check for every project at once, so it
 * gets the same review step as one project's check before anything is queued.
 * The count is the project list this credential reads, which is the set the
 * server queues; no API totals the work, so the dialog shows none.
 */
function RunAllConfirmation({ open, projectCount, pending, onOpenChange, onConfirm, onClosed }: {
  open: boolean
  projectCount: number
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onClosed: () => void
}) {
  const single = projectCount === 1
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay-scrim/70 backdrop-blur-sm" />
        <Dialog.Content
          className="material-modal fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5"
          onCloseAutoFocus={(event) => { event.preventDefault(); onClosed() }}
        >
          <div className="space-y-2">
            <Dialog.Title className="text-heading-20 text-heading">Review AI Visibility checks</Dialog.Title>
            <Dialog.Description className="text-copy-14 text-secondary">
              {single
                ? 'Checks 1 project. It runs its saved queries on its selected engines. Provider charges apply.'
                : `Checks all ${projectCount} projects. Each runs its saved queries on its selected engines. Provider charges apply.`}
            </Dialog.Description>
          </div>
          <p className="mt-4 text-copy-13 text-secondary">Runs once. Schedules stay unchanged. Projects already running or not set up are skipped.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <WriteButton type="button" disabled={pending} onClick={onConfirm}>
              {pending ? 'Queueing…' : `Run ${projectCount} ${single ? 'project' : 'projects'}`}
            </WriteButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function RunsPage() {
  const initialDashboard = useInitialDashboard()?.dashboard
  const search = useSearch({ strict: false }) as RunsSearch
  const navigate = useNavigate()
  const status = Object.values(RunStatuses).includes(search.runStatus as RunStatus)
    ? search.runStatus as RunStatus
    : 'all'
  const kind = Object.values(RunKinds).includes(search.runKind as RunKind)
    ? search.runKind as RunKind
    : 'all'
  const projectId = search.runProject ?? 'all'
  const window = Object.hasOwn(RUN_WINDOWS, search.runWindow ?? '')
    ? search.runWindow as keyof typeof RUN_WINDOWS
    : '30d'
  const query = search.runQuery ?? ''
  const since = useMemo(() => runSince(window), [window])

  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    initialData: initialDashboard?.projects.map(({ project }) => project),
    initialDataUpdatedAt: 0,
  })
  const runsQuery = useQuery({
    ...getApiV1RunsOptions({ client: heyClient, query: { limit: 1000, since } }),
    // The bootstrap model only carries answer-visibility runs. It keeps SSR
    // and first paint useful, then `initialDataUpdatedAt: 0` forces the live
    // all-kind history request immediately.
    initialData: initialDashboard?.runs,
    initialDataUpdatedAt: 0,
    staleTime: RUNS_STALE_MS,
    refetchInterval: (result) => result.state.data?.some((run) => run.status === RunStatuses.queued || run.status === RunStatuses.running) ? 3000 : RUNS_STALE_MS,
  })
  const triggerAllRunsMutation = useTriggerAllRuns()
  const [runAllOpen, setRunAllOpen] = useState(false)
  const runAllOpener = useRef<HTMLButtonElement | null>(null)

  const projectsById = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project.displayName || project.name])),
    [projectsQuery.data],
  )
  const runs = useMemo(
    () => (runsQuery.data ?? []).map((run) => 'projectName' in run
      ? run as RunListItemVm
      : toRunListItem(run, projectsById.get(run.projectId) ?? 'Unknown project')),
    [projectsById, runsQuery.data],
  )
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRuns = runs.filter((run) => {
    if (status !== 'all' && run.status !== status) return false
    if (kind !== 'all' && run.kind !== kind) return false
    if (projectId !== 'all' && run.projectId !== projectId) return false
    if (!normalizedQuery) return true
    return [run.summary, run.projectName, run.kindLabel, run.statusDetail]
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  })
  const hasFilters = status !== 'all' || kind !== 'all' || projectId !== 'all' || query.trim() !== '' || window !== '30d'

  const setSearch = (patch: RunsSearch) => {
    void navigate({
      to: '/runs',
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    })
  }

  if (projectsQuery.isLoading || runsQuery.isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-20" />
          <div className="skeleton-text-sm w-72" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="material-base p-3 flex items-center gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="skeleton-text w-40" />
                <div className="skeleton-text-sm w-56" />
              </div>
              <div className="skeleton h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Run all queues every project this credential can read, which is this list.
  const projectCount = projectsQuery.data?.length ?? 0

  const handleTriggerAll = async () => {
    try {
      await triggerAllRunsMutation.mutateAsync(undefined)
      setRunAllOpen(false)
    } catch {
      // Mutation hook surfaces the toast; the review stays open to retry or cancel.
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Runs</h1>
          <p className="page-subtitle">Recent jobs across all projects.</p>
        </div>
        {/* The review's confirm button carries the pending state, so this
            trigger stays enabled and takes focus back when the review closes. */}
        {!isEmbed() && (isDashboardManagedSweeps() ? <p className="text-copy-14 text-secondary">{MANAGED_SWEEPS_COPY}</p> : projectCount > 0 ? (
          <WriteButton
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            onClick={(event) => { runAllOpener.current = event.currentTarget; setRunAllOpen(true) }}
          >
            Run all projects
          </WriteButton>
        ) : null)}
      </div>
      {!isEmbed() && !isDashboardManagedSweeps() ? (
        <RunAllConfirmation
          open={runAllOpen}
          projectCount={projectCount}
          pending={triggerAllRunsMutation.isPending}
          onOpenChange={setRunAllOpen}
          onConfirm={() => void handleTriggerAll()}
          onClosed={() => runAllOpener.current?.focus()}
        />
      ) : null}

      <section>
        <div className="run-filters" role="group" aria-label="Run filters">
          <input
            type="search"
            aria-label="Search runs"
            value={query}
            onChange={(event) => setSearch({ runQuery: event.target.value || undefined })}
            placeholder="Search runs or projects"
            className="run-filter-control"
          />
          <select
            aria-label="Filter runs by status"
            value={status}
            onChange={(event) => setSearch({ runStatus: event.target.value === 'all' ? undefined : event.target.value })}
            className="run-filter-control"
          >
            <option value="all">All statuses</option>
            {Object.values(RunStatuses).map((value) => <option key={value} value={value}>{toTitleCase(value)}</option>)}
          </select>
          <select
            aria-label="Filter runs by project"
            value={projectId}
            onChange={(event) => setSearch({ runProject: event.target.value === 'all' ? undefined : event.target.value })}
            className="run-filter-control"
          >
            <option value="all">All projects</option>
            {(projectsQuery.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.displayName || project.name}</option>)}
          </select>
          <select
            aria-label="Filter runs by type"
            value={kind}
            onChange={(event) => setSearch({ runKind: event.target.value === 'all' ? undefined : event.target.value })}
            className="run-filter-control"
          >
            <option value="all">All run types</option>
            {Object.values(RunKinds).map((value) => <option key={value} value={value}>{formatTrackedRunKind(value)}</option>)}
          </select>
          <select
            aria-label="Filter runs by date range"
            value={window}
            onChange={(event) => setSearch({ runWindow: event.target.value === '30d' ? undefined : event.target.value })}
            className="run-filter-control"
          >
            {Object.entries(RUN_WINDOWS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select>
          {hasFilters ? (
            <Button type="button" variant="ghost" onClick={() => setSearch({ runStatus: undefined, runKind: undefined, runProject: undefined, runWindow: undefined, runQuery: undefined })}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {runsQuery.isError ? (
          <Card className="surface-card empty-card">
            <h2>Run history unavailable</h2>
            <p>{extractErrorMessage(runsQuery.error)}</p>
            <Button variant="outline" onClick={() => void runsQuery.refetch()}>Try again</Button>
          </Card>
        ) : null}

          {!runsQuery.isError && filteredRuns.length > 0 ? (
            <div className="data-table-wrapper">
              <table className="data-table runs-table">
                <caption className="sr-only">Recent runs across projects</caption>
                <thead><tr>
                  <th scope="col">Run</th>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Trigger</th>
                </tr></thead>
                <tbody>{filteredRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <RunDetailLink run={run} projectName={projectsQuery.data?.find(project => project.id === run.projectId)?.name}
                        className="text-link text-label-14-strong text-left"
                        label={`View ${run.summary} for ${run.projectName}`}>
                        {run.kindLabel}
                      </RunDetailLink>
                    </td>
                    <td>
                      <span className="text-primary">{run.projectName}</span>
                      {run.location ? <span className="block text-copy-13 text-secondary">{run.location}</span> : null}
                    </td>
                    <td><div className="flex items-center gap-1.5">
                      <StatusBadge status={run.status} />
                      <InfoTooltip text={run.statusDetail} />
                    </div></td>
                    <td className="whitespace-nowrap tabular-nums">{run.startedAt}</td>
                    <td className="whitespace-nowrap tabular-nums">{run.duration}</td>
                    <td className="whitespace-nowrap">{run.triggerLabel}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : !runsQuery.isError ? (
            <Card className="surface-card empty-card">
              <h2>{hasFilters ? 'No runs match these filters' : 'No recent runs'}</h2>
              <p>{hasFilters ? 'Change or clear the filters to see more runs.' : 'Start a check from a project, or choose a wider date range.'}</p>
            </Card>
          ) : null}
      </section>
    </div>
  )
}
