import { MutationCache, QueryClient } from '@tanstack/react-query'
import { addToast } from '../lib/toast-store.js'

export const DEFAULT_QUERY_STALE_MS = 5 * 60_000
export const STATIC_VISIBILITY_STALE_MS = 30 * 60_000
export const TRAFFIC_STALE_MS = 30_000
export const GSC_STALE_MS = 60_000
export const RUNS_STALE_MS = 30_000

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
