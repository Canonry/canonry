import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routes.js'
import { _BASE_PREFIX } from '../lib/base-path.js'

export function createAppRouter(queryClient: QueryClient, opts?: { initialEntries?: string[] }) {
  return createRouter({
    routeTree,
    basepath: _BASE_PREFIX || '/',
    context: { queryClient },
    ...(opts?.initialEntries && {
      history: createMemoryHistory({ initialEntries: opts.initialEntries }),
    }),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
