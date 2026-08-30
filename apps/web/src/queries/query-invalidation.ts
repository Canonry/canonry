import type { QueryClient } from '@tanstack/react-query'

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
  technicalAeo: 'getApiV1ProjectsByNameTechnicalAeo',
  measurement: 'getApiV1ProjectsByNameMeasurement',
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
