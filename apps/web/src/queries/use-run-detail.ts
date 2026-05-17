import { useQuery } from '@tanstack/react-query'
import { getApiV1RunsByIdOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../api.js'

export function useRunDetail(runId: string | null) {
  return useQuery({
    ...getApiV1RunsByIdOptions({ client: heyClient, path: { id: runId ?? '' } }),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' || status === 'queued' ? 3000 : false
    },
  })
}
