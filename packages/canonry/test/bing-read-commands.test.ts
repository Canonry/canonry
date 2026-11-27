import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apiKeys, bingQueryStats, bingTrafficDaily, createClient, migrate, projects } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'

/** Run a command and return what it printed with console.log. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return logs.join('\n')
}

describe('bing stored-read CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-bing-read-cmd-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir
    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    const db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString(),
    }).run()
    const projectId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId, name: 'sample', displayName: 'Sample', canonicalDomain: 'example.com',
      ownedDomains: '[]', country: 'US', language: 'en', tags: '[]', labels: '{}', providers: '[]',
      locations: '[]', defaultLocation: null, configSource: 'cli', configRevision: 1, createdAt: now, updatedAt: now,
    }).run()
    // Day i (Oct 1 + i) has i clicks and 10i impressions.
    db.insert(bingTrafficDaily).values(Array.from({ length: 31 }, (_, i) => ({
      id: crypto.randomUUID(), projectId, date: `2026-10-${String(i + 1).padStart(2, '0')}`, clicks: i, impressions: 10 * i, syncRunId: null, syncedAt: now,
    }))).run()
    const base = { projectId, avgClickPosition: null, syncRunId: null, syncedAt: now }
    db.insert(bingQueryStats).values([
      { ...base, id: crypto.randomUUID(), date: '2026-09-05', query: 'garage heater', clicks: 4, impressions: 40, avgImpressionPosition: 8 },
      { ...base, id: crypto.randomUUID(), date: '2026-10-10', query: 'garage heater', clicks: 6, impressions: 60, avgImpressionPosition: 4 },
      { ...base, id: crypto.randomUUID(), date: '2026-10-10', query: 'garage heater parts', clicks: 1, impressions: 10, avgImpressionPosition: 9 },
    ]).run()

    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    config.apiUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prints the API comparison for a named window', async () => {
    const { bingTraffic } = await import('../src/commands/bing.js')
    const out = await captureLog(() => bingTraffic('sample', { window: '7d' }))
    // Oct 25-31 (days 24..30, 189 clicks) against Oct 18-24 (days 17..23, 140).
    expect(out).toContain('Bing search traffic, 2026-10-25 to 2026-10-31: 189 clicks, 1890 impressions')
    expect(out).toContain('Change, vs prior 7 days:')
    expect(out).toMatch(/clicks \+35(\.0)?% \(140 -> 189\)/)
    expect(out).toMatch(/impressions \+35(\.0)?% \(1400 -> 1890\)/)
  })

  it('names a split window as such', async () => {
    const { bingTraffic } = await import('../src/commands/bing.js')
    const out = await captureLog(() => bingTraffic('sample', { window: '30d' }))
    expect(out).toContain('Change, last 15 days vs the 15 days before, inside this window:')
    expect(out).toMatch(/clicks \+187\.5% \(120 -> 345\)/)
  })

  it('passes --exact through and prints totals with the comparison', async () => {
    const { bingQueries } = await import('../src/commands/bing.js')
    const json = await captureLog(() => bingQueries('sample', { query: 'garage heater', exact: true, startDate: '2026-10-01', endDate: '2026-10-28', format: 'json' }))
    const body = JSON.parse(json) as { rows: Array<{ query: string }>; totals: { clicks: number } }
    expect(body.rows.map((row) => row.query)).toEqual(['garage heater'])
    expect(body.totals.clicks).toBe(6)

    const human = await captureLog(() => bingQueries('sample', { query: 'garage heater', exact: true, startDate: '2026-10-01', endDate: '2026-10-28' }))
    expect(human).toContain('All matching: 6 clicks, 60 impressions, position 4.0')
    // The 28 days before Oct 1 (Sep 3-30) hold the Sep 5 week: 4 clicks, 40 impressions, position 8.
    expect(human).toContain('vs prior 28 days: clicks +2, impressions +20, position -4')
  })
})
