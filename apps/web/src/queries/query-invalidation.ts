import type { Query, QueryClient } from '@tanstack/react-query'
import type { ApiProject, ApiRun } from '../api.js'

/**
 * Generated TanStack keys are flat (`[{ _id: 'getApiV1...' }]`), so cache
 * ownership is expressed by operation-id domains rather than array prefixes.
 * Keep the mapping centralized: mutations should choose the domain whose
 * response owns the changed field.
 */
export const PROJECT_QUERY_DOMAINS = {
  project: 'getApiV1ProjectsByName',
  google: 'getApiV1ProjectsByNameGoogle',
  gsc: 'getApiV1ProjectsByNameGoogleGsc',
  bing: 'getApiV1ProjectsByNameBing',
  ga: 'getApiV1ProjectsByNameGa',
  gbp: 'getApiV1ProjectsByNameGbp',
  ads: 'getApiV1ProjectsByNameAds',
  googleAds: 'getApiV1ProjectsByNameGoogleAds',
  gtm: 'getApiV1ProjectsByNameGtm',
  conversionTracking: 'getApiV1ProjectsByNameConversionTracking',
  traffic: 'getApiV1ProjectsByNameTraffic',
  discovery: 'getApiV1ProjectsByNameDiscover',
  researchRuns: 'getApiV1ProjectsByNameResearchRuns',
  visibilityReport: 'getApiV1ProjectsByNameVisibilityReport',
  queryTracking: 'getApiV1ProjectsByNameQueryTracking',
  technicalAeo: 'getApiV1ProjectsByNameTechnicalAeo',
  runs: 'getApiV1ProjectsByNameRuns',
} as const

export type ProjectQueryDomain = keyof typeof PROJECT_QUERY_DOMAINS

export function invalidateProjectQueryDomain(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  domain: ProjectQueryDomain,
): Promise<void> {
  const prefix = PROJECT_QUERY_DOMAINS[domain]
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0] as { _id?: string } | undefined
      return typeof head?._id === 'string' && head._id.startsWith(prefix)
    },
  })
}

/** Query publication changes live assignments and the measurement revision. */
export function invalidateQueryTrackingPublication(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  projectName: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: query => {
      const head = query.queryKey[0] as { _id?: string; path?: { name?: string } } | undefined
      if (head?.path?.name !== projectName || typeof head._id !== 'string') return false
      return head._id.startsWith('getApiV1ProjectsByNameMeasurement')
        || head._id === PROJECT_QUERY_DOMAINS.queryTracking
        || head._id === PROJECT_QUERY_DOMAINS.visibilityReport
        || head._id === 'getApiV1ProjectsByNameQueries'
        || head._id === 'getApiV1ProjectsByName'
    },
  })
}


interface SdkQueryKey {
  _id?: string
  path?: { name?: string }
}

const GLOBAL_PROJECT_READS = new Set([
  'getApiV1Projects', 'getApiV1Runs', 'getApiV1History', 'getApiV1NotificationsEvents',
])

/** Successful SDK writes refresh both generated queries and composite views. */
export async function refreshQueriesAfterWrite(queryClient: QueryClient, request: Request, body: unknown): Promise<void> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
  const pathname = new URL(request.url).pathname
  const apiPath = pathname.match(/\/api\/v1\/(.*)$/)?.[1]
  if (!apiPath || /^(?:telemetry|feedback|auth|session)(?:\/|$)/.test(apiPath)) return
  // These POSTs compute a preview or test a connection without changing saved data.
  if (/(?:^|\/)(?:[^/]*-preview|preview(?:-[^/]+)?|test|generate)$/.test(apiPath)) return
  const input = body && typeof body === 'object' ? body as { dryRun?: boolean; confirm?: boolean } : null
  if (input?.dryRun === true || (apiPath.endsWith('/results/clear') && input?.confirm !== true)) return

  const projectPath = apiPath.match(/^projects\/([^/]+)(?:\/(.*))?$/)
  const projectName = projectPath ? decodeURIComponent(projectPath[1]!) : null
  const agentOnly = projectPath?.[2]?.startsWith('agent/') ?? false
  const identities = new Set<string>(projectName ? [projectName] : [])
  const projectIds = new Set<string>()
  if (projectName) {
    for (const query of queryClient.getQueryCache().getAll()) {
      const head = query.queryKey[0] as SdkQueryKey | undefined
      const data = query.state.data
      const projects = head?._id === 'getApiV1Projects' && Array.isArray(data)
        ? data as ApiProject[]
        : data && typeof data === 'object' && 'project' in data ? [data.project as ApiProject]
        : head?._id === 'getApiV1ProjectsByName' ? [data as ApiProject | undefined] : []
      for (const project of projects) {
        if (project && (project.name === projectName || project.id === projectName)) {
          identities.add(project.name)
          identities.add(project.id)
          projectIds.add(project.id)
        }
      }
    }
  }

  const isProjectRead = (query: Query): boolean => {
    const head = query.queryKey[0] as SdkQueryKey | undefined
    if (agentOnly) {
      return (head?.path?.name === projectName && head._id?.startsWith('getApiV1ProjectsByNameAgent') === true)
        || (query.queryKey[0] === 'aero-preview' && query.queryKey[1] === projectName)
    }
    if (head?._id?.startsWith('getApiV1ProjectsByName') && head.path?.name && identities.has(head.path.name)) return true
    const namespace = query.queryKey[0]
    if (['projects', 'project-dashboard-full', 'project-overview-slim'].includes(namespace as string)) {
      return projectIds.has(query.queryKey[1] as string)
    }
    if (['sentiment', 'gbp-section-insights', 'analytics-metrics', 'aero-preview'].includes(namespace as string)) {
      // Competitor edits rotate the trend's frame key after refreshing its pin set.
      if (namespace === 'analytics-metrics' && projectPath?.[2]?.startsWith('competitors')) return false
      return identities.has(query.queryKey[1] as string)
    }
    if (namespace === 'setup') return identities.has(query.queryKey[2] as string)
    const data = query.state.data as ApiRun | undefined
    return head?._id === 'getApiV1RunsById' && !!data?.projectId && projectIds.has(data.projectId)
  }
  const isGlobalRead = (query: Query): boolean => GLOBAL_PROJECT_READS.has((query.queryKey[0] as SdkQueryKey | undefined)?._id ?? '')
  const predicate = projectName
    ? (query: Query) => isProjectRead(query) || (!agentOnly && isGlobalRead(query))
    : () => true

  // Supersede an initial read too: invalidation alone can reuse its pre-write response.
  await queryClient.cancelQueries({ predicate })
  if (projectPath && !projectPath[2] && request.method === 'DELETE') {
    queryClient.removeQueries({ predicate: isProjectRead })
    queryClient.setQueriesData<ApiProject[]>({ predicate: query => (query.queryKey[0] as SdkQueryKey | undefined)?._id === 'getApiV1Projects' },
      projects => projects?.filter(project => !identities.has(project.name) && !identities.has(project.id)))
    queryClient.setQueriesData<ApiRun[]>({ predicate: query => (query.queryKey[0] as SdkQueryKey | undefined)?._id === 'getApiV1Runs' },
      runs => runs?.filter(run => !projectIds.has(run.projectId)))
    await queryClient.invalidateQueries({ predicate: isGlobalRead })
    return
  }
  await queryClient.invalidateQueries({ predicate })
}
