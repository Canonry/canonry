import { useMutation } from '@tanstack/react-query'
import { RunKinds } from '@ainyc/canonry-contracts'
import {
  ApiError,
  type ApiRun,
  type ApiTriggerAllRunsResult,
  appendQueries,
  triggerRun,
  triggerAllRuns,
  triggerSiteAudit,
  triggerGscSync,
  triggerDiscoverSitemaps,
  triggerInspectSitemap,
} from '../api.js'
import { useAccount } from '../contexts/account-context.js'
import { assertCanWrite } from '../lib/write-guard.js'
import { createTrackedBatch, trackRun, type TrackedRunSourceAction } from '../lib/run-tracker-store.js'
import { addToast } from '../lib/toast-store.js'

/**
 * Refuse a view-only account before the request goes out.
 *
 * Every hook below runs this first. Wrapping each individual control in a
 * `WriteButton` is the visible half of the same rule, but a page has dozens of
 * controls and one will eventually be added without the wrapper. This is where
 * that mistake becomes a clear refusal instead of a request that travels to the
 * server and comes back 403.
 */
function useWriteGuard(): () => void {
  const account = useAccount()
  return () => { assertCanWrite(account) }
}

function queuedTitleForRun(kind: string) {
  if (kind === 'gsc-sync') return 'GSC sync queued'
  if (kind === 'inspect-sitemap') return 'Sitemap inspection queued'
  return 'Visibility sweep queued'
}

function queuedDetailForRun(projectLabel: string | undefined, kind: string) {
  const label = projectLabel ?? 'Project'
  if (kind === 'gsc-sync') return `${label} will refresh after the sync completes.`
  if (kind === 'inspect-sitemap') return `${label} will notify you when sitemap inspection finishes.`
  return `${label} will notify you when the run finishes.`
}

function queueTrackedRunToast(run: ApiRun, options: {
  projectLabel?: string
  sourceAction: TrackedRunSourceAction
}) {
  trackRun({
    id: run.id,
    projectId: run.projectId,
    kind: run.kind,
    projectLabel: options.projectLabel,
    sourceAction: options.sourceAction,
    lastAnnouncedStatus: 'queued',
  })

  addToast({
    title: queuedTitleForRun(run.kind),
    detail: queuedDetailForRun(options.projectLabel, run.kind),
    tone: 'neutral',
    dedupeKey: `run:${run.id}`,
    dedupeMode: 'replace',
  })
}

function queueTrackedBatchToast(results: ApiTriggerAllRunsResult[]) {
  const queuedRuns = results.filter(
    (result): result is ApiRun & { projectName: string } =>
      result.status !== 'conflict' && result.status !== 'error',
  )
  const conflictRuns = results.filter(
    (result): result is Extract<ApiTriggerAllRunsResult, { status: 'conflict' }> =>
      result.status === 'conflict',
  )
  const blockedRuns = results.filter(
    (result): result is Extract<ApiTriggerAllRunsResult, { status: 'error' }> =>
      result.status === 'error',
  )
  const skippedCount = conflictRuns.length + blockedRuns.length

  if (queuedRuns.length === 0) {
    const blockers = [
      blockedRuns.length > 0
        ? `${blockedRuns.length} need provider or query setup`
        : null,
      conflictRuns.length > 0
        ? `${conflictRuns.length} already have an active run`
        : null,
    ].filter((part): part is string => part !== null)
    addToast({
      title: 'No runs queued',
      detail: blockers.length > 0
        ? `${blockers.join('; ')}.`
        : 'No projects were available to queue.',
      tone: 'caution',
      durationMs: 8000,
      dedupeKey: 'run-all:conflict',
      dedupeMode: 'replace',
    })
    return
  }

  for (const run of queuedRuns) {
    trackRun({
      id: run.id,
      projectId: run.projectId,
      kind: run.kind,
      projectLabel: run.projectName,
      sourceAction: 'run-all',
      lastAnnouncedStatus: 'queued',
    })
  }

  const batchId = createTrackedBatch({
    runIds: queuedRuns.map(run => run.id),
    queuedCount: queuedRuns.length,
    skippedCount,
  })

  addToast({
    title: 'Run-all batch queued',
    detail: skippedCount > 0
      ? `${queuedRuns.length} project${queuedRuns.length === 1 ? '' : 's'} queued; ${skippedCount} need attention or already have an active run.`
      : `${queuedRuns.length} project${queuedRuns.length === 1 ? '' : 's'} queued.`,
    tone: skippedCount > 0 ? 'caution' : 'neutral',
    dedupeKey: `batch:${batchId}`,
    dedupeMode: 'replace',
  })
}

