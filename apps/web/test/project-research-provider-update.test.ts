import { expect, onTestFinished, test } from 'vitest'

import { updateAliases, updateOwnedDomains, updateProject } from '../src/api.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const staleRouteProject = {
  id: 'project_demo',
  name: 'demo',
  displayName: 'Demo',
  canonicalDomain: 'demo.example',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  tags: [],
  labels: {},
  providers: ['gemini'],
  providerModels: {},
  // It was deleted from global settings after the project last saved. Sending
  // it back on an unrelated edit would make the server reject that edit.
  researchProvider: 'route:removed',
  locations: [],
  defaultLocation: null,
  measurement: {},
  autoExtractBacklinks: false,
  configSource: 'cli',
  configRevision: 1,
}

function observeProjectPuts() {
  const bodies: Array<Record<string, unknown>> = []
  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path !== '/api/v1/projects/demo') return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    if (init?.method === 'GET') return jsonResponse(staleRouteProject)
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      return jsonResponse({ ...staleRouteProject, ...body })
    }
    return jsonResponse({ error: { message: `Unexpected method: ${init?.method}` } }, 500)
  })
  onTestFinished(restore)
  return bodies
}

test('sends an explicitly selected research route in the generated project PUT body', async () => {
  const bodies = observeProjectPuts()

  await updateProject('demo', {
    providers: ['gemini', 'route:verified'],
    providerModels: { gemini: 'gemini-2.5-pro' },
    researchProvider: 'route:research-gateway',
  })

  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({
    providers: ['gemini', 'route:verified'],
    providerModels: { gemini: 'gemini-2.5-pro' },
    researchProvider: 'route:research-gateway',
  })
})

test('omits a stale research route on unrelated project writes', async () => {
  const bodies = observeProjectPuts()

  await updateProject('demo', { displayName: 'Renamed demo' })
  await updateAliases('demo', ['www.demo.example'])
  await updateOwnedDomains('demo', ['assets.demo.example'])

  expect(bodies).toHaveLength(3)
  for (const body of bodies) expect(body).not.toHaveProperty('researchProvider')
})
