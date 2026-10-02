import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import type { ScheduleDto } from '@ainyc/canonry-contracts'

// Defensive only: every schedule here targets 1 January, so none fires while a
// test runs. If one ever did, the stubbed engine keeps it off the network.
vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn().mockRejectedValue(new Error('engine stubbed')) }))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: vi.fn(async (url: string) => {
    const normalizedUrl = new URL(url).href
    return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
  }),
}))

import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import { printSchedule } from '../src/commands/schedule.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

const NEVER_DURING_A_TEST = '0 0 1 1 *'

describe('site-audit schedule options through the CLI and MCP', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let origCi: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-schedule-site-audit-options-'))
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    origCi = process.env.CI
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    process.env.CI = '1'

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    const db = createClient(dbPath)
    migrate(db)
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()

    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    config.apiUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKey)
    await client.putProject('audit-proj', { displayName: 'Audit', canonicalDomain: 'example.com', country: 'US', language: 'en' })
  })

  afterEach(async () => {
    await close()
    for (const [key, value] of [
      ['CANONRY_CONFIG_DIR', origConfigDir],
      ['CANONRY_TELEMETRY_DISABLED', origTelemetryDisabled],
      ['CI', origCi],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function cli(...args: string[]): Promise<ScheduleDto> {
    const result = await invokeCli(['schedule', ...args, '--format', 'json'])
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(undefined)
    return parseJsonOutput(result.stdout) as ScheduleDto
  }

  async function cliError(...args: string[]): Promise<{ code: string; message: string }> {
    const result = await invokeCli(['schedule', ...args, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    return (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error
  }

  it('sets, merges, carries forward and clears crawl options', async () => {
    const created = await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST,
      '--max-pages', '25000', '--sitemap-url', 'https://example.com/sitemap.xml', '--check-dead-links')
    expect(created.siteAuditOptions).toEqual({ maxPages: 25_000, sitemapUrl: 'https://example.com/sitemap.xml', checkDeadLinks: true })

    // Only the flags given change; the rest carry forward like every other field.
    const merged = await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST,
      '--max-depth', '4', '--max-edges', '600000', '--no-check-dead-links')
    expect(merged.siteAuditOptions).toEqual({
      maxPages: 25_000, sitemapUrl: 'https://example.com/sitemap.xml', checkDeadLinks: false, maxDepth: 4, maxEdges: 600_000,
    })
    expect(merged.cronExpr).toBe(NEVER_DURING_A_TEST)

    // Timing-only edits and pause/resume keep the stored crawl.
    const retimed = await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', '0 1 1 1 *')
    expect(retimed.siteAuditOptions).toEqual(merged.siteAuditOptions)
    expect((await cli('disable', 'audit-proj', '--kind', 'site-audit')).enabled).toBe(false)
    expect((await cli('enable', 'audit-proj', '--kind', 'site-audit')).enabled).toBe(true)
    expect((await cli('show', 'audit-proj', '--kind', 'site-audit')).siteAuditOptions).toEqual(merged.siteAuditOptions)

    const cleared = await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', '0 1 1 1 *', '--clear-site-audit-options')
    expect(cleared.siteAuditOptions).toBeNull()
    expect(cleared.cronExpr).toBe('0 1 1 1 *')
  })

  it('rejects crawl flags for other kinds and invalid values before calling the API', async () => {
    expect(await cliError('set', 'audit-proj', '--cron', NEVER_DURING_A_TEST, '--max-pages', '5000')).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--max-pages is only valid with --kind site-audit',
    })
    expect(await cliError('set', 'audit-proj', '--kind', 'data-refresh', '--cron', NEVER_DURING_A_TEST, '--check-dead-links')).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--check-dead-links is only valid with --kind site-audit',
    })
    expect(await cliError('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST, '--max-pages', 'lots')).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--max-pages must be an integer',
    })
    expect(await cliError('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST, '--check-dead-links', '--no-check-dead-links')).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--check-dead-links and --no-check-dead-links cannot be combined',
    })
    expect(await cliError('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST, '--clear-site-audit-options', '--max-depth', '2')).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--clear-site-audit-options cannot be combined with other crawl options',
    })
    expect((await client.listSchedules('audit-proj')).filter(schedule => schedule.kind !== 'doctor')).toEqual([])
  })

  it('surfaces the server limit as a validation error', async () => {
    const error = await cliError('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST, '--max-pages', '50001')
    expect(error.code).toBe('VALIDATION_ERROR')
  })

  it('round-trips options through the MCP schedule tools', async () => {
    const setTool = canonryMcpTools.find(tool => tool.name === 'canonry_schedule_set')!
    const getTool = canonryMcpTools.find(tool => tool.name === 'canonry_schedule_get')!
    const input = setTool.inputSchema.parse({
      project: 'audit-proj',
      schedule: { kind: 'site-audit', cron: NEVER_DURING_A_TEST, siteAuditOptions: { maxPages: 20_000, maxDepth: 8 } },
    })
    const written = await setTool.handler(client, input) as ScheduleDto
    expect(written.siteAuditOptions).toEqual({ maxPages: 20_000, maxDepth: 8 })
    const read = await getTool.handler(client, getTool.inputSchema.parse({ project: 'audit-proj', kind: 'site-audit' })) as ScheduleDto
    expect(read.siteAuditOptions).toEqual({ maxPages: 20_000, maxDepth: 8 })

    // The tool's own schema enforces the run limits before the request is sent.
    expect(setTool.inputSchema.safeParse({
      project: 'audit-proj', schedule: { kind: 'site-audit', cron: NEVER_DURING_A_TEST, siteAuditOptions: { maxPages: 50_001 } },
    }).success).toBe(false)
    // And the server refuses options on another kind.
    await expect(setTool.handler(client, setTool.inputSchema.parse({
      project: 'audit-proj', schedule: { kind: 'answer-visibility', cron: NEVER_DURING_A_TEST, siteAuditOptions: { maxPages: 5 } },
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('prints the crawl a site-audit schedule will run', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)) })
    try {
      printSchedule(await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST))
      printSchedule(await cli('set', 'audit-proj', '--kind', 'site-audit', '--cron', NEVER_DURING_A_TEST,
        '--max-pages', '25000', '--max-depth', '4', '--check-dead-links'))
    } finally {
      spy.mockRestore()
    }
    expect(lines.filter(line => line.startsWith('  Crawl:'))).toEqual([
      '  Crawl:     full site (up to 50,000 pages)',
      '  Crawl:     up to 25,000 pages, depth 4, dead-link checks on',
    ])
  })
})
