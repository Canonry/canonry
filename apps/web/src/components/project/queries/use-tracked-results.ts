import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameQueryTrackingResultsOptions } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import type { QueriesSectionProps } from '../DiscoverySection.js'
import { countsByQuery, coverageByQuery, rankByQuery } from './advanced/tracked-view-model.js'

const NO_ENGINES: readonly string[] = []
/** A read that failed holds no result, so every chip reads Not checked, never No. */
const NO_RESULTS = coverageByQuery({ rows: [] })
const NO_COUNTS = countsByQuery({ rows: [] })

/** What the read is asked beyond the place: the switch, the server's order, and the sweep before to compare with. */
export interface TrackedResultsReadOptions {
  signal?: 'mentioned' | 'cited'
  sort?: 'losing' | 'winning'
  /** Each engine's change and each type's rates against the sweep before. */
  compare?: boolean
  /** False holds the read back, for a page that lists something else. */
  enabled?: boolean
}

/**
 * The last sweep's Mentioned and Cited for every tracked query, in one read,
 * for the place the page is narrowed to. `coverage` is undefined while the
 * read is in flight, so the chips draw their skeleton; after a failed read it
 * holds no result and `isError` says so. `run` is null when no sweep has
 * finished, and undefined while that is not known. With `sort`, `rank` is the
 * server's order of the rows: by the share of engines that show the signal,
 * which `counts` holds for each row, then by its share of answers.
 */
export function useTrackedResults(
  projectName: string,
  selection: Pick<NonNullable<QueriesSectionProps['selection']>, 'measurementScope' | 'measurementScopeKey'>,
  options: TrackedResultsReadOptions = {},
) {
  const place = selection.measurementScope !== 'project' && selection.measurementScopeKey
    ? { scope: selection.measurementScope, scopeKey: selection.measurementScopeKey }
    : undefined
  const { signal, sort, compare, enabled = true } = options
  const read = {
    ...place,
    // The default signal is the server's, so it is left out of the read as it is out of the URL.
    ...(signal === 'cited' ? { signal } : {}),
    ...(sort ? { sort } : {}),
    ...(compare ? { compare: 'previous' as const } : {}),
  }
  const query = useQuery({ ...getApiV1ProjectsByNameQueryTrackingResultsOptions({ client: heyClient, path: { name: projectName }, ...(Object.keys(read).length > 0 ? { query: read } : {}) }), enabled })
  const { data } = query
  const failed = query.isError && data === undefined
  const coverage = useMemo(() => failed ? NO_RESULTS : coverageByQuery(data), [data, failed])
  const counts = useMemo(() => failed ? NO_COUNTS : countsByQuery(data), [data, failed])
  const rank = useMemo(() => sort && data ? rankByQuery(data) : undefined, [data, sort])
  return {
    coverage,
    counts,
    rank,
    engines: data?.engines ?? NO_ENGINES,
    run: data?.run,
    /** The sweep compared with: null when there is none, undefined without a comparison or while that is not known. */
    compareRun: data?.compareRun,
    pendingRows: data?.pendingRows,
    // The whole project's read, after a sweep. Left out for a place, before the first sweep and while the read is in flight.
    weakMarkets: data?.weakMarkets,
    // Mentioned and Cited over the listed rows, one entry per type, never pooled. Left out before the first sweep.
    totals: data?.totals,
    isError: failed,
    refetch: query.refetch,
  }
}

/**
 * The markets (or the groups of markets) of the project or of one group, as
 * one grouped read with each type's comparison: the Markets list and the
 * strip over it read the same response. `sort` is the server's order; a list
 * by name asks for none.
 */
export function useTrackedGroups(
  projectName: string,
  selection: Pick<NonNullable<QueriesSectionProps['selection']>, 'measurementScope' | 'measurementScopeKey'>,
  options: { grouping: 'market' | 'group'; signal: 'mentioned' | 'cited'; sort?: 'losing' | 'winning'; enabled: boolean },
) {
  const { grouping, signal, sort, enabled } = options
  const read = {
    ...(selection.measurementScope === 'group' && selection.measurementScopeKey ? { scope: 'group' as const, scopeKey: selection.measurementScopeKey } : {}),
    group: grouping,
    ...(signal === 'cited' ? { signal } : {}),
    ...(sort ? { sort } : {}),
    compare: 'previous' as const,
  }
  const query = useQuery({ ...getApiV1ProjectsByNameQueryTrackingResultsOptions({ client: heyClient, path: { name: projectName }, query: read }), enabled })
  return { read, data: query.data, isPending: query.isPending, isError: query.isError && query.data === undefined, refetch: query.refetch }
}
