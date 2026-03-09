import type { PlatformEnv } from '@ainyc/aeo-platform-config'

import { createHeartbeatLog } from './healthcheck.js'

export function startHeartbeatJobs(env: PlatformEnv, onHeartbeat?: () => void): () => void {
  onHeartbeat?.()
  console.info(createHeartbeatLog(env))

  const timer = setInterval(() => {
    onHeartbeat?.()
    console.info(createHeartbeatLog(env))
  }, 15_000)

  return () => clearInterval(timer)
}
