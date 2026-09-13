import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoHttpServer } from '../src/demo/http.js'
import { PACKAGE_VERSION } from '../src/package-version.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

async function fixture(apiRateLimitMax?: number, network: { trustProxy?: readonly string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-http-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'window.demoLoaded=true')
  writeFileSync(join(dir, 'private.txt'), 'must-not-be-served')
  writeFileSync(join(dir, 'favicon.svg'), '<svg></svg>')
  const db = createClient(':memory:')
  migrate(db)
  const now = new Date('2026-09-09T12:00:00.000Z')
  db.insert(projects).values({ id: 'demo-simple', name: 'summit-roofing', displayName: 'Summit Roofing', canonicalDomain: 'summit-roofing.example', country: 'US', language: 'en', createdAt: now.toISOString(), updatedAt: now.toISOString() }).run()
  const app = await createDemoHttpServer({ db, assetsDir: dir, now, apiRateLimitMax, ...network })
  cleanups.push(async () => { await app.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, db }
}

describe('dedicated public demo server', () => {
  it('opens the actual viewer bootstrap and stored project list without credentials', async () => {
    const { app } = await fixture()
    const session = await app.inject('/api/v1/session')
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ authenticated: true, setupRequired: false })
    const key = await app.inject('/api/v1/keys/self')
    expect(key.statusCode).toBe(200)
    expect(key.json()).toMatchObject({ readOnly: true, scopes: ['read'] })
    expect(JSON.stringify(key.json())).not.toContain('keyHash')
    const result = await app.inject('/api/v1/projects')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual([expect.objectContaining({ name: 'summit-roofing' })])
  })

  it('rejects every write method, including setup, session, providers and runs', async () => {
    const { app, db } = await fixture()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/api/v1/projects', '/api/v1/projects/summit-roofing/runs', '/api/v1/session/setup', '/api/v1/auth/login', '/api/v1/settings/providers/openai', '/api/v1/keys']) {
        const response = await app.inject({ method, url, payload: {}, headers: { authorization: 'Bearer cnry_fake_admin' } })
        expect(response.statusCode, `${method} ${url}`).toBe(403)
        expect(response.json().error.code).toBe('DEMO_READ_ONLY')
      }
    }
    expect(db.select().from(projects).all()).toHaveLength(1)
  })

  it('refuses live GETs and unknown APIs before any provider access', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const { app } = await fixture()
    for (const url of ['/api/v1/projects/summit-roofing/ads/account', '/api/v1/projects/summit-roofing/ads/live-delivery', '/api/v1/projects/summit-roofing/google/gsc/sitemaps', '/api/v1/projects/summit-roofing/doctor', '/api/v1/keys', '/api/v1/settings', '/api/v1/future-feature', '/api/v1/mcp']) {
      expect((await app.inject(url)).statusCode, url).toBe(403)
    }
    expect(network).not.toHaveBeenCalled()
  })

  it('serves the public icon without exposing arbitrary package files', async () => {
    const { app } = await fixture()
    expect((await app.inject('/favicon.svg')).statusCode).toBe(200)
    expect((await app.inject('/private.txt')).statusCode).toBe(404)
  })

  it('reserves the rate limit for API reads and separates visitors behind a loopback proxy', async () => {
    const { app } = await fixture(2)
    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject('/assets/app.js')).statusCode).toBe(200)
    }
    const firstVisitor = { 'x-forwarded-for': '198.51.100.10' }
    expect((await app.inject({ url: '/api/v1/projects', headers: firstVisitor })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/projects', headers: firstVisitor })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/projects', headers: firstVisitor })).statusCode).toBe(429)
    expect((await app.inject({
      url: '/api/v1/projects',
      headers: { 'x-forwarded-for': '198.51.100.11' },
    })).statusCode).toBe(200)
  })

  it('ignores forwarded caller headers from a non-loopback peer', async () => {
    const { app } = await fixture(1)
    expect((await app.inject({
      url: '/api/v1/projects',
      remoteAddress: '203.0.113.20',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    })).statusCode).toBe(200)
    expect((await app.inject({
      url: '/api/v1/projects',
      remoteAddress: '203.0.113.20',
      headers: { 'x-forwarded-for': '198.51.100.21' },
    })).statusCode).toBe(429)
  })

  it('trusts forwarded visitor addresses only from the configured proxies', async () => {
    const { app } = await fixture(1, { trustProxy: ['10.0.0.0/24'] })
    const viaProxy = (visitor: string) => ({ url: '/api/v1/projects', remoteAddress: '10.0.0.5', headers: { 'x-forwarded-for': visitor } })
    expect((await app.inject(viaProxy('198.51.100.30'))).statusCode).toBe(200)
    expect((await app.inject(viaProxy('198.51.100.31'))).statusCode).toBe(200)
    expect((await app.inject(viaProxy('198.51.100.30'))).statusCode).toBe(429)
    // Naming a proxy replaces the loopback default, so a local caller cannot claim a visitor address.
    const viaLoopback = (visitor: string) => ({ url: '/api/v1/projects', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': visitor } })
    expect((await app.inject(viaLoopback('198.51.100.32'))).statusCode).toBe(200)
    expect((await app.inject(viaLoopback('198.51.100.33'))).statusCode).toBe(429)
  })

  it('labels synthetic data, supports deep links and serves only built public assets', async () => {
    const { app } = await fixture()
    for (const url of ['/', '/projects/summit-roofing', '/projects/summit-roofing/technical-aeo']) {
      const response = await app.inject(url)
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('"demo":{"enabled":true,"readOnly":true,"sampleData":true}')
      expect(response.body).toContain('<base href="/">')
      expect(response.headers['x-robots-tag']).toContain('noindex')
      expect(response.headers['content-security-policy']).toContain("connect-src 'self'")
    }
    expect((await app.inject('/assets/app.js')).body).toContain('demoLoaded')
    for (const url of ['/private.txt', '/.env', '/.git/config', '/assets/../private.txt', '/api/v1/unknown']) {
      const response = await app.inject(url)
      expect(response.statusCode).toBeGreaterThanOrEqual(400)
      expect(response.body).not.toContain('must-not-be-served')
    }
  })

  it('does not serve the backlink admin page the demo hides from navigation', async () => {
    const { app } = await fixture()
    const admin = await app.inject('/backlinks')
    expect(admin.statusCode).toBe(404)
    expect(admin.body).not.toContain('"demo":{"enabled":true')
    expect((await app.inject('/backlinks/')).statusCode).toBe(404)
    // The project's stored backlink evidence stays a demo page.
    expect((await app.inject('/projects/summit-roofing/backlinks')).statusCode).toBe(200)
  })

  it('reports a demo with background execution disabled', async () => {
    const { app } = await fixture()
    const health = (await app.inject('/health')).json()
    expect(health).toMatchObject({ status: 'ok', service: 'canonry-demo', demo: true, workerEnabled: false })
    expect(health.version).toBe(PACKAGE_VERSION)
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/)
    expect((await app.inject('/api/v1/demo')).json()).toMatchObject({ mode: 'view-only', sampleData: true })
  })
})

