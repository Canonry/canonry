import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { RunKinds } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsQueryKey,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import {
  ApiError,
  heyClient,
  type ApiRun,
  type ApiTriggerAllRunsResult,
  analyzeRecommendation,
  appendQueries,
  dismissContentTarget,
  triggerRun,
  triggerAllRuns,
  triggerGscSync,
  triggerDiscoverSitemaps,
  triggerInspectSitemap,
  undismissContentTarget,
} from '../api.js'
import type {
  ContentTargetDismissRequest,
  RecommendationExplainRequest,
  RecommendationExplanationDto,
} from '@ainyc/canonry-contracts'
import { createTrackedBatch, trackRun, type TrackedRunSourceAction } from '../lib/run-tracker-store.js'
import { addToast } from '../lib/toast-store.js'
import { invalidateQueriesForRunKind } from './run-invalidations.js'

/**
 * Invalidate the two top-level list endpoints. We use exact-key matches
 * (not a prefix predicate) so we don't accidentally invalidate every
 * project sub-endpoint — Bing/GSC/GA all live under `/projects/:name/...`
 * and have separate, more surgical invalidation flows below.
 */
function invalidateProjectAndRunQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) })
  void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })
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
  const queuedRuns = results.filter((result): result is ApiRun & { projectName: string } => result.status !== 'conflict')
  const skippedRuns = results.filter((result): result is Extract<ApiTriggerAllRunsResult, { status: 'conflict' }> => result.status === 'conflict')

  if (queuedRuns.length === 0) {
    addToast({
      title: 'No runs queued',
      detail: skippedRuns.length > 0
        ? `${skippedRuns.length} project${skippedRuns.length === 1 ? '' : 's'} already had a run in progress.`
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
    skippedCount: skippedRuns.length,
  })

  addToast({
    title: 'Run-all batch queued',
    detail: skippedRuns.length > 0
      ? `${queuedRuns.length} project${queuedRuns.length === 1 ? '' : 's'} queued, ${skippedRuns.length} skipped because a run is already active.`
      : `${queuedRuns.length} project${queuedRuns.length === 1 ? '' : 's'} queued.`,
    tone: skippedRuns.length > 0 ? 'caution' : 'neutral',
    dedupeKey: `batch:${batchId}`,
    dedupeMode: 'replace',
  })
}

function handleTrackedRunError(error: unknown, options?: {
  projectKey?: string
  projectLabel?: string
  sourceAction?: TrackedRunSourceAction
}) {
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
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      opts?: Parameters<typeof triggerRun>[1]
      projectLabel?: string
      sourceAction: TrackedRunSourceAction
    }) => triggerRun(projectName, opts),
    onSuccess: (run, variables) => {
      invalidateProjectAndRunQueries(queryClient)
      queueTrackedRunToast(run, {
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: variables.sourceAction,
      })
    },
    onError: (error, variables) => {
      handleTrackedRunError(error, {
        projectKey: variables.projectName,
        projectLabel: variables.projectLabel ?? variables.projectName,
        sourceAction: variables.sourceAction,
      })
    },
  })
}

