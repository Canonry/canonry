import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  engineRouteConfigSchema,
  normalizeEngineConnection,
} from '@ainyc/canonry-contracts'
import { createOpenAiCompatibleTextRouteAdapter, fetchOpenAiCompatibleModelCatalog } from '../src/engine-routes.js'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

async function fakeOpenAiServer(): Promise<{ baseUrl: string; requests: Array<{ authorization?: string; model?: string }> }> {
  const requests: Array<{ authorization?: string; model?: string }> = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body) as { model?: string }
    requests.push({ authorization: request.headers.authorization, model: payload.model })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"id":"fake-response","choices":[{"delta":{"content":"hello from fake"},"finish_reason":null}]}\n\n')
    response.write('data: {"id":"fake-response","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

describe('generic OpenAI-compatible text route', () => {
  it('uses pi-ai against a local endpoint, but refuses to fabricate sweep evidence', async () => {
    const fake = await fakeOpenAiServer()
    const connection = normalizeEngineConnection({
      id: 'local-gateway',
      label: 'Local gateway',
      preset: 'custom-openai-compatible',
      baseUrl: fake.baseUrl,
      apiKey: 'route-secret',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 30, maxRequestsPerDay: 100 },
    })
    const route = engineRouteConfigSchema.parse({
      id: 'route:local-gateway:fake',
      label: 'Fake model',
      connectionId: connection.id,
      modelId: 'fake-model',
      revision: 1,
      capabilities: { kind: 'text-only' },
    })

    const adapter = createOpenAiCompatibleTextRouteAdapter({ connection, route })
    await expect(adapter.generateText('Say hello', {
      provider: route.id,
      quotaPolicy: connection.quota,
    })).resolves.toBe('hello from fake')
    expect(fake.requests).toEqual([{ authorization: 'Bearer route-secret', model: 'fake-model' }])

    await expect(adapter.executeTrackedQuery({
      query: 'what is this?', canonicalDomains: ['example.com'], competitorDomains: [],
    }, { provider: route.id, quotaPolicy: connection.quota })).rejects.toThrow(/cannot run an answer-visibility sweep/i)
  })

  it('reads a bounded GET /models catalog without sending an inference request', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = []
    const server = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [
        { id: 'openai/gpt-5.4', owned_by: 'openai' },
        { id: 'anthropic/claude-sonnet', owned_by: 'anthropic' },
      ] }))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const connection = normalizeEngineConnection({
      id: 'catalog-gateway', label: 'Catalog gateway', preset: 'custom-openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'catalog-secret',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 30, maxRequestsPerDay: 100 },
    })

    await expect(fetchOpenAiCompatibleModelCatalog(connection)).resolves.toMatchObject({
      connectionId: 'catalog-gateway', state: 'available', manualModelIdAllowed: true,
      models: expect.arrayContaining([expect.objectContaining({ id: 'openai/gpt-5.4', provider: 'openai' })]),
    })
    expect(requests).toEqual([{
      method: 'GET', url: '/v1/models', authorization: 'Bearer catalog-secret', body: '',
    }])
  })

  it('keeps manual model entry available when a gateway cannot serve its catalog', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const connection = normalizeEngineConnection({
      id: 'unavailable-catalog', label: 'Unavailable catalog', preset: 'custom-openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'catalog-secret',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 30, maxRequestsPerDay: 100 },
    })

    await expect(fetchOpenAiCompatibleModelCatalog(connection)).resolves.toMatchObject({
      connectionId: 'unavailable-catalog', state: 'unavailable', manualModelIdAllowed: true, models: [],
    })
  })
})
