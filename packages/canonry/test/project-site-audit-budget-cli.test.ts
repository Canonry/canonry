import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { SITE_AUDIT_MAX_PAGE_LIMIT } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, siteCrawlRunRequests, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'
import { prepareCliReadFixture } from './cli-read-fixture.js'
import { invokeCli } from './cli-test-utils.js'

// The saved Site Health page budget through the real routes: what `project
// create|update|show --site-audit-max-pages` writes and prints, and that a scan
// started without a budget, from the CLI or MCP, runs with the saved one.

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

interface Harness {
  db: DatabaseClient
  api: ApiClient
  /** The page budget every scan the route started was handed. */
  scanBudgets: Array<number | undefined>
}

async function harness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-audit-budget-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const scanBudgets: Array<number | undefined> = []
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onSiteAuditRequested: (_runId, _projectId, opts) => { scanBudgets.push(opts?.maxPages) },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const api = new ApiClient(`http://127.0.0.1:${address.port}`, 'cnry_test', { skipProbe: true })
  state.client = api
  await api.putProject(PROJECT, { displayName: 'Northwind', canonicalDomain: 'northwind.example', country: 'US', language: 'en' })
  return { db, api, scanBudgets }
}

function stored(db: DatabaseClient, name = PROJECT) {
  return db.select().from(projects).where(eq(projects.name, name)).get()!
}

/** Runs one registered command and returns what it printed; a thrown error is returned, not raised. */
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

describe('project --site-audit-max-pages against the API', () => {
  it('saves a budget, keeps it through an edit that does not name it, and resets it with "full"', async () => {
    const { db, api } = await harness()
    const put = vi.spyOn(api, 'putProject')

    expect((await cli(['project', 'update', PROJECT, '--site-audit-max-pages', '2500'])).error).toBeUndefined()
    expect(put.mock.calls.at(-1)![1].siteAuditMaxPages).toBe(2_500)
    expect(stored(db).siteAuditMaxPages).toBe(2_500)

    // The update re-sends the project it read; the budget must not ride along as a stale value or a null.
    expect((await cli(['project', 'update', PROJECT, '--country', 'GB'])).error).toBeUndefined()
    expect(put.mock.calls.at(-1)![1]).not.toHaveProperty('siteAuditMaxPages')
    expect(stored(db)).toMatchObject({ country: 'GB', siteAuditMaxPages: 2_500 })

    expect((await cli(['project', 'update', PROJECT, '--site-audit-max-pages', 'full'])).error).toBeUndefined()
    expect(put.mock.calls.at(-1)![1].siteAuditMaxPages).toBeNull()
    expect(stored(db).siteAuditMaxPages).toBeNull()
  })

  it('project create saves a budget only when the flag is given, so re-running create keeps it', async () => {
    const { db } = await harness()
    expect((await cli(['project', 'create', 'beacon', '--domain', 'beacon.example', '--site-audit-max-pages', '100'])).error).toBeUndefined()
    expect(stored(db, 'beacon').siteAuditMaxPages).toBe(100)

    expect((await cli(['project', 'create', 'beacon', '--domain', 'beacon.example'])).error).toBeUndefined()
    expect(stored(db, 'beacon').siteAuditMaxPages).toBe(100)

    expect((await cli(['project', 'create', 'harbor', '--domain', 'harbor.example'])).error).toBeUndefined()
    expect(stored(db, 'harbor').siteAuditMaxPages).toBeNull()
  })

  it('project show prints the saved budget, or the full site when none is saved, and JSON carries the field', async () => {
    const { api } = await harness()
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Site Health page budget: full site (up to 50,000 pages)')
    expect(JSON.parse((await cli(['project', 'show', PROJECT], 'json')).lines.join('\n'))).toMatchObject({ siteAuditMaxPages: null })

    await api.putProject(PROJECT, { displayName: 'Northwind', canonicalDomain: 'northwind.example', country: 'US', language: 'en', siteAuditMaxPages: 2_500 })
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Site Health page budget: 2,500 pages')
    expect(JSON.parse((await cli(['project', 'show', PROJECT], 'json')).lines.join('\n'))).toMatchObject({ siteAuditMaxPages: 2_500 })
  })

  it('rejects anything but a whole number from 1 to 50,000 or "full" before any request', async () => {
    const { db, api } = await harness()
    const put = vi.spyOn(api, 'putProject')
    for (const [command, value] of [
      ['update', '0'], ['update', '50001'], ['update', 'abc'], ['update', '2.5'], ['update', '1e3'], ['update', ''], ['create', '0'],
    ] as const) {
      const { error } = await cli(['project', command, PROJECT, '--site-audit-max-pages', value])
      expect(error, value).toBeInstanceOf(CliError)
      expect(error, value).toMatchObject({
        code: 'CLI_USAGE_ERROR',
        exitCode: 1,
        message: '--site-audit-max-pages must be 1-50000 or "full"',
        details: { command: `project.${command}`, option: 'site-audit-max-pages', value },
      })
    }
    expect(put).not.toHaveBeenCalled()
    expect(stored(db).siteAuditMaxPages).toBeNull()
  })

  it('prints the usage error as the JSON error envelope and exits 1', async () => {
    cleanup.push(prepareCliReadFixture())
    const result = await invokeCli(['project', 'update', PROJECT, '--site-audit-max-pages', '50001', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'CLI_USAGE_ERROR',
        message: '--site-audit-max-pages must be 1-50000 or "full"',
        details: { command: 'project.update', option: 'site-audit-max-pages', value: '50001' },
      },
    })
  })

  it('lists the flag in project create and update --help', async () => {
    for (const command of ['create', 'update']) {
      const { lines } = await cli(['project', command, '--help'])
      expect(lines.join('\n'), command).toContain('[--site-audit-max-pages <1-50000|full>]')
    }
  })
})

