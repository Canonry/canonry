import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, gbpLocations, gbpDailyMetrics, projects } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import {
  gbpLocationsList,
  gbpLocationSelect,
  gbpLocationDeselect,
  gbpDisconnect,
  gbpSummary,
  gbpMetrics,
} from '../src/commands/gbp.js'

/** UTC today as YYYY-MM-DD — matches how the summary route anchors `asOfDate`. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
function shiftUtc(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

describe('gbp CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>
  let projectId: string

  async function seedLocation(opts: { locationName: string; displayName: string; selected: boolean; primaryCategory?: string }) {
    const now = new Date().toISOString()
    db.insert(gbpLocations).values({
      id: crypto.randomUUID(),
      projectId,
      accountName: 'accounts/123',
      locationName: opts.locationName,
      displayName: opts.displayName,
      primaryCategoryDisplayName: opts.primaryCategory ?? 'Hotel',
      storefrontAddress: null,
      websiteUri: null,
      selected: opts.selected,
      syncedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  function seedMetric(locationName: string, date: string, metric: string, value: number) {
    db.insert(gbpDailyMetrics).values({
      id: crypto.randomUUID(),
      projectId,
      locationName,
      date,
      metric,
      value,
      syncRunId: null,
    }).run()
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-gbp-cmd-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: hashed,
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
    }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({
      config: config as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)

    // Seed a project we can target across tests.
    await client.putProject('hotels', {
      displayName: 'Hotels',
      canonicalDomain: 'hotels.example.com',
      country: 'US',
      language: 'en',
      keywords: [],
    })
    projectId = (db.select().from(projects).all() as { id: string; name: string }[]).find(p => p.name === 'hotels')!.id
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('gbp locations list', () => {
    it('returns empty list shape when nothing discovered', async () => {
      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += msg }
      try {
        await gbpLocationsList('hotels', { format: 'json' })
      } finally {
        console.log = origLog
      }
      const parsed = JSON.parse(captured)
      expect(parsed).toEqual({
        locations: [],
        totalDiscovered: 0,
        totalSelected: 0,
      })
    })

    it('lists seeded locations with selection summary', async () => {
      await seedLocation({ locationName: 'locations/1', displayName: 'Hotel One', selected: true })
      await seedLocation({ locationName: 'locations/2', displayName: 'Hotel Two', selected: false })

      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += msg }
      try {
        await gbpLocationsList('hotels', { format: 'json' })
      } finally {
        console.log = origLog
      }
      const parsed = JSON.parse(captured) as {
        locations: { locationName: string; selected: boolean }[]
        totalDiscovered: number
        totalSelected: number
      }
      expect(parsed.totalDiscovered).toBe(2)
      expect(parsed.totalSelected).toBe(1)
      expect(parsed.locations.map(l => l.locationName).sort()).toEqual(['locations/1', 'locations/2'])
    })

    it('filters to selected-only when --selected-only is passed', async () => {
      await seedLocation({ locationName: 'locations/1', displayName: 'Hotel One', selected: true })
      await seedLocation({ locationName: 'locations/2', displayName: 'Hotel Two', selected: false })

      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += msg }
      try {
        await gbpLocationsList('hotels', { format: 'json', selectedOnly: true })
      } finally {
        console.log = origLog
      }
      const parsed = JSON.parse(captured) as { locations: { locationName: string }[] }
      expect(parsed.locations.map(l => l.locationName)).toEqual(['locations/1'])
    })
  })

  describe('gbp locations select / deselect', () => {
    it('toggles selection from false to true', async () => {
      await seedLocation({ locationName: 'locations/42', displayName: 'Hotel Alpha', selected: false })

      await gbpLocationSelect('hotels', { location: 'locations/42', format: 'json' })

      const refreshed = await client.listGbpLocations('hotels')
      const row = refreshed.locations.find(l => l.locationName === 'locations/42')
      expect(row?.selected).toBe(true)
    })

    it('toggles selection from true to false', async () => {
      await seedLocation({ locationName: 'locations/42', displayName: 'Hotel Alpha', selected: true })

      await gbpLocationDeselect('hotels', { location: 'locations/42', format: 'json' })

      const refreshed = await client.listGbpLocations('hotels')
      const row = refreshed.locations.find(l => l.locationName === 'locations/42')
      expect(row?.selected).toBe(false)
    })

    it('throws a user-facing error for an unknown location', async () => {
      await expect(
        gbpLocationSelect('hotels', { location: 'locations/does-not-exist', format: 'json' }),
      ).rejects.toThrow(/not found|404/i)
    })
  })

  describe('gbp disconnect', () => {
    it('removes all gbp_locations rows for the project', async () => {
      await seedLocation({ locationName: 'locations/1', displayName: 'A', selected: true })
      await seedLocation({ locationName: 'locations/2', displayName: 'B', selected: false })

      await gbpDisconnect('hotels', { format: 'json' })

      const remaining = db.select().from(gbpLocations).all()
      expect(remaining.length).toBe(0)
    })
  })

  describe('gbp summary / metrics rendering (#658)', () => {
    it('summary JSON carries lag-safe freshness + a daily timeseries', async () => {
      const t = todayUtc()
      await seedLocation({ locationName: 'locations/sum', displayName: 'Summary Hotel', selected: true })
      // Real traffic through t-3, then not-yet-reported zeros for the lag tail.
      seedMetric('locations/sum', shiftUtc(t, -5), 'WEBSITE_CLICKS', 10)
      seedMetric('locations/sum', shiftUtc(t, -4), 'WEBSITE_CLICKS', 10)
      seedMetric('locations/sum', shiftUtc(t, -3), 'WEBSITE_CLICKS', 10)
      seedMetric('locations/sum', shiftUtc(t, -3), 'CALL_CLICKS', 4)
      seedMetric('locations/sum', shiftUtc(t, -3), 'BUSINESS_BOOKINGS', 0)
      seedMetric('locations/sum', shiftUtc(t, -2), 'WEBSITE_CLICKS', 0)
      seedMetric('locations/sum', shiftUtc(t, -1), 'WEBSITE_CLICKS', 0)

      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += msg }
      try {
        await gbpSummary('hotels', { format: 'json' })
      } finally {
        console.log = origLog
      }
      const parsed = JSON.parse(captured) as {
        freshness: { dataThroughDate: string; latestStoredDate: string; pendingDays: number }
        performance: { totals: Record<string, number> }
        timeseries: { date: string; pending: boolean }[]
      }
      // The complete day is t-3 (last non-zero), NOT the stored zero tail (t-1).
      expect(parsed.freshness.dataThroughDate).toBe(shiftUtc(t, -3))
      expect(parsed.freshness.latestStoredDate).toBe(shiftUtc(t, -1))
      expect(parsed.freshness.pendingDays).toBe(3)
      expect(parsed.performance.totals.WEBSITE_CLICKS).toBe(30)
      expect(parsed.performance.totals.CALL_CLICKS).toBe(4)
      // The lag tail is present in the series but flagged pending, never a real value.
      expect(parsed.timeseries.filter((d) => d.pending).length).toBe(2)
      expect(parsed.timeseries.find((d) => d.date === shiftUtc(t, -3))?.pending).toBe(false)
    })

    it('summary human output uses labels (no raw BUSINESS_* keys) and shows freshness', async () => {
      const t = todayUtc()
      await seedLocation({ locationName: 'locations/sum', displayName: 'Summary Hotel', selected: true })
      seedMetric('locations/sum', shiftUtc(t, -3), 'WEBSITE_CLICKS', 30)
      seedMetric('locations/sum', shiftUtc(t, -3), 'BUSINESS_DIRECTION_REQUESTS', 12)

      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += `${msg}\n` }
      try {
        await gbpSummary('hotels', {})
      } finally {
        console.log = origLog
      }
      expect(captured).toContain('Website clicks')
      expect(captured).toContain('Direction requests')
      expect(captured).not.toContain('WEBSITE_CLICKS')
      expect(captured).toContain('Data through')
      expect(captured).toContain('pending')
    })

    it('metrics human output renders labels, not raw keys', async () => {
      const t = todayUtc()
      await seedLocation({ locationName: 'locations/sum', displayName: 'Summary Hotel', selected: true })
      seedMetric('locations/sum', shiftUtc(t, -3), 'WEBSITE_CLICKS', 30)

      let captured = ''
      const origLog = console.log
      console.log = (msg: string) => { captured += `${msg}\n` }
      try {
        await gbpMetrics('hotels', {})
      } finally {
        console.log = origLog
      }
      expect(captured).toContain('Website clicks')
      expect(captured).not.toContain('WEBSITE_CLICKS')
    })
  })
})
