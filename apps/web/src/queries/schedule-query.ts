import type { ScheduleDto } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameSchedule } from '@ainyc/canonry-api-client'
import { getApiV1ProjectsByNameScheduleQueryKey } from '@ainyc/canonry-api-client/react-query'

import { ApiError, heyClient, invokeWeb } from '../api.js'

/**
 * The generated client deliberately throws its response envelope for query
 * hooks. Normalize the one expected absence here, while retaining a real
 * transport or server failure as an error state for every consumer.
 */
export function projectScheduleQueryOptions(projectName: string) {
  const options = { client: heyClient, path: { name: projectName } } as const
  return {
    queryKey: getApiV1ProjectsByNameScheduleQueryKey(options),
    queryFn: async (): Promise<ScheduleDto | null> => {
      try {
        return await invokeWeb<ScheduleDto>(() => getApiV1ProjectsByNameSchedule(options))
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) return null
        throw error
      }
    },
  }
}
