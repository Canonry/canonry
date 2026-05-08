import type { QueryClient } from '@tanstack/react-query'

import { RunKinds, type RunKind } from '@ainyc/canonry-contracts'

import { queryKeys } from './query-keys.js'

/**
 * Map a run kind to the domain-scoped query keys it invalidates.
 *
 * When a run completes (or is queued, depending on the call site), the data
 * surfaces it touched should be marked stale so the UI re-fetches. Adding a
 * new `RunKind` variant requires extending this switch — TypeScript will
 * fail compilation at the `_exhaustive` line if a case is ever missed.
 */
export function invalidateQueriesForRunKind(
  queryClient: QueryClient,
  kind: RunKind,
  projectName: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })

  switch (kind) {
    case RunKinds['answer-visibility']:
    case RunKinds['site-audit']:
    case RunKinds['backlink-extract']:
      return
    case RunKinds['gsc-sync']:
    case RunKinds['inspect-sitemap']:
      void queryClient.invalidateQueries({ queryKey: queryKeys.gsc.project(projectName) })
      return
    case RunKinds['ga-sync']:
    case RunKinds['traffic-sync']:
      void queryClient.invalidateQueries({ queryKey: queryKeys.traffic.project(projectName) })
      return
    case RunKinds['bing-inspect']:
    case RunKinds['bing-inspect-sitemap']:
      void queryClient.invalidateQueries({ queryKey: queryKeys.bing.project(projectName) })
      return
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}
