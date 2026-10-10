import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { WordpressApiError, type WordpressConnectionRecord } from '@ainyc/canonry-integration-wordpress'
import { apiRoutes, type OutcomeTelemetryEvent } from '../src/index.js'
import { EgressRefusedError } from '../src/guarded-fetch.js'
import { featureOutcomes } from './feature-outcome-capture.js'

// What each WordPress write reports through `feature.completed`. The routes'
// responses are covered in wordpress.test.ts; the client calls are stubbed.

let app: FastifyInstance
let tmpDir: string
let outcomes: OutcomeTelemetryEvent[]
const connections = new Map<string, WordpressConnectionRecord>()

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-outcomes-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(), name: 'test-project', displayName: 'Test Project', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  connections.clear()
  outcomes = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    wordpressConnectionStore: {
      getConnection: name => connections.get(name),
      upsertConnection: connection => { connections.set(connection.projectName, connection); return connection },
      updateConnection: () => undefined,
      deleteConnection: name => connections.delete(name),
    },
    onOutcome: event => { outcomes.push(event) },
  })
  await app.ready()
  // The onboard URL check stays real without resolving the fixture host.
  vi.spyOn(dns, 'resolve4').mockImplementation(async hostname => (hostname === 'example.com' ? ['93.184.216.34'] : []))
  vi.spyOn(dns, 'resolve6').mockResolvedValue([])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function connect(extra: Partial<WordpressConnectionRecord> = {}) {
  const now = new Date().toISOString()
  connections.set('test-project', {
    projectName: 'test-project', url: 'https://example.com', username: 'admin', appPassword: 'app-pass',
    defaultEnv: 'live', createdAt: now, updatedAt: now, ...extra,
  })
}

const reported = (operation: string) => ({ feature: 'wordpress', operation, durationBucket: expect.any(String) })
const post = (url: string, payload: object = {}, method: 'POST' | 'PUT' = 'POST') =>
  app.inject({ method, url: `/api/v1/projects/test-project/wordpress${url}`, payload })
const PAGE = { id: 7, slug: 'pricing', title: 'Pricing', status: 'draft', link: 'https://example.com/pricing/' }

