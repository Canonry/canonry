import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, runs, gaDailyTotals, gscDailyTotals, gscDataWatermarks } from '@ainyc/canonry-db'
import {
  DATA_FRESHNESS_CHECKS,
  daysBetweenIsoDates,
  daysSinceDate,
  GA_DATA_AGING_DAYS,
  GA_DATA_STALE_DAYS,
  GSC_DATA_AGING_DAYS,
  GSC_DATA_STALE_DAYS,
  GSC_REPORTING_TIME_ZONE,
} from '../src/doctor/checks/data-freshness.js'
import { formatIsoDateInTimeZone } from '@ainyc/canonry-contracts'
import type { CheckDefinition, DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

// The auth checks prove a token works; they cannot see a sync that succeeds and
// returns nothing. But both APIs omit days with no data, so these also pin the
// cases where silence is normal: a quiet site, and a project nobody syncs.

const byId = (id: string): CheckDefinition => {
  const found = DATA_FRESHNESS_CHECKS.find(check => check.id === id)
  if (!found) throw new Error(`no check ${id}`)
  return found
}
const gaCheck = byId('ga.data.recent-data')
const gscCheck = byId('gsc.data.recent-data')

const dayMs = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * dayMs).toISOString().slice(0, 10)
/**
 * Search Console ages are counted in Google's reporting time zone, so a fixture
 * built from UTC "today" is off by a day for most of the UTC morning and the
 * test would pass or fail depending on the hour it ran.
 */
const gscDaysAgo = (days: number) => {
  const today = formatIsoDateInTimeZone(new Date().toISOString(), GSC_REPORTING_TIME_ZONE)
  const [y, m, d] = today.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d) - days * dayMs).toISOString().slice(0, 10)
}
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

function store(connected: Array<'ga4' | 'gsc'>): GoogleConnectionStore {
  return {
    listConnections: () => [],
    getConnection: (_domain: string, type: string) => (connected.includes(type as 'ga4' | 'gsc') ? ({ connectionType: type } as never) : undefined),
    upsertConnection: (record: never) => record,
    updateConnection: () => undefined,
    deleteConnection: () => true,
  } as unknown as GoogleConnectionStore
}

