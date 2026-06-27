import { useQuery } from '@tanstack/react-query'
import { fetchPortfolio } from '../api.js'
import { RUNS_STALE_MS } from './query-client.js'

/**
 * The portfolio composite (`GET /api/v1/portfolio`) backs the Overview page:
 * the server-computed change feed, timestamped recent runs, and per-project
 * state in ONE request — replacing the old N+1 per-project `/overview` fan-out
 * the portfolio surface used to do (and the structurally-dead client-side
 * attention-item derivation that came with it).
 *
 * Polls faster while a sweep is in flight so a completing run surfaces in the
 * change feed and recent-runs log promptly, then settles back to the static
 * cadence.
 */
const PORTFOLIO_QUERY_KEY = ['portfolio'] as const

export function usePortfolio() {
  return useQuery({
    queryKey: PORTFOLIO_QUERY_KEY,
    queryFn: fetchPortfolio,
    staleTime: RUNS_STALE_MS,
    refetchInterval: (query) => {
      const data = query.state.data
      const hasActive = data?.recentRuns.some(r => r.status === 'running' || r.status === 'queued')
      return hasActive ? 3000 : RUNS_STALE_MS
    },
  })
}
