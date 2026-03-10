import { getPlatformEnv } from '@ainyc/canonry-config'

import { describeAuditClient } from './audit-client.js'
import { startHealthServer } from './health-server.js'
import { startHeartbeatJobs } from './jobs/index.js'

const env = getPlatformEnv(process.env)
let lastHeartbeatAt = new Date().toISOString()

console.info(`[worker] technical audit engine ${describeAuditClient()}`)

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