describe('data freshness checks', () => {
  let tmp: string
  let db: ReturnType<typeof createClient>
  let project: ProjectInfo

  const insertProject = (name: string, domain: string) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: domain, country: 'US', language: 'en',
      providers: [], createdAt: now, updatedAt: now,
    } as typeof projects.$inferInsert).run()
    return id
  }
  const syncedAt = (kind: string, iso: string, status = 'completed') => {
    db.insert(runs).values({ id: crypto.randomUUID(), projectId: project.id, kind, status, trigger: 'scheduled', createdAt: iso }).run()
  }
  const ga = (projectId: string, date: string) => {
    const now = new Date().toISOString()
    db.insert(gaDailyTotals).values({ id: crypto.randomUUID(), projectId, date, sessions: 3, users: 3, syncedAt: now, createdAt: now }).run()
  }
  const gsc = (projectId: string, date: string) => {
    db.insert(gscDailyTotals).values({ id: crypto.randomUUID(), projectId, date, clicks: 0, impressions: 4, position: '12.5', createdAt: new Date().toISOString() }).run()
  }
  const watermark = (projectId: string, dataThroughDate: string) => {
    db.insert(gscDataWatermarks).values({ projectId, dataThroughDate, syncedThroughDate: dataThroughDate, updatedAt: new Date().toISOString() }).run()
  }
  const ctx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({ db, project, ...overrides })
  const gaCtx = () => ctx({ googleConnectionStore: store(['ga4']) })
  const gscCtx = () => ctx({ googleConnectionStore: store(['gsc']) })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-freshness-'))
    db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    const id = insertProject('client', 'client.example')
    project = { id, name: 'client', canonicalDomain: 'client.example', displayName: 'client' }
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  describe('ga.data.recent-data', () => {
    it('skips a deployment with no GA4 credential store, and a project that never connected', async () => {
      expect(await gaCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'ga.data.store-unavailable' })
      ga(project.id, daysAgo(30))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))).toMatchObject({ status: 'skipped', code: 'ga.data.not-connected' })
    })

    it('warns when connected but nothing has been stored yet', async () => {
      const result = await gaCheck.run(gaCtx())
      expect(result).toMatchObject({ status: 'warn', code: 'ga.data.never-synced' })
      expect(result.remediation).toContain('canonry ga sync client')
    })

    it('is fresh when yesterday arrived', async () => {
      ga(project.id, daysAgo(1))
      syncedAt('ga-sync', hoursAgo(2))
      expect(await gaCheck.run(gaCtx())).toMatchObject({ status: 'ok', code: 'ga.data.fresh' })
    })

    it('says nobody is syncing, rather than blaming the tag, when no sync has run', async () => {
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS + 3))
      const result = await gaCheck.run(gaCtx())
      expect(result).toMatchObject({ status: 'warn', code: 'ga.data.not-syncing' })
      expect(result.remediation).toContain('data-refresh')
      expect(result.remediation).not.toMatch(/tag/i)
    })

    it('blames the tag only when syncs ARE running and still bring nothing back', async () => {
      ga(project.id, daysAgo(GA_DATA_AGING_DAYS))
      syncedAt('ga-sync', hoursAgo(3))
      const aging = await gaCheck.run(gaCtx())
      expect(aging).toMatchObject({ status: 'warn', code: 'ga.data.aging' })
      expect(aging.remediation).toMatch(/tag/i)
      expect(aging.remediation).toMatch(/quiet/i)
    })

    it('escalates the code, but never the status, so a failing auth check keeps the headline', async () => {
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS))
      syncedAt('ga-sync', hoursAgo(3))
      expect(await gaCheck.run(gaCtx())).toMatchObject({ status: 'warn', code: 'ga.data.stale' })
    })

    it('grades the newest date, and counts a service-account connection as connected', async () => {
      ga(project.id, daysAgo(40))
      ga(project.id, daysAgo(1))
      syncedAt('ga-sync', hoursAgo(2))
      const ga4CredentialStore = { getConnection: (name: string) => (name === 'client' ? ({ propertyId: '1' } as never) : undefined) } as unknown as DoctorContext['ga4CredentialStore']
      expect(await gaCheck.run(ctx({ ga4CredentialStore }))).toMatchObject({ code: 'ga.data.fresh' })
    })

    it("never lets another project's data answer for this one", async () => {
      const other = insertProject('other', 'other.example')
      ga(other, daysAgo(0))
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS + 9))
      syncedAt('ga-sync', hoursAgo(2))
      expect(await gaCheck.run(gaCtx())).toMatchObject({ code: 'ga.data.stale' })
    })
  })

  describe('gsc.data.recent-data', () => {
    it('skips when Search Console is not connected', async () => {
      gsc(project.id, gscDaysAgo(30))
      expect(await gscCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ status: 'skipped', code: 'gsc.data.not-connected' })
    })

    it('treats the normal two-to-three day lag as fresh', async () => {
      gsc(project.id, gscDaysAgo(3))
      syncedAt('gsc-sync', hoursAgo(5))
      expect(await gscCheck.run(gscCtx())).toMatchObject({ status: 'ok', code: 'gsc.data.fresh' })
    })

    it('reads the watermark first, so a quiet property with no rows is not called stale', async () => {
      // Search Analytics omits zero-impression days; the watermark advances anyway.
      gsc(project.id, gscDaysAgo(30))
      watermark(project.id, gscDaysAgo(2))
      syncedAt('gsc-sync', hoursAgo(4))
      expect(await gscCheck.run(gscCtx())).toMatchObject({ status: 'ok', code: 'gsc.data.fresh', details: { newestDate: gscDaysAgo(2) } })
    })

    it('falls back to the newest row when no watermark exists', async () => {
      gsc(project.id, gscDaysAgo(GSC_DATA_STALE_DAYS))
      syncedAt('gsc-sync', hoursAgo(4))
      const result = await gscCheck.run(gscCtx())
      expect(result).toMatchObject({ status: 'warn', code: 'gsc.data.stale' })
      // Syncs are running, so the advice is about the property, not about running
      // a sync. The sync command belongs to the never-synced and not-syncing codes.
      expect(result.remediation).toMatch(/impressions/i)
      expect(result.remediation).toMatch(/property/i)
    })

    it('warns at the aging limit', async () => {
      watermark(project.id, gscDaysAgo(GSC_DATA_AGING_DAYS))
      syncedAt('gsc-sync', hoursAgo(4))
      expect(await gscCheck.run(gscCtx())).toMatchObject({ status: 'warn', code: 'gsc.data.aging' })
    })
  })

  describe('date arithmetic', () => {
    it('counts whole calendar days between two dates', () => {
      expect(daysBetweenIsoDates('2026-09-15', '2026-09-15')).toBe(0)
      expect(daysBetweenIsoDates('2026-09-01', '2026-09-15')).toBe(14)
      expect(daysBetweenIsoDates('nope', '2026-09-15')).toBeNull()
    })

    it('counts Search Console ages on Google reporting dates, not UTC', () => {
      // 03:00 UTC is still the previous day in Pacific time. Counting in UTC
      // read every GSC age one day high for most of the UTC morning, which made
      // a healthy property alternate between aging and recovered every day.
      const utcMorning = new Date('2026-09-16T03:00:00.000Z')
      expect(daysSinceDate('2026-09-11', utcMorning)).toBe(5)
      expect(daysSinceDate('2026-09-11', utcMorning, GSC_REPORTING_TIME_ZONE)).toBe(4)
    })
  })
})
