import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ApiError,
  type ApiRun,
  type ApiTriggerAllRunsResult,
  appendKeywords,
  deleteKeywords,
  fetchCompetitors,
  setCompetitors,
  triggerRun,
  triggerAllRuns,
  triggerGscSync,
  triggerDiscoverSitemaps,
  triggerInspectSitemap,
  deleteProject,
  updateOwnedDomains,
  updateProject,
  createProject,
} from '../api.js'
import { createTrackedBatch, trackRun, type TrackedRunSourceAction } from '../lib/run-tracker-store.js'
import { addToast } from '../lib/toast-store.js'
import { queryKeys } from './query-keys.js'

function invalidateProjectAndRunQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
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
      invalidateProjectAndRunQueries(queryClient)
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
      invalidateProjectAndRunQueries(queryClient)
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
      invalidateProjectAndRunQueries(queryClient)
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

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectName: string) => deleteProject(projectName),
    onSuccess: () => {
      invalidateProjectAndRunQueries(queryClient)
    },
  })
}

export function useAppendKeywords() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, keywords }: { projectName: string; keywords: string[] }) =>
      appendKeywords(projectName, keywords),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useDeleteKeywords() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, keywords }: { projectName: string; keywords: string[] }) =>
      deleteKeywords(projectName, keywords),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useAddCompetitors() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ projectName, domains }: { projectName: string; domains: string[] }) => {
      const existing = await fetchCompetitors(projectName)
      const existingDomains = existing.map(c => c.domain)
      const merged = [...new Set([...existingDomains, ...domains])]
      return setCompetitors(projectName, merged)
    },
    onMutate: async () => {
      // Cancel any in-flight project queries to avoid overwriting with stale data
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.all })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useUpdateOwnedDomains() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, ownedDomains }: { projectName: string; ownedDomains: string[] }) =>
      updateOwnedDomains(projectName, ownedDomains),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ projectName, updates }: {
      projectName: string
      updates: {
        displayName?: string
        canonicalDomain?: string
        ownedDomains?: string[]
        country?: string
        language?: string
      }
    }) => updateProject(projectName, updates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: Parameters<typeof createProject>[1] }) =>
      createProject(name, body),
    onSuccess: () => {
      invalidateProjectAndRunQueries(queryClient)
    },
  })
}
