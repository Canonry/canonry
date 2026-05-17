import { useQuery } from '@tanstack/react-query'
import { fetchServiceStatus } from '../api.js'
import type { HealthSnapshot, ServiceStatus } from '../view-models.js'

/**
 * The `/health` endpoint lives outside `/api/v1` (it's the bare deployment
 * health check, not a domain endpoint), so it has no generated SDK helper.
 * Inline its cache key here rather than maintain a one-entry registry.
 */
const HEALTH_QUERY_KEY = ['health'] as const

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
    queryKey: HEALTH_QUERY_KEY,
    queryFn: fetchHealth,
    enabled,
    refetchInterval: 15_000,
    initialData: initialSnapshot,
  })
}
