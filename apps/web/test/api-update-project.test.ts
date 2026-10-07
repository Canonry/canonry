import { test, expect, onTestFinished } from 'vitest'

import { updateAliases, updateOwnedDomains, updateProject } from '../src/api.js'

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

/** Serves `stored` on GET and records each PUT body, echoing it merged over `stored`. */
function captureProjectPuts(stored: Record<string, unknown>) {
  const puts: Array<Record<string, unknown>> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.method === 'PUT') {
      const body = JSON.parse(await request.clone().text()) as Record<string, unknown>
      puts.push(body)
      return new Response(JSON.stringify({ ...stored, ...body }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  onTestFinished(() => { globalThis.fetch = realFetch })
  return puts
}

// The server keeps a stored page budget when the PUT omits it, and only then:
// echoing the value read a moment earlier could overwrite a budget saved from
// the CLI or another tab in between, and sending null would reset it to the
// full site. So a save that does not set the budget must leave the key out.
test.each([
  { label: 'updateProject (aliases)', save: () => updateProject('demo', { aliases: ['A2 Northstar'] }) },
  { label: 'updateProject (engines)', save: () => updateProject('demo', { providers: ['gemini'], providerModels: {} }) },
  { label: 'updateOwnedDomains', save: () => updateOwnedDomains('demo', ['northstar.example']) },
  { label: 'updateAliases', save: () => updateAliases('demo', ['A2 Northstar']) },
])('$label leaves a stored page budget out of the PUT', async ({ save }) => {
  const puts = captureProjectPuts({ ...storedProject, siteAuditMaxPages: 2_500 })

  await save()

  expect(puts).toHaveLength(1)
  expect(puts[0]).not.toHaveProperty('siteAuditMaxPages')
})

test.each([
  { budget: 750, stored: 2_500 },
  { budget: 10_000, stored: null },
  // Null is a real value here: it resets a saved budget to the full site.
  { budget: null, stored: 2_500 },
])('updateProject sends a page budget of $budget when the caller sets it', async ({ budget, stored }) => {
  const puts = captureProjectPuts({ ...storedProject, siteAuditMaxPages: stored })

  const updated = await updateProject('demo', { siteAuditMaxPages: budget })

  expect(puts).toHaveLength(1)
  expect(puts[0]).toHaveProperty('siteAuditMaxPages', budget)
  // Nothing else the caller did not set changes.
  expect(puts[0]).toMatchObject({ aliases: storedProject.aliases, displayName: storedProject.displayName })
  expect(updated.siteAuditMaxPages).toBe(budget)
})
