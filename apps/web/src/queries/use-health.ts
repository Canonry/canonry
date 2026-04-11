import { useQuery } from '@tanstack/react-query'
import { fetchServiceStatus } from '../api.js'
import type { HealthSnapshot, ServiceStatus } from '../view-models.js'
import { queryKeys } from './query-keys.js'

async function fetchHealth(): Promise<HealthSnapshot> {
  const apiStatus = await fetchServiceStatus('/health', 'API')
  const workerStatus: ServiceStatus = apiStatus.state === 'ok'
    ? { label: 'Worker', state: 'ok', detail: 'In-process job runner' }
    : {
        label: 'Worker',
        state: apiStatus.state,
        detail: `Depends on API health check · ${apiStatus.detail}`,
        statusCode: apiStatus.statusCode,
        hint: apiStatus.hint
          ? `Worker status is inferred from API health in this deployment mode. ${apiStatus.hint}`
          : 'Worker status is inferred from API health in this deployment mode.',
      }

  return { apiStatus, workerStatus }
}

export function useHealth(enabled: boolean, initialSnapshot?: HealthSnapshot) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: fetchHealth,
    enabled,
    refetchInterval: 15_000,
    initialData: initialSnapshot,
  })
}
