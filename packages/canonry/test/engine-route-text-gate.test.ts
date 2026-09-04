import http from 'node:http'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { engineRouteConfigSchema, normalizeEngineConnection } from '@ainyc/canonry-contracts'
import { createOpenAiCompatibleTextRouteAdapter } from '../src/engine-routes.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

const servers: http.Server[] = []

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

async function delayedOpenAiGateway(): Promise<{
  baseUrl: string
  maxConcurrentRequests: () => number
}> {
  let active = 0
  let maxActive = 0
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before delaying the completion stream.
    }
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 50))
    active -= 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"id":"fake","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n')
    response.write('data: {"id":"fake","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxConcurrentRequests: () => maxActive,
  }
}

test('two text routes on one connection share a gate even when callers use adapters directly', async () => {
  const fake = await delayedOpenAiGateway()
  const connection = normalizeEngineConnection({
    id: 'shared-gateway',
    label: 'Shared gateway',
    preset: 'custom-openai-compatible',
    baseUrl: fake.baseUrl,
    apiKey: 'route-secret',
    quota: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 100 },
  })
  const firstRoute = engineRouteConfigSchema.parse({
    id: 'route:shared:first', label: 'First route', connectionId: connection.id,
    modelId: 'first-model', revision: 1, capabilities: { kind: 'text-only' },
  })
  const secondRoute = engineRouteConfigSchema.parse({
    id: 'route:shared:second', label: 'Second route', connectionId: connection.id,
    modelId: 'second-model', revision: 1, capabilities: { kind: 'text-only' },
  })
  const first = createOpenAiCompatibleTextRouteAdapter({ connection, route: firstRoute })
  const second = createOpenAiCompatibleTextRouteAdapter({ connection, route: secondRoute })

  await Promise.all([
    first.generateText('first', { provider: firstRoute.id, quotaPolicy: connection.quota }),
    second.generateText('second', { provider: secondRoute.id, quotaPolicy: connection.quota }),
  ])

  expect(fake.maxConcurrentRequests()).toBe(1)
})
