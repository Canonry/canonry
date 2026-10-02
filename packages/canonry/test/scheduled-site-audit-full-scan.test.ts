import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, apiKeys, projects, runs, schedules, siteCrawlRunRequests } from '@ainyc/canonry-db'
import { SITE_AUDIT_DEFAULT_PAGE_LIMIT, SITE_AUDIT_MAX_PAGE_LIMIT, type SiteAuditScheduleOptions } from '@ainyc/canonry-contracts'

// The seam under test runs from the schedule row, through the scheduler and the
// server's site-audit callback, into the crawl engine. Every unit in between
// already defaulted correctly on its own; the bug was that a scheduled audit
// was created with the 1,000-page manual default and the server then dropped
// whatever options the scheduler had, so only the engine call proves the fix.
// The engine and the root resolver are stubbed: nothing here touches a network.
vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: vi.fn(async (url: string) => {
    const normalizedUrl = new URL(url).href
    return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
  }),
}))

import { runSiteCrawl } from '@canonry/aeo-audit'
import { createServer } from '../src/server.js'

const NOW = '2026-10-02T00:00:00.000Z'
// Overdue, so `scheduler.start()` catches the missed slot up as soon as the
// listener is live: the same path a monthly audit takes after a restart.
const MISSED_RUN_AT = '2026-10-01T05:00:00.000Z'

describe('scheduled site audit page budget, schedule row to crawl engine', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let db: ReturnType<typeof createClient>
  let projectId: string
  let close: (() => Promise<void>) | undefined
  let serverUrl: string
  let apiKey: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduled-site-audit-'))
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    db = createClient(path.join(tmpDir, 'data.db'))
    migrate(db)
    apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 8),
      createdAt: NOW,
    }).run()
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'full-scan', displayName: 'Full Scan',
      canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [],
      createdAt: NOW, updatedAt: NOW,
    }).run()

    vi.mocked(runSiteCrawl).mockReset()
    // The crawl itself is out of scope; failing fast keeps the assertion on
    // the options the engine was handed.
    vi.mocked(runSiteCrawl).mockRejectedValue(new Error('engine stubbed'))
  })

  afterEach(async () => {
    await close?.()
    close = undefined
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedOverdueSiteAuditSchedule(siteAuditOptions?: SiteAuditScheduleOptions): void {
    db.insert(schedules).values({
      id: crypto.randomUUID(), projectId, kind: 'site-audit',
      cronExpr: '0 5 1 * *', timezone: 'UTC', enabled: true, providers: [],
      ...(siteAuditOptions ? { siteAuditOptions } : {}),
      nextRunAt: MISSED_RUN_AT, createdAt: NOW, updatedAt: NOW,
    }).run()
  }

  async function startServer(): Promise<void> {
    const config = { apiUrl: 'http://localhost:0', database: path.join(tmpDir, 'data.db'), apiKey, providers: {} }
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    close = () => app.close()
  }

  async function engineOptions(): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(vi.mocked(runSiteCrawl)).toHaveBeenCalledTimes(1))
    return vi.mocked(runSiteCrawl).mock.calls[0]![1] as unknown as Record<string, unknown>
  }

  function onlySiteAuditRequest() {
    const rows = db.select({ trigger: runs.trigger, effectiveOptions: siteCrawlRunRequests.effectiveOptions })
      .from(siteCrawlRunRequests)
      .innerJoin(runs, eq(runs.id, siteCrawlRunRequests.runId))
      .all()
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  it('crawls up to the hard page limit when the schedule stores no options', async () => {
    seedOverdueSiteAuditSchedule()
    await startServer()

    const options = await engineOptions()
    expect(options.maxPages).toBe(SITE_AUDIT_MAX_PAGE_LIMIT)
    // Still unset, so the engine derives the edge budget from the page count.
    expect(options.maxEdges).toBeUndefined()
    expect(options.maxDepth).toBeUndefined()
    expect(options.checkDeadLinks).toBe(false)
    expect(onlySiteAuditRequest()).toEqual({
      trigger: 'scheduled',
      effectiveOptions: {
        schemaVersion: 2, sitemapUrl: null, maxPages: SITE_AUDIT_MAX_PAGE_LIMIT,
        maxEdges: null, maxDepth: null, checkDeadLinks: false,
      },
    })
  })

  it('crawls with exactly the options the schedule stores', async () => {
    seedOverdueSiteAuditSchedule({ maxPages: 25_000, maxEdges: 600_000, maxDepth: 6, checkDeadLinks: true })
    await startServer()

    const options = await engineOptions()
    expect(options).toMatchObject({ maxPages: 25_000, maxEdges: 600_000, maxDepth: 6, checkDeadLinks: true })
    expect(onlySiteAuditRequest().effectiveOptions).toEqual({
      schemaVersion: 2, sitemapUrl: null, maxPages: 25_000, maxEdges: 600_000, maxDepth: 6, checkDeadLinks: true,
    })
  })

  it('keeps the documented 1,000-page default for a manual run', async () => {
    await startServer()

    const response = await fetch(`${serverUrl}/api/v1/projects/full-scan/technical-aeo/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)

    expect((await engineOptions()).maxPages).toBe(SITE_AUDIT_DEFAULT_PAGE_LIMIT)
    expect(onlySiteAuditRequest()).toMatchObject({ trigger: 'manual', effectiveOptions: { maxPages: SITE_AUDIT_DEFAULT_PAGE_LIMIT } })
  })
})
