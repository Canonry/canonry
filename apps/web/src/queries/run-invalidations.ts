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
 *
 * `_projectName` is unused today (every invalidation is either an exact
 * top-level key or an op-id prefix, neither of which is project-scoped) but
 * stays on the signature: it is what a future per-project hand-authored key
 * would need, and all four call sites already pass it.
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
  // The project page's runs list uses the PROJECT-SCOPED runs endpoint
  // (`getApiV1ProjectsByNameRuns`), not the global `/runs` list above, so it
  // must be invalidated too or the page won't refresh after a run completes.
  // `getApiV1ProjectsByNameRuns` matches only the runs sub-endpoint (there is
  // no per-project run-detail op), so the prefix is safe (not greedy).
  invalidateByOpPrefix(queryClient, 'getApiV1ProjectsByNameRuns')

  switch (kind) {
    case RunKinds['answer-visibility']:
      // No explicit `['analytics-metrics', project]` invalidation here. That
      // key's last segment is `analyticsRevision` (`VisibilityTrendSection`,
      // fed by `latestVisibilityRevision` in `use-project-dashboard.ts`).
      //
      // What the revision actually is: the createdAt + sibling run ids of the
      // NEWEST completed|partial non-probe answer-visibility sweep. That is
      // the newest member of the run set `GET /analytics/metrics` aggregates
      // (same kind / status / non-probe filters), NOT the whole set — the
      // endpoint scans all of them, the revision names only the latest.
      //
      // Why that is enough for this call site: a sweep completing is a sweep
      // becoming the newest one, so the project-scoped runs refetch above
      // rotates the revision and the chart mounts a brand-new key — one
      // fetch. A prefix invalidation on top refetched the OLD revision key
      // first, so every sweep completion cost two full-history analytics
      // scans, and the entries it marked stale are unreachable once the
      // revision moves.
      //
      // Known limit: a run that completes out of createdAt order (an older
      // run finishing after a newer one already did) joins the aggregated set
      // without changing `latestCreatedAt`, so the revision does not rotate
      // and the chart keeps the pre-completion numbers until it remounts.
      // Sibling runs of one logical multi-location sweep share a createdAt
      // and so are covered; only genuinely overlapping sweeps are not. That
      // is accepted rather than paying an extra full-history scan on every
      // sweep completion, which is the hot path here.
      return
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