export function useTriggerAllRuns() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: (body?: { providers?: string[] }) => triggerAllRuns(body),
    onSuccess: (results) => {
      invalidateProjectAndRunQueries(queryClient)
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

export function useTriggerGscSync() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      projectLabel?: string
      opts?: Parameters<typeof triggerGscSync>[1]
    }) => triggerGscSync(projectName, opts),
    onSuccess: (run, variables) => {
      invalidateQueriesForRunKind(queryClient, RunKinds['gsc-sync'], variables.projectName)
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
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName }: {
      projectName: string
      projectLabel?: string
    }) => triggerDiscoverSitemaps(projectName),
    onSuccess: (result, variables) => {
      invalidateQueriesForRunKind(queryClient, result.run.kind, variables.projectName)
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
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: ({ projectName, opts }: {
      projectName: string
      projectLabel?: string
      opts?: Parameters<typeof triggerInspectSitemap>[1]
    }) => triggerInspectSitemap(projectName, opts),
    onSuccess: (run, variables) => {
      invalidateQueriesForRunKind(queryClient, RunKinds['inspect-sitemap'], variables.projectName)
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
 * Predicate matching the per-project dashboard detail query keys (shape
 * `['projects', projectId, latestRunIdsKey]` — see `use-dashboard.ts`).
 * Used by mutations that change project-scoped state which is rendered out
 * of that composite query (suggested queries, content recommendations,
 * etc.) so the dashboard refetches and the UI reflects the new state.
 */
function isProjectDetailQuery(query: { queryKey: readonly unknown[] }): boolean {
  return Array.isArray(query.queryKey)
    && query.queryKey[0] === 'projects'
    && query.queryKey.length > 1
}

export function useAppendQueries() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, queries }: { projectName: string; queries: string[] }) =>
      appendQueries(projectName, queries),
    onSuccess: () => {
      // Top-level projects list — exact key so we don't accidentally
      // invalidate every per-project sub-endpoint.
      void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })
      // The per-project dashboard detail in `use-dashboard.ts` (key shape
      // `['projects', projectId, latestRunIdsKey]`) is where the
      // SuggestedQueriesCard reads its `rows`. Without invalidating it the
      // newly-tracked query still shows up as "Suggested" until the user
      // hard-reloads. We don't know the projectId at mutation time (the
      // mutation has projectName), so use a predicate that matches the
      // dashboard's tuple shape — first element is the literal `'projects'`
      // string with at least one more element. The top-level invalidation
      // above uses a different key shape (from the generated SDK helper),
      // so there's no overlap.
      void queryClient.invalidateQueries({ predicate: isProjectDetailQuery })
    },
  })
}

/**
 * Mark one content recommendation as addressed. Backed by
 * `POST /projects/:name/content/dismissals` — idempotent upsert keyed by
 * `(projectId, targetRef)`. After success, invalidates both the project
 * report query (where action cards render with `targetRef`) and the
 * per-project dashboard detail (where overview-derived suggestions also
 * reflect the dismissal). The recommendation drops off both surfaces on
 * the next read.
 */
export function useDismissContentTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, body }: { projectName: string; body: ContentTargetDismissRequest }) =>
      dismissContentTarget(projectName, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        // Match every per-project op-id; the report endpoint is one of many,
        // and a content-target dismissal affects any DTO derived from
        // `buildContentTargetRows` (report, /content/targets,
        // /content/dismissals listing).
        predicate: (query) =>
          Array.isArray(query.queryKey)
          && typeof query.queryKey[0] === 'object'
          && query.queryKey[0] !== null
          && '_id' in query.queryKey[0]
          && typeof (query.queryKey[0] as { _id: unknown })._id === 'string'
          && (query.queryKey[0] as { _id: string })._id.startsWith('getApiV1ProjectsByName'),
      })
      void queryClient.invalidateQueries({ predicate: isProjectDetailQuery })
    },
  })
}

/** Reverse a content dismissal. Symmetric to `useDismissContentTarget`. */
export function useUndismissContentTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, targetRef }: { projectName: string; targetRef: string }) =>
      undismissContentTarget(projectName, targetRef),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey)
          && typeof query.queryKey[0] === 'object'
          && query.queryKey[0] !== null
          && '_id' in query.queryKey[0]
          && typeof (query.queryKey[0] as { _id: unknown })._id === 'string'
          && (query.queryKey[0] as { _id: string })._id.startsWith('getApiV1ProjectsByName'),
      })
      void queryClient.invalidateQueries({ predicate: isProjectDetailQuery })
    },
  })
}

/**
 * Generate (or fetch cached) LLM explanation for one content recommendation.
 * The backend caches per `(project, targetRef, promptVersion)` — repeat
 * calls without `forceRefresh` return the cached row free, so the natural
 * pattern is "fire on panel open, render `mutation.data`."
 *
 * We deliberately do NOT invalidate any project-scoped queries here: the
 * explanation is per-card and does not change the recommendation list,
 * health scores, or the report DTO. Pulling on those caches would churn
 * unrelated UI for no reason.
 *
 * The mutation's return value is the freshly-fetched explanation; callers
 * keep it locally (e.g. `mutation.data`) and re-render the panel from it.
 */
export function useAnalyzeRecommendation() {
  return useMutation<
    RecommendationExplanationDto,
    Error,
    { projectName: string; targetRef: string; body: RecommendationExplainRequest }
  >({
    mutationFn: ({ projectName, targetRef, body }) =>
      analyzeRecommendation(projectName, targetRef, body),
  })
}
