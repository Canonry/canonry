import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects, gaAcquisitionDaily, gaMeasurementSyncStates, apiKeys, measurementPlans, measurementPlanVersions } from '@canonry/canonry-db'
import { canonicalMeasurementPlanV2Json } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const date = '2026-10-01T12:00:00.000Z'
const url = '/api/v1/projects/example/ga/acquisition?startDate=2026-09-01&endDate=2026-09-30'

describe('stored GA acquisition', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  function row(id: string, sessions: number, overrides: Partial<typeof gaAcquisitionDaily.$inferInsert> = {}) {
    db.insert(gaAcquisitionDaily).values({ id, projectId: 'project', date: '2026-09-10', channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: 'EXAMPLE.com', landingPage: `/pricing?utm_source=${id}`, landingPageNormalized: '/pricing', sessions, syncedAt: date, createdAt: date, ...overrides }).run()
  }
  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    for (const name of ['example', 'other']) db.insert(projects).values({ id: name === 'example' ? 'project' : 'other', name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('preserves normalized page identity while merging tracking variants and conserving totals across every grouping and page', async () => {
    row('a', 7)
    row('b', 11)
    row('query', 5, { landingPage: '/pricing?plan=team', landingPageNormalized: '/pricing?plan=team' })
    row('next-day', 3, { date: '2026-09-11' })
    row('direct', 2, { channelGroup: 'Direct', source: '(direct)', medium: '(none)' })
    row('outside', 100, { date: '2026-10-01' })
    row('foreign', 200, { projectId: 'other' })
    const response = await app.inject({ method: 'GET', url: `${url}&limit=2` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ source: 'ga4-acquisition', scope: { project: 'example', attribution: 'project-only', unavailableDimensions: ['property', 'target', 'market'] }, totalSessions: 28, totalRows: 4, limit: 2, offset: 0, coverage: { earliestDate: '2026-09-10', latestDate: '2026-10-01' } })
    expect(body.rows).toEqual([
      { date: '2026-09-11', channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: 'EXAMPLE.com', landingPage: '/pricing', sessions: 3 },
      { date: '2026-09-10', channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: 'EXAMPLE.com', landingPage: '/pricing', sessions: 18 },
    ])
    const second = (await app.inject({ method: 'GET', url: `${url}&limit=2&offset=2` })).json()
    expect(second.rows.map((value: { sessions: number }) => value.sessions)).toEqual([5, 2])
    expect([...body.rows, ...second.rows].reduce((sum, value) => sum + value.sessions, 0)).toBe(body.totalSessions)
    const keys = ['date', 'channelGroup', 'source', 'medium', 'hostName', 'landingPage']
    for (let bits = 1; bits < 64; bits++) {
      const selected = keys.filter((_, index) => bits & (1 << index))
      const grouped = (await app.inject({ method: 'GET', url: `${url}&groupBy=${selected.join(',')}` })).json()
      expect(grouped.totalSessions, selected.join(',')).toBe(28)
      expect(grouped.rows.reduce((sum: number, value: { sessions: number }) => sum + value.sessions, 0)).toBe(28)
      expect(Object.keys(grouped.rows[0]).sort()).toEqual([...selected, 'sessions'].sort())
    }
    expect((await app.inject({ method: 'GET', url: `${url}&groupBy=source,medium` })).json().rows).toEqual([{ source: 'google', medium: 'organic', sessions: 26 }, { source: '(direct)', medium: '(none)', sessions: 2 }])
  })

  it('combines exact source, medium, case-insensitive host/channel and normalized page filters', async () => {
    row('a', 7)
    row('b', 11)
    row('query', 5, { landingPage: '/pricing?plan=team', landingPageNormalized: '/pricing?plan=team' })
    row('other-source', 9, { source: 'search.example' })
    const filtered = (await app.inject({ method: 'GET', url: `${url}&channel=organic%20search&hostName=example.COM&source=google&medium=organic&landingPage=%2Fpricing` })).json()
    expect(filtered.totalSessions).toBe(18)
    expect(filtered.totalRows).toBe(1)
    const typo = (await app.inject({ method: 'GET', url: `${url}&channel=Organic%20Seach` })).json()
    expect(typo).toMatchObject({ totalSessions: 0, totalRows: 0, rows: [], channelGroups: ['Organic Search'] })
  })

  it('normalizes the requested landing page with the same rules used for stored rows', async () => {
    row('contact', 22, { landingPage: '/contact/', landingPageNormalized: '/contact' })
    row('root', 7, { landingPage: '/?gtm_latency=1', landingPageNormalized: '/' })
    row('query', 5, { landingPage: '/contact/?plan=team', landingPageNormalized: '/contact?plan=team' })
    for (const [page, normalized, sessions] of [['/contact/', '/contact', 22], ['/?gtm_latency=1', '/', 7], ['/contact/?plan=team&utm_source=qa', '/contact?plan=team', 5]] as const) {
      const response = await app.inject(`${url}&landingPage=${encodeURIComponent(page)}`)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ totalSessions: sessions, filters: { landingPage: normalized } })
    }
  })

  it('matches boundary-safe literal path prefixes, including percent, underscore, and meaningful queries', async () => {
    row('root', 1, { landingPageNormalized: '/offers%_x' })
    row('child', 2, { landingPageNormalized: '/offers%_x/detail?plan=team' })
    row('prefix-neighbor', 4, { landingPageNormalized: '/offers%_xyz' })
    row('wildcard-neighbor', 8, { landingPageNormalized: '/offersABx/detail' })
    row('query', 16, { landingPageNormalized: '/offers%_x?plan=team' })
    const result = (await app.inject({ method: 'GET', url: `${url}&pathPrefix=${encodeURIComponent('/offers%_x/')}` })).json()
    expect(result.totalSessions).toBe(19)
    expect(result.totalRows).toBe(3)
  })

  it('reports never-synced without a connection and retains stored rows and errors after a failed sync', async () => {
    const empty = await app.inject({ method: 'GET', url })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toMatchObject({ status: 'never-synced', error: null, syncedAt: null, totalSessions: 0, totalRows: 0, limit: 100, rows: [], coverage: { earliestDate: null, latestDate: null } })
    row('a', 7)
    db.insert(gaMeasurementSyncStates).values({ projectId: 'project', acquisitionStatus: 'error', acquisitionError: 'Synthetic provider failure', acquisitionSyncedAt: date, updatedAt: date }).run()
    expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ status: 'error', error: 'Synthetic provider failure', syncedAt: date, totalSessions: 7, totalRows: 1 })
  })

  it.each(['groupBy=unknown', 'limit=1001', 'offset=-1', 'window=13d', 'startDate=2026-10-01', 'startDate=not-a-date'])('rejects invalid selection %s', async invalid => {
    const query = new URLSearchParams(url.split('?')[1])
    new URLSearchParams(invalid).forEach((value, key) => query.set(key, value))
    const result = await app.inject({ method: 'GET', url: `/api/v1/projects/example/ga/acquisition?${query}` })
    expect(result.statusCode).toBe(400)
    expect(result.json().error.code).toBe('VALIDATION_ERROR')
    expect(result.json().error.message).not.toMatch(/\n|^\[/)
  })

  it('uses all-history defaults and refuses ambiguous dates plus a rolling window', async () => {
    row('a', 7, { date: '2025-01-01' })
    row('b', 11)
    const all = (await app.inject({ method: 'GET', url: '/api/v1/projects/example/ga/acquisition' })).json()
    expect(all).toMatchObject({ totalSessions: 18, window: { window: 'all', startDate: null, endDate: null } })
    expect((await app.inject({ method: 'GET', url: `${url}&window=7d` })).statusCode).toBe(400)
  })

  it('keeps project-only scope for Advanced projects and leaves measurement-analysis unchanged', async () => {
    row('a', 7)
    const baseline = (await app.inject({ method: 'GET', url: '/api/v1/projects/example/ga/measurement-analysis?window=30d' })).body
    const response = await app.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(200)
    const simple = response.json()
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/example/ga/measurement-analysis?window=30d' })).body).toBe(baseline)
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'version', projectId: 'project', revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: date }).run()
    db.insert(measurementPlans).values({ projectId: 'project', activeVersionId: 'version', createdAt: date, updatedAt: date }).run()
    expect((await app.inject({ method: 'GET', url })).json()).toEqual(simple)
  })

  it('allows a real read key and rejects a key scoped to another project', async () => {
    for (const [id, projectId] of [['read', null], ['scoped', 'other']] as const) db.insert(apiKeys).values({ id, name: id, keyHash: hashApiKey(`cnry_acquisition_${id}`), keyPrefix: 'cnry_', scopes: ['read'], projectId, createdAt: date }).run()
    const secured = Fastify()
    await secured.register(apiRoutes, { db })
    await secured.ready()
    try {
      expect((await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_acquisition_read' } })).statusCode).toBe(200)
      expect((await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_acquisition_scoped' } })).statusCode).toBe(403)
    } finally { await secured.close() }
  })
})