describe('a scan started without a page budget runs with the saved one', () => {
  function recordedBudget(db: DatabaseClient): number {
    const rows = db.select().from(siteCrawlRunRequests).all()
    expect(rows).toHaveLength(1)
    return rows[0]!.effectiveOptions.maxPages
  }

  it('technical-aeo run without --max-pages uses the budget project update saved', async () => {
    const { db, scanBudgets } = await harness()
    await cli(['project', 'update', PROJECT, '--site-audit-max-pages', '2500'])
    const { error, lines } = await cli(['technical-aeo', 'run', PROJECT], 'json')
    expect(error).toBeUndefined()
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ status: 'queued' })
    expect(scanBudgets).toEqual([2_500])
    expect(recordedBudget(db)).toBe(2_500)
  })

  it('technical-aeo run without --max-pages covers the full site when the budget was reset with "full"', async () => {
    const { db, scanBudgets } = await harness()
    await cli(['project', 'update', PROJECT, '--site-audit-max-pages', '2500'])
    await cli(['project', 'update', PROJECT, '--site-audit-max-pages', 'full'])
    expect((await cli(['technical-aeo', 'run', PROJECT], 'json')).error).toBeUndefined()
    expect(scanBudgets).toEqual([SITE_AUDIT_MAX_PAGE_LIMIT])
    expect(recordedBudget(db)).toBe(50_000)
  })

  it('MCP: the budget canonry_project_upsert saves and canonry_apply_config keeps is the one canonry_technical_aeo_run uses', async () => {
    const { db, api, scanBudgets } = await harness()
    const server = createCanonryMcpServer({ eager: true, clientFactory: () => api })
    const mcp = new Client({ name: 'site-audit-budget-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)
    cleanup.push(async () => { await mcp.close(); await server.close() })
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args })
      expect(result.isError, name).not.toBe(true)
      return result.structuredContent
    }
    const spec = { displayName: 'Northwind', canonicalDomain: 'northwind.example', country: 'US', language: 'en' }

    expect(await call('canonry_project_upsert', { project: PROJECT, request: { ...spec, siteAuditMaxPages: 300 } }))
      .toMatchObject({ siteAuditMaxPages: 300 })
    expect(await call('canonry_apply_config', { config: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: PROJECT }, spec } }))
      .toMatchObject({ siteAuditMaxPages: 300 })
    expect(stored(db).siteAuditMaxPages).toBe(300)

    expect(await call('canonry_technical_aeo_run', { project: PROJECT })).toMatchObject({ status: 'queued' })
    expect(scanBudgets).toEqual([300])
    expect(recordedBudget(db)).toBe(300)
  })
})
