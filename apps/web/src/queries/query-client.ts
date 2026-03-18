import { MutationCache, QueryClient } from '@tanstack/react-query'
import { addToast } from '../lib/toast-store.js'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        // Global fallback — only fires if the mutation caller didn't handle the error.
        // Components with custom onError callbacks still receive their error first;
        // this ensures no mutation fails silently.
        addToast(
          error instanceof Error ? error.message : 'An unexpected error occurred',
          'negative',
        )
      },
    }),
  })
}