function handleTrackedRunError(error: unknown, options?: {
  projectKey?: string
  projectLabel?: string
  sourceAction?: TrackedRunSourceAction
}) {
  if (error instanceof ApiError && error.code === 'PROVIDERS_FAILING') {
    addToast({
      title: 'Sweep not started',
      detail: 'Every provider keeps failing on its account. The AI Visibility notice says when sweeps resume.',
      tone: 'caution',
      durationMs: 8000,
      dedupeKey: `providers-failing:${options?.projectKey ?? 'project'}:${options?.sourceAction ?? 'run'}`,
      dedupeMode: 'replace',
    })
    return
  }
  if (error instanceof ApiError && error.code === 'RUN_IN_PROGRESS') {
    addToast({
      title: 'Run already in progress',
      detail: options?.projectLabel ? `${options.projectLabel} already has an active run. Wait for it to finish, then retry.` : 'This project already has an active run. Wait for it to finish, then retry.',
      tone: 'caution',
      durationMs: 8000,
      dedupeKey: `run-in-progress:${options?.projectKey ?? 'project'}:${options?.sourceAction ?? 'run'}`,
      dedupeMode: 'replace',
    })
    return
  }

  addToast({
    title: error instanceof Error ? error.message : 'Failed to queue run',
    tone: 'negative',
  })
}

export function useTriggerRun() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      opts?: Parameters<typeof triggerRun>[1]
      projectLabel?: string
      sourceAction: TrackedRunSourceAction
    }) => triggerRun(projectName, opts),
    onSuccess: (run, variables) => {
      queueTrackedRunToast(run, {
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: variables.sourceAction,
      })
    },
    onError: (error, variables) => {
      if (variables.sourceAction === 'setup-launch') return
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: variables.sourceAction,
      })
    },
  })
}

export function useTriggerAllRuns() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: (body?: { providers?: string[] }) => triggerAllRuns(body),
    onSuccess: (results) => {
      queueTrackedBatchToast(results)
    },
    onError: (error) => {
      addToast({
        title: error instanceof Error ? error.message : 'Failed to queue runs',
        tone: 'negative',
      })
    },
  })
}

export function useTriggerSiteAudit() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, body }: {
      projectName: string
      projectId: string
      projectLabel?: string
      suppressErrorToast?: boolean
      body?: Parameters<typeof triggerSiteAudit>[1]
    }) => triggerSiteAudit(projectName, body),
    onSuccess: (result, variables) => {
      trackRun({
        id: result.runId,
        projectId: variables.projectId,
        kind: RunKinds['site-audit'],
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'site-audit',
        lastAnnouncedStatus: result.status,
      })
      addToast({
        title: result.status === 'running' ? 'Site Health scan already running' : 'Site Health scan queued',
        detail: `${variables.projectLabel ?? variables.projectName} will refresh automatically when the scan finishes.`,
        tone: 'neutral',
        dedupeKey: `run:${result.runId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error, variables) => {
      if (variables.suppressErrorToast) return
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'site-audit',
      })
    },
  })
}

export function useTriggerGscSync() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      projectLabel?: string
      opts?: Parameters<typeof triggerGscSync>[1]
    }) => triggerGscSync(projectName, opts),
    onSuccess: (run, variables) => {
      queueTrackedRunToast(run, {
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'gsc-sync',
      })
    },
    onError: (error, variables) => {
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'gsc-sync',
      })
    },
  })
}

export function useTriggerDiscoverSitemaps() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName }: {
      projectName: string
      projectLabel?: string
    }) => triggerDiscoverSitemaps(projectName),
    onSuccess: (result, variables) => {
      queueTrackedRunToast(result.run, {
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'discover-sitemaps',
      })
    },
    onError: (error, variables) => {
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'discover-sitemaps',
      })
    },
  })
}

export function useTriggerInspectSitemap() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      projectLabel?: string
      opts?: Parameters<typeof triggerInspectSitemap>[1]
    }) => triggerInspectSitemap(projectName, opts),
    onSuccess: (run, variables) => {
      queueTrackedRunToast(run, {
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'inspect-sitemap',
      })
    },
    onError: (error, variables) => {
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: 'inspect-sitemap',
      })
    },
  })
}

/**
 * Predicate matching the per-project dashboard detail query keys. Two
 * composite hooks build the project page today and both need to be
 * invalidated when project-scoped state changes (queries, competitors,
 * dismissed recommendations, etc.):
 *
 *   - `useDashboard` (legacy portfolio-wide) — key shape
 *     `['projects', projectId, latestRunIdsKey]` from `use-dashboard.ts`.
 *   - `useProjectDashboard` (current per-project, used by `ProjectPage`)
 *     — key shape `['project-dashboard-full', projectId, latestRunIdsKey]`
 *     from `use-project-dashboard.ts`. The split was added in
 *     `use-project-dashboard.ts` to avoid the per-project fan-out tax
 *     that the legacy hook paid on every dashboard mount.
 *
 * When the project hook was added, this predicate was not updated and
 * silently stopped matching the per-project page, so newly-added queries
 * / competitors didn't appear until the user reloaded the page or the
 * 30-minute staleTime expired. Keep both prefixes in the allow-list
 * until the legacy hook is fully removed.
 */
export function isProjectDetailQuery(query: { queryKey: readonly unknown[] }): boolean {
  if (!Array.isArray(query.queryKey) || query.queryKey.length <= 1) return false
  const head: unknown = query.queryKey[0]
  return head === 'projects' || head === 'project-dashboard-full'
}

export function useAppendQueries() {
  const guardWrite = useWriteGuard()
  return useMutation({
    onMutate: guardWrite,
    mutationFn: ({ projectName, queries }: { projectName: string; queries: string[] }) =>
      appendQueries(projectName, queries),
  })
}
