import { useQuery } from '@tanstack/react-query'
import { fetchServiceStatus } from '../api.js'
import { _BASE_PREFIX } from '../lib/base-path.js'
import type { HealthSnapshot, ServiceStatus } from '../view-models.js'
import { queryKeys } from './query-keys.js'

async function fetchHealth(): Promise<HealthSnapshot> {
  // Use the basePath-prefixed health URL so the request hits the canonry server
  // even when served under a sub-path (e.g. /canonry/). A hardcoded '/health'
  // would miss the Caddy proxy rule and land on the wrong backend.
  const healthUrl = _BASE_PREFIX ? `${_BASE_PREFIX}/health` : '/health'
  const apiStatus = await fetchServiceStatus(healthUrl, 'API')
  const workerStatus: ServiceStatus = apiStatus.state === 'ok'
    ? { label: 'Runner', state: 'ok', detail: 'In-process job runner' }
    : { label: 'Runner', state: apiStatus.state, detail: 'Depends on API' }

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
