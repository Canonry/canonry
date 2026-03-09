import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import { getPlatformEnv } from '@ainyc/aeo-platform-config'

import { startHealthServer } from '../src/health-server.js'
import { createHeartbeatLog } from '../src/jobs/healthcheck.js'
import { startHeartbeatJobs } from '../src/jobs/index.js'

async function getAvailablePort(): Promise<number> {
  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })

  const address = server.address()
  assert.ok(address && typeof address === 'object')

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  return address.port
}

test('createHeartbeatLog reports configured database and quota', () => {
  const env = getPlatformEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    GEMINI_MAX_CONCURRENCY: '6',
  })

  assert.equal(
    createHeartbeatLog(env),
    '[worker] heartbeat database=configured geminiConcurrency=6',
  )
})

test('startHeartbeatJobs triggers an immediate heartbeat and clears its timer', (t) => {
  const env = getPlatformEnv({})
  let heartbeatCount = 0
  let clearedTimer: NodeJS.Timeout | undefined

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realConsoleInfo = console.info
  const fakeTimer = { marker: 'timer' } as unknown as NodeJS.Timeout

  globalThis.setInterval = ((_callback: TimerHandler) => fakeTimer) as typeof setInterval
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    clearedTimer = timer
  }) as typeof clearInterval
  console.info = () => {}

  t.after(() => {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    console.info = realConsoleInfo
  })

  const stop = startHeartbeatJobs(env, () => {
    heartbeatCount += 1
  })

  assert.equal(heartbeatCount, 1)
  stop()
  assert.equal(clearedTimer, fakeTimer)
})

test('startHealthServer exposes worker health payload', async (t) => {
  const workerPort = await getAvailablePort()
  const env = getPlatformEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    WORKER_PORT: String(workerPort),
  })

  const healthServer = startHealthServer(env, () => '2026-03-09T00:00:00.000Z')
  await healthServer.ready

  t.after(async () => {
    await healthServer.close()
  })

  const response = await fetch(`http://127.0.0.1:${workerPort}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    service: 'aeo-platform-worker',
    status: 'ok',
    version: '0.1.0',
    port: workerPort,
    databaseUrlConfigured: true,
    lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
  })
})
