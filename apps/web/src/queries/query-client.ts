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

// Per-project detail (queries, competitors, timeline, snapshots) polls
// slower than the sidebar because each refetch fans out across ~9
// endpoints (queries / competitors / timeline / latest+previous run
// detail / GSC / Bing / insights / overview). 5s gives CLI-driven
// `canonry query add` / `canonry competitor add` visible feedback on
// the project page without the load multiplier of a 2s poll. Defaults
// to background-paused via React Query's `refetchIntervalInBackground:
// false` so idle tabs don't keep pulling.
export const PROJECT_DETAIL_REFRESH_MS = 5_000

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
