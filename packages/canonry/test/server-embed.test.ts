import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const FIXTURE_HTML =
  '<!doctype html><html><head><title>canonry</title></head><body><div id="root"></div></body></html>'

const EMBED_ENV = ['CANONRY_EMBED', 'CANONRY_EMBED_ORIGINS', 'CANONRY_EMBED_VIEWS'] as const

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  apiKey: string
  db: DatabaseClient
  cleanup: () => Promise<void>
}

async function buildServer(embed?: CanonryConfig['embed'], withIndexHtml = true): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-embed-${crypto.randomUUID()}`)
  const assetsDir = path.join(tmpDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  if (withIndexHtml) fs.writeFileSync(path.join(assetsDir, 'index.html'), FIXTURE_HTML)
  // A real static asset so we can assert the framing header is NOT set on it.
  fs.writeFileSync(path.join(assetsDir, 'app.js'), 'console.log(1)')

  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    ...(embed ? { embed } : {}),
  }

  const app = await createServer({ config, db, logger: false, assetsDir })
  return {
    app,
    apiKey,
    db,
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe('server embed mode (#716)', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of EMBED_ENV) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of EMBED_ENV) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('serves the fixture index.html via the assetsDir seam', async () => {
    const { app, cleanup } = await buildServer()
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toContain('id="root"')
    } finally {
      await cleanup()
    }
  })

  it('OFF: no CSP header and the injected config is byte-for-byte the default', async () => {
    const { app, cleanup } = await buildServer()
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.headers['content-security-policy']).toBeUndefined()
      expect(res.headers['x-frame-options']).toBeUndefined()
      // Default injection is exactly `{}` (no basePath, no embed key).
      expect(res.body).toContain('<script>window.__CANONRY_CONFIG__={}</script>')
      expect(res.body).not.toContain('embed')
    } finally {
      await cleanup()
    }
  })

  it('ON + origins: exact frame-ancestors header on the root AND on a deep-link fallback', async () => {
    const { app, cleanup } = await buildServer({ enabled: true, allowOrigins: ['https://host.example'] })
    try {
      const root = await app.inject({ method: 'GET', url: '/' })
      expect(root.statusCode).toBe(200)
      expect(root.headers['content-security-policy']).toBe('frame-ancestors https://host.example')
      expect(root.headers['x-frame-options']).toBeUndefined()
      // The injected client block opts the SPA into chromeless render.
      expect(root.body).toContain('"embed":{"enabled":true}')
      // No 'unsafe-inline' is forced — the inline config script still ships.
      expect(root.body).toContain('window.__CANONRY_CONFIG__')
      expect(root.headers['content-security-policy']).not.toContain('unsafe-inline')

      // A deep-linked embed (/projects/x) is served by the notFound fallback,
      // which must carry the SAME framing header.
      const deep = await app.inject({ method: 'GET', url: '/projects/acme' })
      expect(deep.statusCode).toBe(200)
      expect(deep.headers['content-security-policy']).toBe('frame-ancestors https://host.example')
    } finally {
      await cleanup()
    }
  })

  it('ON + multiple origins: space-joined header value', async () => {
    const { app, cleanup } = await buildServer({
      enabled: true,
      allowOrigins: ['https://a.example', 'https://b.example'],
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.headers['content-security-policy']).toBe(
        'frame-ancestors https://a.example https://b.example',
      )
    } finally {
      await cleanup()
    }
  })

  it("ON + no origins: fails closed to frame-ancestors 'none'", async () => {
    const { app, cleanup } = await buildServer({ enabled: true })
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    } finally {
      await cleanup()
    }
  })

  it('ON + only-invalid origins: fails closed (never an empty directive)', async () => {
    const { app, cleanup } = await buildServer({
      enabled: true,
      allowOrigins: ['not-a-url', 'https://*.evil.com'],
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    } finally {
      await cleanup()
    }
  })

  it('ON: the framing header is NOT set on static assets', async () => {
    const { app, cleanup } = await buildServer({ enabled: true, allowOrigins: ['https://host.example'] })
    try {
      const res = await app.inject({ method: 'GET', url: '/app.js' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-security-policy']).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('ON: the framing header is NOT set on an API JSON 404', async () => {
    const { app, apiKey, cleanup } = await buildServer({
      enabled: true,
      allowOrigins: ['https://host.example'],
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/this-route-does-not-exist',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.headers['content-security-policy']).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('ON: injects views in the client block when configured', async () => {
    const { app, cleanup } = await buildServer({
      enabled: true,
      allowOrigins: ['https://host.example'],
      views: ['overview'],
    })
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.body).toContain('"views":["overview"]')
    } finally {
      await cleanup()
    }
  })

  it('ON but index.html missing: 404 without throwing', async () => {
    const { app, cleanup } = await buildServer({ enabled: true }, false)
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.statusCode).toBe(404)
    } finally {
      await cleanup()
    }
  })

  it('embed mode does NOT weaken the read-only write gate (regression)', async () => {
    const { app, apiKey, db, cleanup } = await buildServer({ enabled: true, allowOrigins: ['https://host.example'] })
    try {
      // Mint a read-only key alongside the server's default full key.
      const readOnlyRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
      db.insert(apiKeys)
        .values({
          id: crypto.randomUUID(),
          name: 'read-only',
          keyHash: crypto.createHash('sha256').update(readOnlyRaw).digest('hex'),
          keyPrefix: readOnlyRaw.slice(0, 9),
          scopes: ['read'],
          createdAt: new Date().toISOString(),
        })
        .run()
      const auth = { authorization: `Bearer ${readOnlyRaw}` }
      const fullAuth = { authorization: `Bearer ${apiKey}` }

      // Reads pass.
      const read = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: auth })
      expect(read.statusCode).toBe(200)

      // Seed a real project with the full key so the write routes below resolve
      // a target rather than 404-ing before the method-based gate is exercised.
      const seed = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/gate-test',
        headers: fullAuth,
        payload: { displayName: 'Gate Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
      })
      expect(seed.statusCode).toBe(201)

      // Writes are still 403 FORBIDDEN with embed enabled — across a route with
      // no requireScope (runs), a create/update (PUT), and a DELETE.
      for (const req of [
        { method: 'POST' as const, url: '/api/v1/projects/gate-test/runs', payload: {} },
        { method: 'PUT' as const, url: '/api/v1/projects/gate-test', payload: { displayName: 'x', canonicalDomain: 'example.com', country: 'US', language: 'en' } },
        { method: 'DELETE' as const, url: '/api/v1/projects/gate-test' },
      ]) {
        const res = await app.inject({ ...req, headers: auth })
        expect(res.statusCode, `${req.method} should be forbidden for a read-only key`).toBe(403)
        expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
      }
    } finally {
      await cleanup()
    }
  })

  it('env (CANONRY_EMBED + CANONRY_EMBED_ORIGINS) is wired through createServer and overrides config', async () => {
    process.env.CANONRY_EMBED = '1'
    process.env.CANONRY_EMBED_ORIGINS = 'https://env.example'
    // config does NOT enable embed — env must win.
    const { app, cleanup } = await buildServer()
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.headers['content-security-policy']).toBe('frame-ancestors https://env.example')
      expect(res.body).toContain('"embed":{"enabled":true}')
    } finally {
      await cleanup()
    }
  })
})
