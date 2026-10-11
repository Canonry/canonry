import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

const metrics = ['7d', '30d', '90d', 'all']
const cases: Array<[string, string, string[]]> = [
  ['ga/acquisition', 'window', metrics], ['ga/traffic', 'window', metrics], ['google/gsc/performance', 'window', metrics],
  ['analytics/competitors', 'window', metrics],
  ['ga/search-landing-pages', 'window', ['7d', '28d', '90d']],
  ['ga/measurement-analysis', 'window', ['30d', '60d', '90d']],
  ['google-ads/performance', 'window', ['7d', '14d', '30d']],
  ['traffic/analytics', 'period', ['7d', '14d', '30d', '90d']],
  ['organic-evidence', 'period', ['60d', '90d']],
]

describe('stored API window errors', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  beforeEach(async () => {
    db = createClient(':memory:'); migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.test', country: 'US', language: 'en', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }).run()
    app = Fastify(); await app.register(apiRoutes, { db, skipAuth: true, googleStateSecret: 'synthetic-window-test-secret', ga4CredentialStore: { getConnection: () => ({ projectName: 'example', propertyId: '123456', clientEmail: 'synthetic@example.test', privateKey: 'synthetic-key', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }), upsertConnection: value => value, deleteConnection: () => false } }); await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })
  it.each(cases)('%s names exactly the stored windows it supports', async (path, field, allowed) => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/example/${path}?${field}=29d` })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Invalid window "29d". Must be one of: ' + allowed.join(', ') + '.', details: { field, value: '29d', allowed } } })
  })
})
