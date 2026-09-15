import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, gaDailyTotals, gscDailyTotals } from '@ainyc/canonry-db'
import {
  DATA_FRESHNESS_CHECKS,
  daysSinceDate,
  GA_DATA_AGING_DAYS,
  GA_DATA_STALE_DAYS,
  GSC_DATA_AGING_DAYS,
  GSC_DATA_STALE_DAYS,
} from '../src/doctor/checks/data-freshness.js'
import type { CheckDefinition, DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

// The auth checks prove a token works. They cannot see a sync that succeeds and
// returns nothing, which is how a client's GA4 went silent for two weeks with
// every check green. These pin that the newest stored date is what gets graded.

const byId = (id: string): CheckDefinition => {
  const found = DATA_FRESHNESS_CHECKS.find(check => check.id === id)
  if (!found) throw new Error(`no check ${id}`)
  return found
}
const gaCheck = byId('ga.data.recent-data')
const gscCheck = byId('gsc.data.recent-data')

const dayMs = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * dayMs).toISOString().slice(0, 10)

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
  let otherProjectId: string

  const insertProject = (name: string, domain: string) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: domain, country: 'US', language: 'en',
      providers: [], createdAt: now, updatedAt: now,
    } as typeof projects.$inferInsert).run()
    return id
  }
  const ga = (projectId: string, date: string) => {
    const now = new Date().toISOString()
    db.insert(gaDailyTotals).values({ id: crypto.randomUUID(), projectId, date, sessions: 3, users: 3, syncedAt: now, createdAt: now }).run()
  }
  const gsc = (projectId: string, date: string) => {
    db.insert(gscDailyTotals).values({ id: crypto.randomUUID(), projectId, date, clicks: 0, impressions: 4, position: '12.5', createdAt: new Date().toISOString() }).run()
  }
  const ctx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({ db, project, ...overrides })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-freshness-'))
    db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    const id = insertProject('client', 'client.example')
    project = { id, name: 'client', canonicalDomain: 'client.example', displayName: 'client' }
    otherProjectId = insertProject('other', 'other.example')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  describe('ga.data.recent-data', () => {
    it('skips when no GA4 credential store exists in this deployment', async () => {
      expect(await gaCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'ga.data.store-unavailable' })
    })

    it('skips a project that never connected GA4, so an unused source never pages', async () => {
      ga(project.id, daysAgo(30))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))).toMatchObject({ status: 'skipped', code: 'ga.data.not-connected' })
    })

    it('warns when connected but nothing has been stored yet', async () => {
      const result = await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))
      expect(result).toMatchObject({ status: 'warn', code: 'ga.data.never-synced' })
      expect(result.remediation).toContain('canonry ga sync client')
    })

    it('is fresh when yesterday arrived', async () => {
      ga(project.id, daysAgo(1))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ status: 'ok', code: 'ga.data.fresh' })
    })

    it('stays fresh one day short of the aging limit', async () => {
      ga(project.id, daysAgo(GA_DATA_AGING_DAYS - 1))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ status: 'ok' })
    })

    it('warns at the aging limit and names the tag as the likely cause', async () => {
      ga(project.id, daysAgo(GA_DATA_AGING_DAYS))
      const result = await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))
      expect(result).toMatchObject({ status: 'warn', code: 'ga.data.aging', details: { ageDays: GA_DATA_AGING_DAYS } })
      expect(result.remediation).toMatch(/tag/i)
    })

    it('fails at the stale limit', async () => {
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ status: 'fail', code: 'ga.data.stale' })
    })

    it('grades the newest date, not the oldest', async () => {
      ga(project.id, daysAgo(40))
      ga(project.id, daysAgo(1))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ code: 'ga.data.fresh' })
    })

    it('counts a service-account GA4 connection as connected', async () => {
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS + 2))
      const ga4CredentialStore = { getConnection: (name: string) => (name === 'client' ? ({ propertyId: '1' } as never) : undefined) } as unknown as DoctorContext['ga4CredentialStore']
      expect(await gaCheck.run(ctx({ ga4CredentialStore }))).toMatchObject({ status: 'fail', code: 'ga.data.stale' })
    })

    it("never lets another project's fresh data mask this project's silence", async () => {
      ga(otherProjectId, daysAgo(0))
      ga(project.id, daysAgo(GA_DATA_STALE_DAYS + 9))
      expect(await gaCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ code: 'ga.data.stale' })
    })
  })

  describe('gsc.data.recent-data', () => {
    it('skips when Search Console is not connected', async () => {
      gsc(project.id, daysAgo(30))
      expect(await gscCheck.run(ctx({ googleConnectionStore: store(['ga4']) }))).toMatchObject({ status: 'skipped', code: 'gsc.data.not-connected' })
    })

    it('treats the normal two-to-three day lag as fresh', async () => {
      gsc(project.id, daysAgo(3))
      expect(await gscCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))).toMatchObject({ status: 'ok', code: 'gsc.data.fresh' })
    })

    it('warns at the aging limit and fails at the stale limit', async () => {
      gsc(project.id, daysAgo(GSC_DATA_AGING_DAYS))
      expect(await gscCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))).toMatchObject({ status: 'warn', code: 'gsc.data.aging' })
      gsc(project.id, daysAgo(GSC_DATA_STALE_DAYS + 1))
      // The newer aging row still wins; staleness needs the newest row to be old.
      expect(await gscCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))).toMatchObject({ code: 'gsc.data.aging' })
    })

    it('fails when even the newest row is past the stale limit', async () => {
      gsc(project.id, daysAgo(GSC_DATA_STALE_DAYS))
      const result = await gscCheck.run(ctx({ googleConnectionStore: store(['gsc']) }))
      expect(result).toMatchObject({ status: 'fail', code: 'gsc.data.stale' })
      expect(result.remediation).toContain('canonry google sync client')
    })
  })

  describe('daysSinceDate', () => {
    it('counts whole UTC calendar days', () => {
      const now = new Date('2026-09-15T23:59:00.000Z')
      expect(daysSinceDate('2026-09-15', now)).toBe(0)
      expect(daysSinceDate('2026-09-14', now)).toBe(1)
      expect(daysSinceDate('2026-09-01', now)).toBe(14)
    })

    it('refuses anything that is not a calendar date', () => {
      expect(daysSinceDate('2026-09-15T00:00:00Z')).toBeNull()
      expect(daysSinceDate('yesterday')).toBeNull()
    })
  })
})