describe('public demo API budget', () => {
  const visitor = (octet: number) => ({ 'x-forwarded-for': `198.51.100.${octet}` })

  it.each([
    '/api/v1/projects',
    '/%61pi/v1/projects',
    '/api/v1/%70rojects',
    '/api/v1/projects?view=all',
    '/%61pi/v1/projects?view=%61',
  ])('throttles %s on the API route the router reaches', async url => {
    const { app } = await fixture(2)
    const responses = []
    for (let index = 0; index < 3; index += 1) responses.push(await app.inject({ url, headers: visitor(30) }))
    expect(responses.map(response => response.statusCode)).toEqual([200, 200, 429])
    expect(responses[0]!.json()).toEqual([expect.objectContaining({ name: 'summit-roofing' })])
  })

  it('charges plain, encoded and HEAD spellings of one API read to a single visitor budget', async () => {
    const { app } = await fixture(4)
    const sequence = [
      { method: 'GET', url: '/api/v1/projects' },
      { method: 'GET', url: '/%61pi/v1/projects' },
      { method: 'HEAD', url: '/api/v1/projects' },
      { method: 'GET', url: '/%61pi/v1/%70rojects?view=all' },
      { method: 'GET', url: '/%61pi/v1/projects' },
      { method: 'HEAD', url: '/api/v1/projects' },
    ] as const
    const responses = []
    for (const request of sequence) responses.push(await app.inject({ ...request, headers: visitor(31) }))
    expect(responses.map(response => response.statusCode)).toEqual([200, 200, 200, 200, 429, 429])
    expect(responses.slice(0, 4).map(response => response.headers['x-ratelimit-remaining'])).toEqual(['3', '2', '1', '0'])
    // The budget is per visitor, not per spelling or global.
    expect((await app.inject({ url: '/%61pi/v1/projects', headers: visitor(32) })).statusCode).toBe(200)
  })

  it('throttles HEAD requests to API routes', async () => {
    const { app } = await fixture(2)
    const statuses = []
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await app.inject({ method: 'HEAD', url: '/api/v1/projects', headers: visitor(33) })).statusCode)
    }
    expect(statuses).toEqual([200, 200, 429])
  })

  it.each([
    '/%2561pi/v1/projects',
    '//api/v1/projects',
    '/API/v1/projects',
    '/api/v1/projects/',
    '/%61pi/v1/unknown',
    '/%61pi/v1/keys',
    '/%70rojects/summit-roofing',
    '/private.txt',
  ])('charges %s to the same budget without opening an API read', async url => {
    const { app } = await fixture(2)
    const headers = visitor(34)
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ url, headers })
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400)
      expect(response.statusCode, url).not.toBe(429)
      expect(response.body, url).not.toContain('summit-roofing.example')
    }
    expect((await app.inject({ url, headers })).statusCode, url).toBe(429)
    expect((await app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(429)
  })

  it('charges refused writes before refusing them', async () => {
    const { app } = await fixture(2)
    const headers = visitor(35)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', payload: {}, headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/%61pi/v1/projects/summit-roofing', headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', payload: {}, headers })).statusCode).toBe(429)
  })

  it('keeps the dashboard document, deep links, icons and built assets outside the API budget', async () => {
    const { app } = await fixture(2)
    const headers = visitor(36)
    for (let index = 0; index < 5; index += 1) {
      for (const url of ['/', '/projects/summit-roofing', '/projects/summit-roofing/technical-aeo', '/runs', '/assets/app.js', '/favicon.svg', '/health', '/robots.txt']) {
        for (const method of ['GET', 'HEAD'] as const) {
          expect((await app.inject({ method, url, headers })).statusCode, `${method} ${url}`).toBe(200)
        }
      }
    }
    expect((await app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/%61pi/v1/projects', headers })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(429)
  })
})
