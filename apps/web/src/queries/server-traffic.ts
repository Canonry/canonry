import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import type { TrafficSourceStatus } from '@ainyc/canonry-contracts'
import { TrafficSourceStatuses } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameTrafficEventsOptions,
  getApiV1ProjectsByNameTrafficSourcesByIdOptions,
  getApiV1ProjectsByNameTrafficSourcesOptions,
  getApiV1ProjectsByNameTrafficStatusOptions,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import {
  connectServerTrafficCloudRun,
  connectServerTrafficVercel,
  connectServerTrafficWordpress,
  heyClient,
  triggerServerTrafficSync,
  type ApiTrafficSyncResult,
  type TrafficConnectCloudRunRequest,
  type TrafficConnectVercelRequest,
  type TrafficConnectWordpressRequest,
} from '../api.js'
import type { MetricTone } from '../view-models.js'
import { TRAFFIC_STALE_MS } from './query-client.js'

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

/**
 * Coerce the filter object into the URL-string shape the generated SDK
 * expects (`limit` is `string` in the query schema because `?limit=10`
 * is always a string before parsing).
 */
function paramsForFilters(filters: ServerTrafficEventsFilters): {
  kind?: string
  sourceId?: string
  since?: string
  limit?: string
} {
  const params: { kind?: string; sourceId?: string; since?: string; limit?: string } = {}
  if (filters.kind && filters.kind !== 'all') params.kind = filters.kind
  if (filters.sourceId) params.sourceId = filters.sourceId
  if (filters.sinceMinutes !== undefined) {
    params.since = new Date(Date.now() - filters.sinceMinutes * 60_000).toISOString()
  }
  if (filters.limit !== undefined) params.limit = String(filters.limit)
  return params
}

/**
 * Invalidate every generated traffic query for a project. The generated
 * `<op>QueryKey` helpers produce flat keys (`[{ _id: 'getApiV1ProjectsByNameTrafficSources', … }]`)
 * with no shared hierarchical prefix, so we match by operation-id pattern
 * rather than invalidating each one individually — keeps it robust against
 * new traffic endpoints landing in the SDK.
 */
function invalidateTrafficQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0] as { _id?: string } | undefined
      return typeof head?._id === 'string' && head._id.startsWith('getApiV1ProjectsByNameTraffic')
    },
  })
}

export function useServerTrafficSources(project: string | null) {
  return useQuery({
    ...getApiV1ProjectsByNameTrafficSourcesOptions({ client: heyClient, path: { name: project ?? '' } }),
    enabled: Boolean(project),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficStatus(project: string | null) {
  return useQuery({
    ...getApiV1ProjectsByNameTrafficStatusOptions({ client: heyClient, path: { name: project ?? '' } }),
    enabled: Boolean(project),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficSource(project: string | null, sourceId: string | null) {
  return useQuery({
    ...getApiV1ProjectsByNameTrafficSourcesByIdOptions({
      client: heyClient,
      path: { name: project ?? '', id: sourceId ?? '' },
    }),
    enabled: Boolean(project && sourceId),
    staleTime: TRAFFIC_STALE_MS,
  })
}

export function useServerTrafficEvents(
  project: string | null,
  filters: ServerTrafficEventsFilters,
) {
  return useQuery({
    ...getApiV1ProjectsByNameTrafficEventsOptions({
      client: heyClient,
      path: { name: project ?? '' },
      query: paramsForFilters(filters),
    }),
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
      invalidateTrafficQueries(queryClient)
    },
  })
}

export function useConnectServerTrafficWordpress(project: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: TrafficConnectWordpressRequest) => {
      if (!project) throw new Error('Project is required to connect a WordPress source')
      return connectServerTrafficWordpress(project, request)
    },
    onSuccess: () => {
      if (!project) return
      invalidateTrafficQueries(queryClient)
    },
  })
}

export function useConnectServerTrafficVercel(project: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: TrafficConnectVercelRequest) => {
      if (!project) throw new Error('Project is required to connect a Vercel source')
      return connectServerTrafficVercel(project, request)
    },
    onSuccess: () => {
      if (!project) return
      invalidateTrafficQueries(queryClient)
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
      invalidateTrafficQueries(queryClient)
      // Refresh the top-level runs list so the just-created sync run
      // appears. Exact-key match (not a `getApiV1Runs` prefix) so we
      // don't churn unrelated run-detail caches.
      void queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) })
    },
  })
}
