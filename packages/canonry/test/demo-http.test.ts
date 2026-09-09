import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoHttpServer } from '../src/demo/http.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
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
  const app = await createDemoHttpServer({ db, assetsDir: dir, now })
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

  it('reports a demo with background execution disabled', async () => {
    const { app } = await fixture()
    expect((await app.inject('/health')).json()).toMatchObject({ status: 'ok', demo: true, workerEnabled: false })
    expect((await app.inject('/api/v1/demo')).json()).toMatchObject({ mode: 'view-only', sampleData: true })
  })
})
