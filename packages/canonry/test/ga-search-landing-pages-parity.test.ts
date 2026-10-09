import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apiKeys, createClient, gaMeasurementSyncStates, gaSearchLandingPages, gaSearchLandingWindows, migrate, projects } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { gaSearchLandingPagesResponseSchema } from '@ainyc/canonry-contracts'
import type { GaSearchLandingPagesResponse } from '@ainyc/canonry-contracts'
import { eq } from 'drizzle-orm'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'

// CLI, API and MCP read the same stored GA4 Search Console landing-page
// snapshot through a real server: the CLI's JSON is the API response, and the
// human table prints the API's Total first, never a sum of the rows shown.

const PROJECT = 'search-landing'
const SYNCED_AT = '2026-10-08T15:00:00.000Z'

describe('ga search-landing-pages parity', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let db: DatabaseClient
  let projectId: string
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-ga-search-landing-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir
    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: SYNCED_AT,
    }).run()
    // The project's GA4 connection names the property the seeded snapshot was
    // read from: the read only presents the current property's snapshot.
    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
      ga4: {
        connections: [{
          projectName: PROJECT,
          propertyId: '123456',
          clientEmail: 'ga@test.iam.gserviceaccount.com',
          privateKey: 'fake-key',
          createdAt: SYNCED_AT,
          updatedAt: SYNCED_AT,
        }],
      },
    }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const serverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)
    await client.putProject(PROJECT, { displayName: 'Search Landing', canonicalDomain: 'example.com', country: 'US', language: 'en' })
    projectId = db.select().from(projects).where(eq(projects.name, PROJECT)).get()!.id
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSnapshot(status: 'ready' | 'error' = 'ready') {
    db.insert(gaSearchLandingWindows).values({
      id: crypto.randomUUID(),
      projectId,
      propertyId: '123456',
      windowKey: '28d',
      periodStart: '2026-09-10',
      periodEnd: '2026-10-07',
      timeZone: 'America/Los_Angeles',
      totalClicks: 837,
      totalImpressions: 41422,
      totalCtr: 0.020206653469170971,
      totalAveragePosition: 7.31567765921491,
      totalActiveUsers: 1093,
      reportRowCount: 87,
      rowsCapped: false,
      syncedAt: SYNCED_AT,
      createdAt: SYNCED_AT,
    }).run()
    const rows = [
      { landingPage: '/', clicks: 612, impressions: 13940, ctr: 0.043902439024390241, averagePosition: 7.2103299856527974, activeUsers: 734 },
      { landingPage: '/pricing', clicks: 57, impressions: 3120, ctr: 0.01826923076923077, averagePosition: 5.1301282051282051, activeUsers: 71 },
      { landingPage: '/members?ref=newsletter', clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 4 },
    ]
    for (const row of rows) {
      db.insert(gaSearchLandingPages).values({ id: crypto.randomUUID(), projectId, windowKey: '28d', ...row, syncedAt: SYNCED_AT, createdAt: SYNCED_AT }).run()
    }
    db.insert(gaMeasurementSyncStates).values({
      projectId,
      searchLandingStatus: status,
      searchLandingError: status === 'error' ? 'GA4 API rate limit exceeded' : null,
      searchLandingSyncedAt: SYNCED_AT,
      searchLandingAttemptedAt: status === 'error' ? '2026-10-09T15:00:00.000Z' : SYNCED_AT,
      updatedAt: SYNCED_AT,
    }).run()
  }

  async function captureCli(args: Record<string, string | undefined>): Promise<string[]> {
    const { gaSearchLandingPages: command } = await import('../src/commands/ga.js')
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { logs.push(parts.join(' ')) })
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    try {
      await command(PROJECT, args)
    } finally {
      write.mockRestore()
      log.mockRestore()
    }
    return [...logs, ...writes.join('').split('\n').filter(Boolean)]
  }

  it('prints the API response verbatim for --format json and through the registered command', async () => {
    seedSnapshot()
    const api = await client.gaSearchLandingPages(PROJECT, { window: '28d', limit: '2' })
    expect(gaSearchLandingPagesResponseSchema.parse(api)).toEqual(api)
    expect(api).toMatchObject({ totalRows: 3, limit: 2, offset: 0 })

    const lines = await captureCli({ window: '28d', limit: '2', format: 'json' })
    expect(JSON.parse(lines.join('\n'))).toEqual(api)

    // The registered spec forwards --window / --limit / --offset to the same read.
    vi.restoreAllMocks()
    const { GA_CLI_COMMANDS } = await import('../src/cli-commands/ga.js')
    const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { output.push(parts.join(' ')) })
    await dispatchRegisteredCommand(['ga', 'search-landing-pages', PROJECT, '--limit', '1', '--offset', '1'], 'json', GA_CLI_COMMANDS)
    const dispatched = JSON.parse(output.join('\n')) as GaSearchLandingPagesResponse
    expect(dispatched).toMatchObject({ window: '28d', limit: 1, offset: 1, totalRows: 3 })
    expect(dispatched.rows.map(row => row.landingPage)).toEqual(['/pricing'])
  })

  it('streams one stamped line per landing page for --format jsonl', async () => {
    seedSnapshot()

    const lines = await captureCli({ format: 'jsonl' })

    expect(lines.map(line => JSON.parse(line))).toEqual([
      { project: PROJECT, window: '28d', windowStart: '2026-09-10', windowEnd: '2026-10-07', landingPage: '/', organicGoogleSearchClicks: 612, organicGoogleSearchImpressions: 13940, organicGoogleSearchClickThroughRate: 0.04390244, organicGoogleSearchAveragePosition: 7.2103299856527974, activeUsers: 734 },
      { project: PROJECT, window: '28d', windowStart: '2026-09-10', windowEnd: '2026-10-07', landingPage: '/pricing', organicGoogleSearchClicks: 57, organicGoogleSearchImpressions: 3120, organicGoogleSearchClickThroughRate: 0.01826923, organicGoogleSearchAveragePosition: 5.1301282051282051, activeUsers: 71 },
      { project: PROJECT, window: '28d', windowStart: '2026-09-10', windowEnd: '2026-10-07', landingPage: '/members?ref=newsletter', organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 4 },
    ])
  })

  it('prints GA4\'s Total first, then the rows, with formatted CTR and position', async () => {
    seedSnapshot()

    const lines = await captureCli({})

    expect(lines[0]).toBe(`Google organic search traffic: landing page + query string (GA4 Search Console link) for "${PROJECT}"`)
    expect(lines[1]).toBe('Last 28 days: 2026-09-10 to 2026-10-07 (America/Los_Angeles)')
    const tableRows = lines.map(line => line.trim().split(/\s{2,}/))
    const header = tableRows.findIndex(cells => cells[0] === 'LANDING PAGE')
    expect(tableRows[header]).toEqual(['LANDING PAGE', 'CLICKS', 'IMPRESSIONS', 'CTR', 'AVG POSITION', 'ACTIVE USERS'])
    expect(tableRows.slice(header + 2, header + 6)).toEqual([
      ['Total', '837', '41,422', '2.0%', '7.3', '1,093'],
      ['/', '612', '13,940', '4.4%', '7.2', '734'],
      ['/pricing', '57', '3,120', '1.8%', '5.1', '71'],
      ['/members?ref=newsletter', '0', '0', 'n/a', 'n/a', '4'],
    ])
    expect(lines).toContain('  Showing 1-3 of 3 pages.')
    expect(lines).toContain(`  Synced at: ${SYNCED_AT}`)
    expect(lines).not.toContain('  No landing pages had Google organic search traffic in this window.')
  })

  it('says a failed refresh is showing the previous snapshot', async () => {
    seedSnapshot('error')

    const lines = await captureCli({})

    expect(lines).toContain('Status: the last refresh failed (2026-10-09T15:00:00.000Z): GA4 API rate limit exceeded')
    expect(lines).toContain(`Showing the snapshot synced ${SYNCED_AT}.`)
    expect(lines.some(line => line.trim().startsWith('Total'))).toBe(true)
  })

  it('tells a never-synced project to sync, and exits 0', async () => {
    const lines = await captureCli({})

    expect(lines).toEqual([`No GA4 Search Console landing-page data for "${PROJECT}" yet. Run "canonry ga sync ${PROJECT}".`])
  })

  it('explains an unavailable first attempt and how to link Search Console', async () => {
    db.insert(gaMeasurementSyncStates).values({
      projectId,
      searchLandingStatus: 'unavailable',
      searchLandingError: 'GA4 returned no Search Console rows (NO_LINK)',
      searchLandingAttemptedAt: SYNCED_AT,
      updatedAt: SYNCED_AT,
    }).run()

    const lines = await captureCli({})

    expect(lines).toEqual([
      `Google organic search traffic: landing page + query string (GA4 Search Console link) for "${PROJECT}"`,
      'Status: unavailable. GA4 did not return Search Console data: GA4 returned no Search Console rows (NO_LINK)',
      `Link Search Console to this GA4 property (GA4 Admin, Product links, Search Console links), then run "canonry ga sync ${PROJECT}".`,
      'No stored snapshot.',
    ])
  })

  it('prints GA4\'s zero Total and the Search Console link hint for a window with no pages', async () => {
    db.insert(gaSearchLandingWindows).values({
      id: crypto.randomUUID(),
      projectId,
      propertyId: '123456',
      windowKey: '28d',
      periodStart: '2026-09-10',
      periodEnd: '2026-10-07',
      timeZone: 'America/Los_Angeles',
      syncedAt: SYNCED_AT,
      createdAt: SYNCED_AT,
    }).run()
    db.insert(gaMeasurementSyncStates).values({ projectId, searchLandingStatus: 'ready', searchLandingSyncedAt: SYNCED_AT, searchLandingAttemptedAt: SYNCED_AT, updatedAt: SYNCED_AT }).run()

    const lines = await captureCli({})

    const tableRows = lines.map(line => line.trim().split(/\s{2,}/))
    expect(tableRows.find(cells => cells[0] === 'Total')).toEqual(['Total', '0', '0', 'n/a', 'n/a', '0'])
    expect(lines).toContain('  No landing pages had Google organic search traffic in this window.')
    expect(lines).toContain('  If the property should have some, check its Search Console link in GA4 (Admin, Product links, Search Console links).')
  })

  it('prints the Search Console link hint when pages are listed but GA4\'s Total has no clicks or impressions', async () => {
    db.insert(gaSearchLandingWindows).values({
      id: crypto.randomUUID(),
      projectId,
      propertyId: '123456',
      windowKey: '28d',
      periodStart: '2026-09-10',
      periodEnd: '2026-10-07',
      timeZone: 'America/Los_Angeles',
      totalActiveUsers: 9,
      reportRowCount: 1,
      syncedAt: SYNCED_AT,
      createdAt: SYNCED_AT,
    }).run()
    db.insert(gaSearchLandingPages).values({ id: crypto.randomUUID(), projectId, windowKey: '28d', landingPage: '/', clicks: 0, impressions: 0, ctr: null, averagePosition: null, activeUsers: 9, syncedAt: SYNCED_AT, createdAt: SYNCED_AT }).run()
    db.insert(gaMeasurementSyncStates).values({ projectId, searchLandingStatus: 'ready', searchLandingSyncedAt: SYNCED_AT, searchLandingAttemptedAt: SYNCED_AT, updatedAt: SYNCED_AT }).run()

    const lines = await captureCli({})

    const tableRows = lines.map(line => line.trim().split(/\s{2,}/))
    expect(tableRows.find(cells => cells[0] === '/')).toEqual(['/', '0', '0', 'n/a', 'n/a', '9'])
    expect(lines).toContain('  Showing 1-1 of 1 pages.')
    expect(lines).toContain('  No landing pages had Google organic search traffic in this window.')
    expect(lines).toContain('  If the property should have some, check its Search Console link in GA4 (Admin, Product links, Search Console links).')
  })

  it('prints no Search Console link hint when GA4\'s Total has search data but no pages are stored', async () => {
    db.insert(gaSearchLandingWindows).values({
      id: crypto.randomUUID(),
      projectId,
      propertyId: '123456',
      windowKey: '28d',
      periodStart: '2026-09-10',
      periodEnd: '2026-10-07',
      timeZone: 'America/Los_Angeles',
      totalClicks: 14,
      totalImpressions: 690,
      totalCtr: 14 / 690,
      totalAveragePosition: 8.4,
      totalActiveUsers: 17,
      reportRowCount: 0,
      subjectToThresholding: true,
      syncedAt: SYNCED_AT,
      createdAt: SYNCED_AT,
    }).run()
    db.insert(gaMeasurementSyncStates).values({ projectId, searchLandingStatus: 'ready', searchLandingSyncedAt: SYNCED_AT, searchLandingAttemptedAt: SYNCED_AT, updatedAt: SYNCED_AT }).run()

    const lines = await captureCli({})

    const tableRows = lines.map(line => line.trim().split(/\s{2,}/))
    expect(tableRows.find(cells => cells[0] === 'Total')).toEqual(['Total', '14', '690', '2.0%', '8.4', '17'])
    expect(lines).not.toContain('  No landing pages had Google organic search traffic in this window.')
    expect(lines).toContain('  GA4 applied thresholding to this report, so some rows may be withheld.')
  })

  it('surfaces the server\'s validation error as a user error (exit 1)', async () => {
    const error = await captureCli({ window: '30d' }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(1)
    expect((error as CliError).message).toContain('"window" must be one of: 7d, 28d, 90d')
  })

  it('serves the MCP tool from the same read with the same parameters', async () => {
    seedSnapshot()
    const { canonryMcpTools } = await import('../src/mcp/tool-registry.js')
    const tool = canonryMcpTools.find(entry => entry.name === 'canonry_ga_search_landing_pages')

    expect(tool).toMatchObject({
      tier: 'ga',
      access: 'read',
      openApiOperations: ['GET /api/v1/projects/{name}/ga/search-landing-pages'],
    })
    expect(tool!.inputSchema.safeParse({ project: PROJECT, window: '30d' }).success).toBe(false)
    expect(tool!.inputSchema.safeParse({ project: PROJECT, limit: 1001 }).success).toBe(false)

    const viaMcp = await tool!.handler(client, { project: PROJECT, window: '28d', limit: 1, offset: 1 })
    const viaApi = await client.gaSearchLandingPages(PROJECT, { window: '28d', limit: '1', offset: '1' })
    expect(viaMcp).toEqual(viaApi)
    expect(viaApi).toMatchObject({ limit: 1, offset: 1, rows: [{ landingPage: '/pricing' }] })
    expect((viaMcp as GaSearchLandingPagesResponse).total?.organicGoogleSearchClicks).toBe(837)
  })
})
