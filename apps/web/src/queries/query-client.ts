import { MutationCache, QueryClient } from '@tanstack/react-query'
import { addToast } from '../lib/toast-store.js'

export const DEFAULT_QUERY_STALE_MS = 5 * 60_000
export const STATIC_VISIBILITY_STALE_MS = 30 * 60_000
export const TRAFFIC_STALE_MS = 30_000
export const GSC_STALE_MS = 60_000
export const RUNS_STALE_MS = 30_000
// Projects list polls quickly so CLI-driven mutations (e.g.
// `canonry project create`) show up in the dashboard sidebar within
// seconds — the entire project-card fan-out cascades from this query
// on first mount, so a fast poll here makes the overview reactive
// end-to-end. Trade-off: ~30 req/min from one tab to a SQLite SELECT.
export const PROJECTS_REFRESH_MS = 2_000

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_QUERY_STALE_MS,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.skipGlobalErrorToast) {
          return
        }
        // Global fallback — only fires if the mutation caller didn't handle the error.
        // Components with custom onError callbacks still receive their error first;
        // this ensures no mutation fails silently.
        addToast({
          title: error instanceof Error ? error.message : 'An unexpected error occurred',
          tone: 'negative',
        })
      },
    }),
  })
}
