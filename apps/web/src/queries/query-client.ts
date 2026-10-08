import { MutationCache, QueryClient } from '@tanstack/react-query'
import { heyClient } from '../api.js'
import { addToast } from '../lib/toast-store.js'
import { refreshQueriesAfterWrite } from './query-invalidation.js'

export const DEFAULT_QUERY_STALE_MS = 5 * 60_000
export const STATIC_VISIBILITY_STALE_MS = 30 * 60_000
export const TRAFFIC_STALE_MS = 30_000
export const GSC_STALE_MS = 60_000
export const RUNS_STALE_MS = 30_000
// Projects list poll: CLI mutations (`canonry project create`) bypass React Query,
// so the sidebar needs a poll to pick them up after alt-tab. Fixed 2s = 30 req/min
// per tab to a SQLite SELECT — adaptive interval (see use-dashboard-overview.ts)
// polls fast only when zero projects or active runs, otherwise 30s idle (1 req/min).
export const PROJECTS_REFRESH_MS = 2_000
export const PROJECTS_REFRESH_IDLE_MS = 30_000

/**
 * The cache the app is currently rendering from.
 *
 * Tracked so that "who is signed in" and "what is cached" can be shown to be
 * the same lifetime. A cache that outlives a sign-out is one account reading
 * another's data out of memory.
 */
let activeQueryClient: QueryClient | null = null
let removeWriteRefresh: (() => void) | undefined

/**
 * What the app currently holds cached, as readable strings.
 *
 * Only entries that actually carry a RESULT are listed. A registered-but-empty
 * entry is what a disabled `useQuery` leaves behind and holds nothing; what
 * matters for one account inheriting another's view is stored data.
 */
export function activeQueryCacheKeys(): string[] {
  if (!activeQueryClient) return []
  return activeQueryClient
    .getQueryCache()
    .getAll()
    .filter(query => query.state.data !== undefined)
    .map(query => JSON.stringify(query.queryKey))
}

export function createQueryClient() {
  const client = new QueryClient({
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
  removeWriteRefresh?.()
  const requests = new WeakSet<Request>()
  const requestInterceptor = heyClient.interceptors.request.use(request => {
    requests.add(request)
    return request
  })
  const responseInterceptor = heyClient.interceptors.response.use((response, request, options) => {
    // An old account's in-flight write cannot modify a replacement account's cache.
    if (response.ok && requests.has(request)) {
      refreshQueriesAfterWrite(client, request, options.body)
    }
    return response
  })
  removeWriteRefresh = () => {
    heyClient.interceptors.request.eject(requestInterceptor)
    heyClient.interceptors.response.eject(responseInterceptor)
  }
  activeQueryClient = client
  return client
}
