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
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
  })
}
