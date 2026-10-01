import http from 'node:http'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { normalizeContext, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import { aeroModels, aeroStreamFn, completeOnce } from '../src/agent/pi-models.js'
import { AGENT_PROVIDERS, PROVIDER_MODELS, listAgentProviders } from '../src/agent/providers.js'

// Every Aero provider's real catalog model, repointed at a localhost server
// that records the request headers and rejects the call. Only the headers
// matter: no request may name the host OS, kernel, CPU architecture or Node
// version, on any API adapter Canonry streams through.

let server: http.Server
let origin: string
let requests: http.IncomingHttpHeaders[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.headers)
    req.resume()
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 400, message: 'rejected by test server', type: 'invalid_request_error' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  requests = []
})

/** Each provider's agent-tier model, straight from the catalog. */
const catalogModels: Array<Model<Api>> = listAgentProviders().map(provider => {
  const model = aeroModels.getModel(AGENT_PROVIDERS[provider].piAiProvider, PROVIDER_MODELS[provider].agent)
  if (!model) throw new Error(`no catalog model for ${provider}`)
  return model
})

/** The same model on the catalog's own path (pi builds the rest of the URL), at the test server. */
function local(model: Model<Api>): Model<Api> {
  return { ...model, baseUrl: `${origin}${new URL(model.baseUrl).pathname.replace(/\/+$/, '')}` }
}

const context: Context = {
  systemPrompt: 'Test.',
  messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
}

/** Sends one streamed and one one-shot request and returns the headers of each. */
async function captureHeaders(model: Model<Api>): Promise<http.IncomingHttpHeaders[]> {
  const stream = await aeroStreamFn(model, normalizeContext(context), { apiKey: 'test-key' })
  await stream.result()
  const streamed = requests.length
  await completeOnce(model, context, { apiKey: 'test-key' })
  // Both calls must reach the server, or the assertions below prove nothing.
  expect(streamed).toBeGreaterThan(0)
  expect(requests.length).toBeGreaterThan(streamed)
  return requests
}

/** The headers whose value names this host, as `name: value`. */
function hostDetailHeaders(headers: http.IncomingHttpHeaders): string[] {
  const details = [os.platform(), os.release(), os.arch(), process.version].map(detail => detail.toLowerCase())
  return Object.entries(headers)
    .map(([name, value]) => [name, [value ?? ''].flat().join(', ')] as const)
    .filter(([, value]) => details.some(detail => value.toLowerCase().includes(detail)))
    .map(([name, value]) => `${name}: ${value}`)
}

describe('Aero request headers', () => {
  it('covers every API adapter Canonry uses', () => {
    // Every catalog model of every Aero provider, not just the tier defaults:
    // completeOnce serves the analyze tier and agent.model can pin any id.
    const apis = listAgentProviders().flatMap(provider =>
      aeroModels.getModels(AGENT_PROVIDERS[provider].piAiProvider).map(model => model.api))
    expect(new Set(apis)).toEqual(
      new Set(['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai']),
    )
  })

  it.each(catalogModels.map(model => [model.api, model] as const))('%s requests do not name the host OS, architecture or Node version', async (_api, model) => {
    for (const headers of await captureHeaders(local(model))) {
      expect(headers['user-agent']).toBe('canonry')
      expect(headers).not.toHaveProperty('x-stainless-os')
      expect(headers).not.toHaveProperty('x-stainless-arch')
      expect(headers).not.toHaveProperty('x-stainless-runtime-version')
      expect(hostDetailHeaders(headers)).toEqual([])
    }
  })

  it.each(catalogModels.map(model => [model.api, model] as const))('%s requests keep a caller\'s explicit headers', async (_api, model) => {
    const caller = { 'User-Agent': 'custom-agent', 'x-goog-api-client': 'custom-client', 'X-Stainless-Runtime-Version': 'custom-runtime' }
    const stream = await aeroStreamFn(local(model), normalizeContext(context), { apiKey: 'test-key', headers: caller })
    await stream.result()
    expect(requests.length).toBeGreaterThan(0)
    for (const headers of requests) {
      expect(headers['user-agent']).toBe('custom-agent')
      expect(headers['x-goog-api-client']).toBe('custom-client')
      expect(headers['x-stainless-runtime-version']).toBe('custom-runtime')
    }
  })
})