describe('WordPress write outcomes', () => {
  it('reports page publishes: written, refused without a connection, and refused credentials', async () => {
    const wordpress = await import('@ainyc/canonry-integration-wordpress')
    const pageBody = { title: 'Pricing', slug: 'pricing', content: '<p>Plans</p>' }
    expect((await post('/pages', pageBody)).statusCode).toBe(400)
    connect()
    vi.spyOn(wordpress, 'createPage').mockResolvedValue(PAGE as never)
    expect((await post('/pages', pageBody)).statusCode).toBe(200)
    vi.spyOn(wordpress, 'updatePageBySlug').mockRejectedValue(new WordpressApiError('AUTH_INVALID', 'Authentication failed for admin@example.com', 401))
    expect((await post('/page', { currentSlug: 'pricing', title: 'Plans' }, 'PUT')).statusCode).toBe(401)

    expect(featureOutcomes(outcomes)).toEqual([
      { ...reported('publish'), status: 'failed', reasonCode: 'NOT_CONNECTED' },
      { ...reported('publish'), status: 'succeeded', counts: { items: 1 } },
      { ...reported('publish'), status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'WordpressApiError' },
    ])
    expect(JSON.stringify(outcomes)).not.toContain('admin@example.com')
  })

  it('reports SEO meta writes by entries applied, left as manual steps, and errored', async () => {
    const wordpress = await import('@ainyc/canonry-integration-wordpress')
    connect()
    const bulk = vi.spyOn(wordpress, 'bulkSetSeoMeta')
    const entries = { entries: [{ slug: 'home', title: 'Home' }, { slug: 'about', title: 'About' }] }
    bulk.mockResolvedValueOnce({ env: 'live', strategy: 'plugin', results: [{ slug: 'home', status: 'applied' }, { slug: 'about', status: 'manual' }] })
    await post('/pages/meta/bulk', entries)
    bulk.mockResolvedValueOnce({ env: 'live', strategy: 'manual', results: [{ slug: 'home', status: 'manual' }, { slug: 'about', status: 'manual' }] })
    await post('/pages/meta/bulk', entries)
    bulk.mockResolvedValueOnce({ env: 'live', strategy: 'plugin', results: [{ slug: 'home', status: 'skipped', error: 'Page "home" not found' }, { slug: 'about', status: 'skipped', error: 'HTTP 500' }] })
    await post('/pages/meta/bulk', entries)
    vi.spyOn(wordpress, 'setSeoMeta').mockRejectedValue(new WordpressApiError('UNSUPPORTED', 'No writable SEO meta fields', 400))
    expect((await post('/page/meta', { slug: 'home', title: 'Home' })).statusCode).toBe(400)

    expect(featureOutcomes(outcomes)).toEqual([
      { ...reported('meta_write'), status: 'partial', reasonCode: 'UNSUPPORTED', counts: { items: 1, skipped: 1, failures: 0 } },
      { ...reported('meta_write'), status: 'skipped', reasonCode: 'UNSUPPORTED', counts: { items: 0, skipped: 2, failures: 0 } },
      { ...reported('meta_write'), status: 'failed', reasonCode: 'UNKNOWN', counts: { items: 0, skipped: 0, failures: 2 } },
      { ...reported('meta_write'), status: 'failed', reasonCode: 'UNSUPPORTED', errorName: 'WordpressApiError' },
    ])
  })

  it('reports schema deploys by pages deployed, stripped or missing, and manual-only writes as skipped', async () => {
    const wordpress = await import('@ainyc/canonry-integration-wordpress')
    connect({ stagingUrl: 'https://staging.example.com' })
    const deploy = vi.spyOn(wordpress, 'deploySchemaFromProfile')
    deploy.mockResolvedValueOnce({
      env: 'live',
      results: [
        { slug: 'home', status: 'deployed', schemasInjected: ['Organization'] },
        { slug: 'about', status: 'stripped', schemasInjected: ['FAQPage'] },
        { slug: 'gone', status: 'skipped', error: 'Page "gone" not found' },
      ],
    })
    deploy.mockRejectedValueOnce(new EgressRefusedError('"url" resolves to 10.0.0.8', false))
    const profile = { profile: { business: { name: 'Example Co' }, pages: { home: ['Organization'] } } }
    await post('/schema/deploy', profile)
    expect((await post('/schema/deploy', profile)).statusCode).toBe(400)

    const manual = { manualRequired: true as const, targetUrl: 'https://example.com/x', adminUrl: 'https://example.com/wp-admin/', content: '{}', nextSteps: [] }
    vi.spyOn(wordpress, 'buildManualSchemaUpdate').mockResolvedValue(manual)
    vi.spyOn(wordpress, 'buildManualLlmsTxtUpdate').mockResolvedValue(manual)
    vi.spyOn(wordpress, 'buildManualStagingPush').mockResolvedValue(manual)
    await post('/schema/manual', { slug: 'home', json: '{}' })
    await post('/llms-txt/manual', { content: '# Example' })
    await post('/staging/push')

    expect(featureOutcomes(outcomes)).toEqual([
      // WordPress strips script tags for a user without unfiltered_html.
      { ...reported('schema_deploy'), status: 'partial', reasonCode: 'PERMISSION_MISSING', counts: { items: 1, skipped: 2, failures: 0 } },
      { ...reported('schema_deploy'), status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL', errorName: 'EgressRefusedError' },
      { ...reported('schema_deploy'), status: 'skipped', reasonCode: 'UNSUPPORTED' },
      { ...reported('llms_txt'), status: 'skipped', reasonCode: 'UNSUPPORTED' },
      { ...reported('publish'), status: 'skipped', reasonCode: 'UNSUPPORTED' },
    ])
    expect(JSON.stringify(outcomes)).not.toContain('10.0.0.8')
  })

  it('reports the onboard meta and schema steps as the writes they are', async () => {
    const wordpress = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpress, 'verifyWordpressConnection').mockResolvedValue({
      url: 'https://example.com', reachable: true, pageCount: 1, version: '6.8.1', plugins: [], authenticatedUser: { id: 1, slug: 'admin' },
    })
    vi.spyOn(wordpress, 'runAudit').mockResolvedValue({
      env: 'live',
      pages: [{ slug: 'about', title: 'About', status: 'publish', wordCount: 300, seo: { title: null, description: null, noindex: false, writable: true, writeTargets: [] }, schemaPresent: false, issues: [] }],
      issues: [{ slug: 'about', severity: 'medium', code: 'missing-seo-title', message: 'Missing title' }],
    })
    vi.spyOn(wordpress, 'listPages').mockResolvedValue([])
    vi.spyOn(wordpress, 'bulkSetSeoMeta').mockResolvedValue({ env: 'live', strategy: 'plugin', results: [{ slug: 'about', status: 'applied' }] })
    vi.spyOn(wordpress, 'deploySchemaFromProfile').mockResolvedValue({ env: 'live', results: [{ slug: 'about', status: 'deployed', schemasInjected: ['Organization'] }] })

    const res = await post('/onboard', {
      url: 'https://example.com', username: 'admin', appPassword: 'app-pass', skipSubmit: true,
      profile: { business: { name: 'Example Co' }, pages: { about: ['Organization'] } },
    })
    expect(res.statusCode).toBe(200)
    expect(featureOutcomes(outcomes)).toEqual([
      { ...reported('meta_write'), status: 'succeeded', counts: { items: 1, skipped: 0, failures: 0 } },
      { ...reported('schema_deploy'), status: 'succeeded', counts: { items: 1, skipped: 0, failures: 0 } },
    ])
  })
})
