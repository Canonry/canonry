import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createDemoSeedContext } from '../src/demo/types.js'
import { seedDemoSignals } from '../src/demo/seed-signals.js'
import { seedDemoMarketing } from '../src/demo/seed-marketing.js'
import { demoReadOptions } from '../src/demo/stores.js'

let tmpDir: string
let db: DatabaseClient
const context = createDemoSeedContext(new Date('2026-09-09T12:00:00.000Z'))

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-demo-marketing-'))
  db = createClient(path.join(tmpDir, 'demo.db'))
  migrate(db)
  for (const project of [context.simple, context.portfolio]) {
    db.insert(projects).values({ id: project.id, name: project.name, displayName: project.displayName, canonicalDomain: project.domain, country: 'US', language: 'en', createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() }).run()
  }
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('seedDemoMarketing', () => {
  it('makes stored Google Ads, GTM integrity, and GBP summary reads nonempty without live providers', async () => {
    await seedDemoSignals(db, context)
    seedDemoMarketing(db, context)
    const app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true, ...demoReadOptions(db, context) })
    await app.ready()
    try {
      const project = context.portfolio.name
      const ads = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/google-ads/performance?window=7d` })
      expect(ads.statusCode).toBe(200)
      expect(ads.json()).toMatchObject({ totals: { impressions: expect.any(Number), conversions: expect.any(Number) } })
      expect(ads.json<{ totals: { impressions: number } }>().totals.impressions).toBeGreaterThan(0)
      const adsStatus = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/google-ads/status` })
      expect(adsStatus.statusCode).toBe(200)
      expect(adsStatus.json()).toMatchObject({
        connected: true, status: 'connected', selectedCustomer: { customerId: 'demo-customer' },
      })
      const gtmStatus = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/gtm/status` })
      expect(gtmStatus.statusCode).toBe(200)
      expect(gtmStatus.json()).toMatchObject({ connected: true, status: 'connected' })
      const integrity = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/conversion-tracking/contracts/demo-signals-${context.portfolio.id}-conversion/integrity` })
      expect(integrity.statusCode).toBe(200)
      expect(integrity.json()).toMatchObject({ assessment: { status: 'runtime-unverified' }, googleAdsSnapshot: { kind: 'inventory' }, gtmSnapshot: { kind: 'container' } })
      const local = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/gbp/summary` })
      expect(local.statusCode).toBe(200)
      expect(local.json()).toMatchObject({ scope: { locationCount: 1 }, performance: { totals: { WEBSITE_CLICKS: expect.any(Number) } } })
    } finally {
      await app.close()
    }
  })
})
