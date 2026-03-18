import { useQuery } from '@tanstack/react-query'
import { fetchRunDetail } from '../api.js'
import { queryKeys } from './query-keys.js'

export function useRunDetail(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.runs.detail(runId ?? ''),
    queryFn: () => fetchRunDetail(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' || status === 'queued' ? 3000 : false
    },
  })
}
