import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })

  return { app, db, tmpDir, dbPath }
}

describe('api-routes', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  before(async () => {
    const ctx = buildApp()
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  after(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('PUT /api/v1/projects/:name creates a project', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'My Site',
        canonicalDomain: 'example.com',
        ownedDomains: ['docs.example.com'],
        country: 'US',
        language: 'en',
      },
    })
    assert.equal(res.statusCode, 201)
    const body = JSON.parse(res.payload)
    assert.equal(body.name, 'my-site')
    assert.equal(body.displayName, 'My Site')
    assert.equal(body.canonicalDomain, 'example.com')
    assert.deepEqual(body.ownedDomains, ['docs.example.com'])
  })

  it('GET /api/v1/projects lists projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert(Array.isArray(body))
    assert.equal(body.length, 1)
    assert.equal(body[0].name, 'my-site')
    assert.deepEqual(body[0].ownedDomains, ['docs.example.com'])
  })

  it('GET /api/v1/openapi.json returns the API spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] ?? '', /application\/json/)

    const body = JSON.parse(res.payload) as {
      openapi: string
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }

    assert.equal(body.openapi, '3.1.0')
    assert.ok(body.paths['/api/v1/openapi.json'])
    assert.ok(body.paths['/api/v1/projects'])
    assert.deepEqual(body.paths['/api/v1/openapi.json']?.get?.security, [])
  })

  it('GET /api/v1/projects/:name gets a single project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.name, 'my-site')
    assert.deepEqual(body.ownedDomains, ['docs.example.com'])
  })

  it('GET /api/v1/projects/:name returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nope' })
    assert.equal(res.statusCode, 404)
  })

  it('PUT /api/v1/projects/:name/keywords sets keywords', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools', 'answer engine'] },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.length, 2)
  })

  it('DELETE /api/v1/projects/:name/keywords removes specific keywords', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools'] },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.length, 1)
    assert.equal(body[0].keyword, 'answer engine')
  })

  it('DELETE /api/v1/projects/:name/keywords ignores non-existent keywords', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['does not exist'] },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.length, 1)
  })

  it('DELETE /api/v1/projects/:name/keywords rejects empty array', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: [] },
    })
    assert.equal(res.statusCode, 400)
  })

  // Re-add keywords for subsequent tests
  it('POST /api/v1/projects/:name/keywords re-adds keywords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools'] },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.length, 2)
  })

  it('POST /api/v1/projects/:name/runs triggers a run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/runs',
      payload: {},
    })
    assert.equal(res.statusCode, 201)
    const body = JSON.parse(res.payload)
    assert.equal(body.status, 'queued')
    assert.equal(body.kind, 'answer-visibility')
  })

  it('POST /api/v1/projects/:name/runs rejects duplicate active run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/runs',
      payload: {},
    })
    assert.equal(res.statusCode, 409)
  })

  it('GET /api/v1/projects/:name/history returns audit log', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/history' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert(Array.isArray(body))
    assert(body.length > 0)
  })

  it('PUT /api/v1/projects/:name updates project settings', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        ownedDomains: ['docs.updated.com', 'blog.updated.com'],
        country: 'GB',
        language: 'en-gb',
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.name, 'my-site')
    assert.equal(body.displayName, 'Updated Site')
    assert.equal(body.canonicalDomain, 'updated.com')
    assert.deepEqual(body.ownedDomains, ['docs.updated.com', 'blog.updated.com'])
    assert.equal(body.country, 'GB')
    assert.equal(body.language, 'en-gb')

    // Verify GET returns updated values
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    assert.equal(getRes.statusCode, 200)
    const getBody = JSON.parse(getRes.payload)
    assert.equal(getBody.displayName, 'Updated Site')
    assert.equal(getBody.canonicalDomain, 'updated.com')
    assert.deepEqual(getBody.ownedDomains, ['docs.updated.com', 'blog.updated.com'])
    assert.equal(getBody.country, 'GB')
    assert.equal(getBody.language, 'en-gb')
  })

  it('PUT /api/v1/projects/:name with empty ownedDomains clears them', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        ownedDomains: [],
        country: 'GB',
        language: 'en-gb',
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.deepEqual(body.ownedDomains, [])
  })

  it('PUT /api/v1/projects/:name without ownedDomains defaults to empty', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        country: 'GB',
        language: 'en-gb',
      },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.deepEqual(body.ownedDomains, [])
  })

  it('PUT /api/v1/projects/:name rejects ownedDomains with empty string elements', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'My Site',
        canonicalDomain: 'example.com',
        ownedDomains: ['docs.example.com', ''],
        country: 'US',
        language: 'en',
      },
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/v1/projects/:name preserves tags and providers when included', async () => {
    // Seed a project with tags and providers
    const createRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/metadata-test',
      payload: {
        displayName: 'Metadata Test',
        canonicalDomain: 'meta.example.com',
        country: 'US',
        language: 'en',
        tags: ['seo', 'ai'],
        providers: ['gemini', 'openai'],
      },
    })
    assert.equal(createRes.statusCode, 201)

    // Update only ownedDomains, passing tags and providers through (as the client now does)
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/metadata-test',
      payload: {
        displayName: 'Metadata Test',
        canonicalDomain: 'meta.example.com',
        ownedDomains: ['docs.meta.example.com'],
        country: 'US',
        language: 'en',
        tags: ['seo', 'ai'],
        providers: ['gemini', 'openai'],
      },
    })
    assert.equal(updateRes.statusCode, 200)
    const body = JSON.parse(updateRes.payload)
    assert.deepEqual(body.ownedDomains, ['docs.meta.example.com'])
    assert.deepEqual(body.tags, ['seo', 'ai'])
    assert.deepEqual(body.providers, ['gemini', 'openai'])
  })

  // --- Location CRUD tests ---

  it('POST /api/v1/projects/:name/locations adds a location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'nyc',
        city: 'New York',
        region: 'New York',
        country: 'US',
        timezone: 'America/New_York',
      },
    })
    assert.equal(res.statusCode, 201)
    const body = JSON.parse(res.payload)
    assert.equal(body.label, 'nyc')
    assert.equal(body.city, 'New York')
    assert.equal(body.timezone, 'America/New_York')
  })

  it('POST /api/v1/projects/:name/locations rejects duplicate label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'nyc',
        city: 'New York',
        region: 'New York',
        country: 'US',
      },
    })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.payload)
    assert.match(body.error.message, /already exists/)
  })

  it('POST /api/v1/projects/:name/locations rejects invalid location data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'bad',
        city: 'Berlin',
        region: 'Berlin',
        country: 'DEU', // 3 chars, should be 2
      },
    })
    assert.equal(res.statusCode, 400)
  })

  it('GET /api/v1/projects/:name/locations lists locations and default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/my-site/locations',
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert(Array.isArray(body.locations))
    assert.equal(body.locations.length, 1)
    assert.equal(body.locations[0].label, 'nyc')
    assert.equal(body.defaultLocation, null)
  })

  it('PUT /api/v1/projects/:name/locations/default sets the default location', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: { label: 'nyc' },
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.defaultLocation, 'nyc')

    // Verify via GET locations
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const getBody = JSON.parse(getRes.payload)
    assert.equal(getBody.defaultLocation, 'nyc')
  })

  it('PUT /api/v1/projects/:name/locations/default rejects unknown label', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: { label: 'nonexistent' },
    })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.payload)
    assert.match(body.error.message, /not found/)
  })

  it('PUT /api/v1/projects/:name/locations/default rejects missing label', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: {},
    })
    assert.equal(res.statusCode, 400)
  })

  it('POST /api/v1/projects/:name/locations adds a second location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'london',
        city: 'London',
        region: 'England',
        country: 'GB',
      },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(JSON.parse(res.payload).label, 'london')

    // Verify both exist
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    assert.equal(listBody.locations.length, 2)
  })

  it('DELETE /api/v1/projects/:name/locations/:label removes a location', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/london',
    })
    assert.equal(res.statusCode, 204)

    // Verify removed
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    assert.equal(listBody.locations.length, 1)
    assert.equal(listBody.locations[0].label, 'nyc')
  })

  it('DELETE /api/v1/projects/:name/locations/:label returns 400 for unknown label', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/nonexistent',
    })
    assert.equal(res.statusCode, 400)
  })

  it('DELETE /api/v1/projects/:name/locations/:label clears default when removing default location', async () => {
    // Default is currently 'nyc' — remove it
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/nyc',
    })
    assert.equal(res.statusCode, 204)

    // Verify default is cleared
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    assert.equal(listBody.locations.length, 0)
    assert.equal(listBody.defaultLocation, null)
  })

  it('GET /api/v1/projects/:name includes locations in project response', async () => {
    // Add a location back for the project response test
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: { label: 'sf', city: 'San Francisco', region: 'California', country: 'US' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert(Array.isArray(body.locations))
    assert.equal(body.locations.length, 1)
    assert.equal(body.locations[0].label, 'sf')
  })

  it('POST /api/v1/projects/:name/locations returns 404 for unknown project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/nonexistent/locations',
      payload: { label: 'test', city: 'Test', region: 'Test', country: 'US' },
    })
    assert.equal(res.statusCode, 404)
  })

  it('GET /api/v1/settings returns provider and google summaries', async () => {
    const settingsCtx = buildApp({
      providerSummary: [{ name: 'gemini', configured: true }],
      googleSettingsSummary: { configured: false },
    })
    const settingsApp = settingsCtx.app
    await settingsApp.ready()

    try {
      const res = await settingsApp.inject({ method: 'GET', url: '/api/v1/settings' })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.payload) as {
        providers: Array<{ name: string; configured: boolean }>
        google: { configured: boolean }
      }
      assert.deepEqual(body.providers, [{ name: 'gemini', configured: true }])
      assert.deepEqual(body.google, { configured: false })
    } finally {
      await settingsApp.close()
      fs.rmSync(settingsCtx.tmpDir, { recursive: true, force: true })
    }
  })

  it('PUT /api/v1/settings/google updates Google OAuth config', async () => {
    let lastUpdate: { clientId: string; clientSecret: string } | null = null
    const settingsCtx = buildApp({
      googleSettingsSummary: { configured: false },
      onGoogleSettingsUpdate: (clientId, clientSecret) => {
        lastUpdate = { clientId, clientSecret }
        return { configured: true }
      },
    })
    const settingsApp = settingsCtx.app
    await settingsApp.ready()

    try {
      const res = await settingsApp.inject({
        method: 'PUT',
        url: '/api/v1/settings/google',
        payload: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
        },
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(lastUpdate, {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      })
      assert.deepEqual(JSON.parse(res.payload), { configured: true })
    } finally {
      await settingsApp.close()
      fs.rmSync(settingsCtx.tmpDir, { recursive: true, force: true })
    }
  })
})
