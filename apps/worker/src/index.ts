import { getPlatformEnv } from '@canonry/canonry-config'

import { startHealthServer } from './health-server.js'
import { startHeartbeatJobs } from './jobs/index.js'

const env = getPlatformEnv(process.env)
let lastHeartbeatAt = new Date().toISOString()

const healthServer = startHealthServer(env, () => lastHeartbeatAt)
void healthServer.ready
const stop = startHeartbeatJobs(env, () => {
  lastHeartbeatAt = new Date().toISOString()
})

const shutdown = async () => {
  await healthServer.close()
  stop()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
