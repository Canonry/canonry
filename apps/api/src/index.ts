import { buildApp } from './app.js'
import { loadApiEnv } from './plugins/env.js'

const env = loadApiEnv(process.env)
const app = buildApp(env)

try {
  await app.listen({
    host: '0.0.0.0',
    port: env.apiPort,
  })
  app.log.info({ port: env.apiPort }, 'api skeleton started')
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
