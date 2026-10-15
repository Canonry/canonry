import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createClient, migrate, projects } from '@ainyc/canonry-db'

vi.mock('../src/client.js', async (original) => ({
  ...await original<typeof import('../src/client.js')>(),
  createApiClient: vi.fn(),
}))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: async (url: string) => ({ requestedUrl: url, effectiveUrl: url, redirects: [] }),
}))

import { ApiClient, createApiClient } from '../src/client.js'
import { executeSiteAudit } from '../src/execute-site-audit.js'
import { TECHNICAL_AEO_CLI_COMMANDS } from '../src/cli-commands/technical-aeo.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Real transports, audit engine, persistence and saved reads. Only the site's
// HTTP responses are fixtures; an option dropped anywhere loses its findings.
it.each([
  { surface: 'cli', agentSkills: true },
  { surface: 'mcp', agentSkills: true },
  { surface: 'cli', agentSkills: false },
  { surface: 'mcp', agentSkills: false },
] as const)('$surface agent checks default on and honor opt-out ($agentSkills) in saved results', async ({ surface, agentSkills }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-optional-factors-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  cleanup.push(() => { db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(), name: 'optional-checks', displayName: 'Optional checks',
    canonicalDomain: '1.1.1.1', country: 'US', language: 'en', providers: [], locations: [],
    createdAt: now, updatedAt: now,
  }).run()
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== '1.1.1.1') return realFetch(input, init)
    if (url.pathname === '/canonical-old') return new Response(null, { status: 301, headers: { location: '/canonical-missing' } })
    return url.pathname === '/'
      ? new Response('<html><head><title>Example</title><link rel="canonical" href="https://1.1.1.1/canonical-old"></head><body><h1>Example</h1></body></html>', { headers: { 'content-type': 'text/html' } })
      : new Response('', { status: 404 })
  }))
  const audits: Array<Promise<unknown>> = []
  const app = Fastify()
  cleanup.push(async () => { await app.close() })
  app.register(apiRoutes, {
    db, skipAuth: true,
    onSiteAuditRequested: (runId, projectId, opts) => {
      audits.push(executeSiteAudit(db, runId, projectId, opts))
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const api = new ApiClient(`http://127.0.0.1:${address.port}`, 'cnry_test', { skipProbe: true })
  vi.mocked(createApiClient).mockReturnValue(api)
  let runId: string
  if (surface === 'cli') {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line) })
    await dispatchRegisteredCommand(['technical-aeo', 'run', 'optional-checks', '--max-pages', '1', '--include-geo', ...(!agentSkills ? ['--no-agent-skills'] : [])], 'json', TECHNICAL_AEO_CLI_COMMANDS)
    runId = (JSON.parse(lines.join('\n')) as { runId: string }).runId
  } else {
    const server = createCanonryMcpServer({ eager: true, clientFactory: () => api })
    const mcp = new Client({ name: 'optional-factors-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)
    cleanup.push(async () => { await mcp.close(); await server.close() })
    const result = await mcp.callTool({ name: 'canonry_technical_aeo_run', arguments: {
      project: 'optional-checks', maxPages: 1, includeGeo: true, ...(!agentSkills ? { includeAgentSkills: false } : {}),
    } })
    expect(result.isError).not.toBe(true)
    runId = (result.structuredContent as { runId: string }).runId
  }
  await Promise.all(audits)
  const crawl = await api.getTechnicalAeoCrawl('optional-checks', { runId })
  expect(crawl.effectiveOptions).toMatchObject({ includeGeo: true, includeAgentSkills: agentSkills })
  const score = await api.getTechnicalAeoScore('optional-checks', { runId })
  expect(score.factors.map((factor) => factor.id)).toContain('geographic-signals')
  expect(score.factors.some((factor) => factor.id === 'agent-skill-exposure')).toBe(agentSkills)
  expect(score.factors.map((factor) => factor.id)).not.toContain('lighthouse')
  const page = await api.getTechnicalAeoPageAudit('optional-checks', { runId, url: 'https://1.1.1.1/' })
  expect(page.factors.find((factor) => factor.id === 'geographic-signals')?.findings.length).toBeGreaterThan(0)
  const agentFactor = page.factors.find((factor) => factor.id === 'agent-skill-exposure')
  if (agentSkills) {
    expect(agentFactor?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'agent-skill-exposure.schema-action.missing' })]))
  } else {
    expect(agentFactor).toBeUndefined()
  }
  expect(page.factors.flatMap((factor) => factor.findings.map((finding) => finding.code))).toEqual(expect.arrayContaining([
    'technical-seo.canonical.redirected', 'technical-seo.canonical.unreachable',
  ]))
})
