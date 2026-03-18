import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  appendKeywords,
  deleteKeywords,
  fetchCompetitors,
  setCompetitors,
  triggerRun,
  triggerAllRuns,
  deleteProject,
  updateOwnedDomains,
  updateProject,
  createProject,
} from '../api.js'
import { queryKeys } from './query-keys.js'

export function useTriggerRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectName: string) => triggerRun(projectName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useTriggerAllRuns() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => triggerAllRuns(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectName: string) => deleteProject(projectName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
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
    mutationFn: ({ name, body }: Parameters<typeof createProject> extends [infer N, infer B] ? { name: N; body: B } : never) =>
      createProject(name, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
  })
}
