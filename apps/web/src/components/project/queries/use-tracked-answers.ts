import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueryTrackingResultsOptions } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import type { QueriesSectionProps } from '../DiscoverySection.js'

/**
 * One tracked query's answers on the sweep the Tracked list reads: the results
 * read narrowed to the query, which then carries each engine's `answerRows`.
 * It is read only while that query's row is open, and once per place, query
 * and sweep, so reopening a row makes no request.
 */
export function useTrackedAnswers(
  projectName: string,
  selection: Pick<NonNullable<QueriesSectionProps['selection']>, 'measurementScope' | 'measurementScopeKey'>,
  queryId: string,
  runId: string | undefined,
) {
  const place = selection.measurementScope !== 'project' && selection.measurementScopeKey
    ? { scope: selection.measurementScope, scopeKey: selection.measurementScopeKey }
    : {}
  return useQuery(getApiV1ProjectsByNameQueryTrackingResultsOptions({
    client: heyClient,
    path: { name: projectName },
    query: { ...place, queryId, ...(runId ? { runId } : {}) },
  }))
}
