import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueryTrackingResultsOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import type { QueriesSectionProps } from '../DiscoverySection.js'
import { coverageByQuery } from './advanced/tracked-view-model.js'

const NO_ENGINES: readonly string[] = []
/** A read that failed holds no result, so every chip reads Not checked, never No. */
const NO_RESULTS = coverageByQuery({ rows: [] })

/**
 * The last sweep's Mentioned and Cited for every tracked query, in one read,
 * for the place the page is narrowed to. `coverage` is undefined while the
 * read is in flight, so the chips draw their skeleton; after a failed read it
 * holds no result and `isError` says so. `run` is null when no sweep has
 * finished, and undefined while that is not known.
 */
export function useTrackedResults(
  projectName: string,
  selection: Pick<NonNullable<QueriesSectionProps['selection']>, 'measurementScope' | 'measurementScopeKey'>,
) {
  const place = selection.measurementScope !== 'project' && selection.measurementScopeKey
    ? { scope: selection.measurementScope, scopeKey: selection.measurementScopeKey }
    : undefined
  const query = useQuery(getApiV1ProjectsByNameQueryTrackingResultsOptions({ client: heyClient, path: { name: projectName }, ...(place ? { query: place } : {}) }))
  const { data } = query
  const failed = query.isError && data === undefined
  const coverage = useMemo(() => failed ? NO_RESULTS : coverageByQuery(data), [data, failed])
  return {
    coverage,
    engines: data?.engines ?? NO_ENGINES,
    run: data?.run,
    pendingRows: data?.pendingRows,
    isError: failed,
    refetch: query.refetch,
  }
}
