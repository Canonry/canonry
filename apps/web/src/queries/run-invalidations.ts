import type { QueryClient } from '@tanstack/react-query'

import { RunKinds, type RunKind } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsQueryKey,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../api.js'

/**
 * Invalidate every generated TanStack query whose operation id starts
 * with `prefix`. The SDK-generated `<op>QueryKey` helpers produce flat
 * keys (`[{_id: 'getApiV1...', ...}]`) with no shared hierarchical
 * prefix, so we match by name pattern rather than referencing a
 * legacy `queryKeys.<domain>.project(name)` hierarchy.
 *
 * Caution: prefix matching is greedy — `'getApiV1Projects'` matches the
 * entire project sub-tree (Bing, GSC, GA, etc.), not just the bare
 * `/projects` list. For "exactly the top-level list" use the direct
 * `getApiV1ProjectsQueryKey` helper instead.
 */
function invalidateByOpPrefix(queryClient: QueryClient, prefix: string) {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0] as { _id?: string } | undefined
      return typeof head?._id === 'string' && head._id.startsWith(prefix)
    },
  })
}

/**
 * Map a run kind to the SDK operation prefixes it invalidates.
 *
 * When a run completes (or is queued, depending on the call site), the data
 * surfaces it touched should be marked stale so the UI re-fetches. Adding a
 * new `RunKind` variant requires extending this switch — TypeScript will
 * fail compilation at the `_exhaustive` line if a case is ever missed.
 */
export function invalidateQueriesForRunKind(
  queryClient: QueryClient,
  kind: RunKind,
  _projectName: string,
): void {
  // Exact-key invalidations for the two top-level lists. We do NOT prefix
  // match `'getApiV1Projects'` here because that would also invalidate
  // every per-project sub-endpoint (Bing, GSC, GA, etc.) — see the switch
  // below for the surgical per-domain invalidations.
  void queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) })
  void queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })

  switch (kind) {
    case RunKinds['answer-visibility']:
    case RunKinds['site-audit']:
    case RunKinds['backlink-extract']:
      return
    case RunKinds['gsc-sync']:
    case RunKinds['inspect-sitemap']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameGoogleGsc')
      return
    case RunKinds['ga-sync']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameGa')
      return
    case RunKinds['traffic-sync']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameGa')
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameTraffic')
      return
    case RunKinds['bing-inspect']:
    case RunKinds['bing-inspect-sitemap']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameBing')
      return
    case RunKinds['aeo-discover-seed']:
    case RunKinds['aeo-discover-probe']:
      return
    case RunKinds['gbp-sync']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameGbp')
      return
    case RunKinds['ads-sync']:
      invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameAds')
      return
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}
