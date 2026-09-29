import { test, expect, onTestFinished } from 'vitest'

import { updateProject } from '../src/api.js'

const storedProject = {
  id: 'project-1',
  name: 'demo',
  displayName: 'Northstar Living',
  canonicalDomain: 'northstar.example',
  ownedDomains: [],
  aliases: ['A1 Northstar', 'A2 Northstar'],
  qualifiedAliases: ['A1 Northstar'],
  country: 'US',
  language: 'en',
  tags: [],
  labels: {},
  providers: [],
  providerModels: {},
  providerDispatchModes: {},
  locations: [],
  defaultLocation: null,
  autoExtractBacklinks: false,
  configSource: 'api',
  configRevision: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

// The dashboard's settings save must leave `qualifiedAliases` out of the PUT
// body: the server then keeps the stored list minus removed aliases, while an
// echoed stale name would turn removing an alias into a 400.
test('updateProject never echoes the stored qualifiedAliases', async () => {
  const puts: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.method === 'PUT') {
      puts.push(JSON.parse(await request.clone().text()))
      return new Response(JSON.stringify({ ...storedProject, aliases: ['A2 Northstar'], qualifiedAliases: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(storedProject), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })

  await updateProject('demo', { aliases: ['A2 Northstar'] })

  expect(puts).toHaveLength(1)
  expect(puts[0]).toMatchObject({ aliases: ['A2 Northstar'] })
  expect(puts[0]).not.toHaveProperty('qualifiedAliases')
})
