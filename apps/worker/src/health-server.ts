import { createServer } from 'node:http'

import type { PlatformEnv } from '@ainyc/canonry-config'

interface WorkerHealthResponse {
  service: 'aeo-platform-worker'
  status: 'ok'
  version: string
  port: number
  databaseUrlConfigured: boolean
  lastHeartbeatAt: string
}

export function startHealthServer(
  env: PlatformEnv,
  getLastHeartbeatAt: () => string,
): { ready: Promise<void>; close: () => Promise<void> } {
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404)
      response.end('not found')
      return
    }

    const payload: WorkerHealthResponse = {
      service: 'aeo-platform-worker',
      status: 'ok',
      version: '0.1.0',
      port: env.workerPort,
      databaseUrlConfigured: env.databaseUrl.length > 0,
      lastHeartbeatAt: getLastHeartbeatAt(),
    }

    response.writeHead(200, {
      'content-type': 'application/json',
    })
    response.end(JSON.stringify(payload))
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(env.workerPort, '0.0.0.0', () => {
      console.info(`[worker] health server listening on ${env.workerPort}`)
      server.off('error', reject)
      resolve()
    })
  })

  return {
    ready,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    }),
  }
}
