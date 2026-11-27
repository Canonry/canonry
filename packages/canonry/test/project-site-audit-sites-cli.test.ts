import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@canonry/canonry-api-routes'
import { createClient, migrate, projects, siteCrawlRunRequests, type DatabaseClient } from '@canonry/canonry-db'
import { ApiClient } from '../src/client.js'

// The owned domains an Agent Readiness scan covers, through the real routes:
// what `project update --site-audit-domain|--add-…|--remove-…` writes and
// `project show` prints, and which sites a scan from the CLI or MCP covers.

const state = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../src/client.js', async importOriginal => ({
  ...await importOriginal(),
  createApiClient: () => state.client,
}))
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')
const { TECHNICAL_AEO_CLI_COMMANDS } = await import('../src/cli-commands/technical-aeo.js')
const { createCanonryMcpServer } = await import('../src/mcp/server.js')

const PROJECT = 'northwind'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-audit-sites-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const scanSites: Array<string[] | undefined> = []
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onSiteAuditRequested: (_runId, _projectId, opts) => { scanSites.push(opts?.sites) },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const api = new ApiClient(`http://127.0.0.1:${address.port}`, 'cnry_test', { skipProbe: true })
  state.client = api
  await api.putProject(PROJECT, {
    displayName: 'Northwind', canonicalDomain: 'northwind.example', ownedDomains: ['homes.northwind.example', 'northwind-shop.example'],
    country: 'US', language: 'en',
  })
  return { db, api, scanSites }
}

function stored(db: DatabaseClient) {
  return db.select().from(projects).where(eq(projects.name, PROJECT)).get()!
}

async function cli(args: string[], format: 'text' | 'json' = 'text'): Promise<{ lines: string[]; error?: unknown }> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) })
  try {
    await dispatchRegisteredCommand([...args, '--format', format], format, [...PROJECT_CLI_COMMANDS, ...TECHNICAL_AEO_CLI_COMMANDS])
    return { lines }
  } catch (error) {
    return { lines, error }
  } finally {
    vi.mocked(console.log).mockRestore()
  }
}

describe('project update site flags against the API', () => {
  it('adds, removes and replaces saved sites, and an unrelated edit leaves them alone', async () => {
    const { db, api } = await harness()
    const patch = vi.spyOn(api, 'patchProject')

    expect((await cli(['project', 'update', PROJECT, '--add-site-audit-domain', 'https://Homes.Northwind.example/'])).error).toBeUndefined()
    expect(stored(db).siteAuditDomains).toEqual(['homes.northwind.example'])
    // Adding the same site in another form changes nothing.
    await cli(['project', 'update', PROJECT, '--add-site-audit-domain', 'www.homes.northwind.example', '--add-site-audit-domain', 'northwind-shop.example'])
    expect(stored(db).siteAuditDomains).toEqual(['homes.northwind.example', 'northwind-shop.example'])

    await cli(['project', 'update', PROJECT, '--country', 'GB'])
    expect(patch.mock.calls.at(-1)![1]).not.toHaveProperty('siteAuditDomains')
    expect(stored(db).siteAuditDomains).toEqual(['homes.northwind.example', 'northwind-shop.example'])

    await cli(['project', 'update', PROJECT, '--remove-site-audit-domain', 'homes.northwind.example'])
    expect(stored(db).siteAuditDomains).toEqual(['northwind-shop.example'])
    await cli(['project', 'update', PROJECT, '--site-audit-domain', 'homes.northwind.example'])
    expect(stored(db).siteAuditDomains).toEqual(['homes.northwind.example'])
  })

  it('removing an owned domain drops it from the saved sites in the same edit', async () => {
    const { db } = await harness()
    await cli(['project', 'update', PROJECT, '--site-audit-domain', 'homes.northwind.example', '--site-audit-domain', 'northwind-shop.example'])
    expect((await cli(['project', 'update', PROJECT, '--remove-domain', 'northwind-shop.example', '--add-site-audit-domain', 'homes.northwind.example'])).error)
      .toBeUndefined()
    expect(stored(db)).toMatchObject({ ownedDomains: ['homes.northwind.example'], siteAuditDomains: ['homes.northwind.example'] })
  })

  it('a site that is not an owned domain is refused, unless the same command adds it', async () => {
    const { db } = await harness()
    const { error } = await cli(['project', 'update', PROJECT, '--add-site-audit-domain', 'careers.northwind.example'])
    expect(error).toMatchObject({ message: expect.stringContaining('careers.northwind.example is not one of this project\'s owned domains') })
    expect(stored(db).siteAuditDomains).toEqual([])

    expect((await cli(['project', 'update', PROJECT, '--add-domain', 'careers.northwind.example', '--add-site-audit-domain', 'careers.northwind.example'])).error)
      .toBeUndefined()
    expect(stored(db).siteAuditDomains).toEqual(['careers.northwind.example'])
  })

  it('project show names the main domain and the saved sites', async () => {
    await harness()
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Agent Readiness sites: northwind.example (main)')
    await cli(['project', 'update', PROJECT, '--add-site-audit-domain', 'homes.northwind.example'])
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Agent Readiness sites: northwind.example (main), homes.northwind.example')
  })
})

describe('the sites a scan covers', () => {
  function recordedSites(db: DatabaseClient): string[][] {
    return db.select().from(siteCrawlRunRequests).all().map((row) => row.effectiveOptions.sites)
  }

  it('agent-readiness run covers the saved sites, or the ones --site names, and --site with the main domain alone scans just it', async () => {
    const { db, scanSites } = await harness()
    await cli(['project', 'update', PROJECT, '--add-site-audit-domain', 'homes.northwind.example'])
    expect((await cli(['agent-readiness', 'run', PROJECT], 'json')).error).toBeUndefined()
    expect(scanSites.at(-1)).toEqual(['homes.northwind.example'])

    // One scan at a time: finish it before the next.
    const finish = () => db.$client.prepare("UPDATE runs SET status = 'completed'").run()
    finish()
    expect((await cli(['agent-readiness', 'run', PROJECT, '--site', 'northwind-shop.example'], 'json')).error).toBeUndefined()
    expect(scanSites.at(-1)).toEqual(['northwind-shop.example'])
    finish()
    expect((await cli(['agent-readiness', 'run', PROJECT, '--site', 'northwind.example'], 'json')).error).toBeUndefined()
    expect(scanSites.at(-1)).toEqual([])
    expect(recordedSites(db)).toEqual([['homes.northwind.example'], ['northwind-shop.example'], []])
  })

  it('MCP: canonry_project_update saves the sites and canonry_agent_readiness_run covers them, or its own', async () => {
    const { db, api, scanSites } = await harness()
    const server = createCanonryMcpServer({ eager: true, clientFactory: () => api })
    const mcp = new Client({ name: 'site-audit-sites-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)
    cleanup.push(async () => { await mcp.close(); await server.close() })
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args })
      expect(result.isError, name).not.toBe(true)
      return result.structuredContent
    }

    expect(await call('canonry_project_update', { project: PROJECT, request: { siteAuditDomains: ['homes.northwind.example'] } }))
      .toMatchObject({ siteAuditDomains: ['homes.northwind.example'] })
    expect(await call('canonry_agent_readiness_run', { project: PROJECT })).toMatchObject({ status: 'queued' })
    expect(scanSites.at(-1)).toEqual(['homes.northwind.example'])
    db.$client.prepare("UPDATE runs SET status = 'completed'").run()
    expect(await call('canonry_agent_readiness_run', { project: PROJECT, sites: [] })).toMatchObject({ status: 'queued' })
    expect(scanSites.at(-1)).toEqual([])
  })
})
