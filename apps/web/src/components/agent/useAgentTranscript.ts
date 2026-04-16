import { useQuery } from '@tanstack/react-query'
import { fetchAgentTranscript } from '../../api.js'
import { queryKeys } from '../../queries/query-keys.js'

export function useAgentTranscript(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agent.transcript(),
    queryFn: () => fetchAgentTranscript(50),
    staleTime: 60_000,
    enabled,
  })
}
