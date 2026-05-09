import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { TrafficSourceStatus } from '@ainyc/canonry-contracts'
import { TrafficSourceStatuses } from '@ainyc/canonry-contracts'

import {
  connectServerTrafficCloudRun,
  fetchServerTrafficEvents,
  fetchServerTrafficSource,
  fetchServerTrafficSources,
  fetchServerTrafficStatus,
  triggerServerTrafficSync,
  type ApiTrafficEvents,
  type ApiTrafficSourceDetail,
  type ApiTrafficSourceList,
  type ApiTrafficStatus,
  type ApiTrafficSyncResult,
  type TrafficConnectCloudRunRequest,
} from '../api.js'
import type { MetricTone } from '../view-models.js'
import { TRAFFIC_STALE_MS } from './query-client.js'
import { queryKeys } from './query-keys.js'

export function toneFromTrafficSourceStatus(status: TrafficSourceStatus): MetricTone {
  switch (status) {
    case TrafficSourceStatuses.connected:
      return 'positive'
    case TrafficSourceStatuses.paused:
      return 'caution'
    case TrafficSourceStatuses.error:
      return 'negative'
    case TrafficSourceStatuses.archived:
      return 'neutral'
  }
}

export interface ServerTrafficEventsFilters {
  kind?: 'all' | 'crawler' | 'ai-referral'
  sourceId?: string
  sinceMinutes?: number
  limit?: number
}

function paramsForFilters(filters: ServerTrafficEventsFilters): {
  kind?: 'all' | 'crawler' | 'ai-referral'
  sourceId?: string
  since?: string
  limit?: number
} {
  const params: { kind?: 'all' | 'crawler' | 'ai-referral'; sourceId?: string; since?: string; limit?: number } = {}
  if (filters.kind && filters.kind !== 'all') params.kind = filters.kind
  if (filters.sourceId) params.sourceId = filters.sourceId
  if (filters.sinceMinutes !== undefined) {
    params.since = new Date(Date.now() - filters.sinceMinutes * 60_000).toISOString()
  }
  if (filters.limit !== undefined) params.limit = filters.limit
  return params
}

export function useServerTrafficSources(project: string | null) {
  return useQuery<ApiTrafficSourceList>({
    queryKey: project ? queryKeys.serverTraffic.sources(project) : ['server-traffic', 'disabled'],
    queryFn: () => fetchServerTrafficSources(project!),
    enabled: Boolean(project),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficStatus(project: string | null) {
  return useQuery<ApiTrafficStatus>({
    queryKey: project ? queryKeys.serverTraffic.status(project) : ['server-traffic', 'status-disabled'],
    queryFn: () => fetchServerTrafficStatus(project!),
    enabled: Boolean(project),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficSource(project: string | null, sourceId: string | null) {
  return useQuery<ApiTrafficSourceDetail>({
    queryKey:
      project && sourceId
        ? queryKeys.serverTraffic.sourceDetail(project, sourceId)
        : ['server-traffic', 'detail-disabled'],
    queryFn: () => fetchServerTrafficSource(project!, sourceId!),
    enabled: Boolean(project && sourceId),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficEvents(
  project: string | null,
  filters: ServerTrafficEventsFilters,
) {
  return useQuery<ApiTrafficEvents>({
    queryKey: project ? queryKeys.serverTraffic.events(project, filters) : ['server-traffic', 'events-disabled'],
    queryFn: () => fetchServerTrafficEvents(project!, paramsForFilters(filters)),
    enabled: Boolean(project),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useConnectServerTrafficCloudRun(project: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: TrafficConnectCloudRunRequest) => {
      if (!project) throw new Error('Project is required to connect a Cloud Run source')
      return connectServerTrafficCloudRun(project, request)
    },
    onSuccess: () => {
      if (!project) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.serverTraffic.project(project) })
    },
  })
}

export function useSyncServerTrafficSource(project: string | null, sourceId: string | null) {
  const queryClient = useQueryClient()
  return useMutation<ApiTrafficSyncResult, Error, { sinceMinutes?: number } | void>({
    mutationFn: (variables) => {
      if (!project || !sourceId) throw new Error('Project and sourceId are required to sync')
      return triggerServerTrafficSync(project, sourceId, variables ?? undefined)
    },
    onSuccess: () => {
      if (!project) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.serverTraffic.project(project) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
  })
}
