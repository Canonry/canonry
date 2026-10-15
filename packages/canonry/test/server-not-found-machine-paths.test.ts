import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, type DatabaseClient } from '@canonry/canonry-db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

/**
 * The SPA fallback answers unmatched paths with index.html and a 200. That is
 * right for dashboard deep links and wrong for two shapes that no browser is
 * asking for:
 *
 * - `/.well-known/*` carries OAuth discovery. Per RFC 9728 s3.1 that document
 *   sits at `/.well-known/oauth-protected-resource/<resource path>`, so it is
 *   reached by a leading dotted segment rather than one under a base path. A
 *   client handed HTML with a 200 cannot tell "no metadata here" from
 *   "metadata is malformed", so serving MCP over OAuth is impossible until
 *   this returns a real 404.
 * - Dotfile probes (/.env, /.git/config) are scanners. A 200 tells them the
 *   path exists.
 *
 * The regression this file really guards is the OTHER direction: the carve-out
 * must stay narrow enough that `/projects/<name>` still returns the document.
 */

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  cleanup: () => Promise<void>
}

const INDEX_HTML = '<!doctype html><html><head><base href="/"></head><body><div id="root"></div></body></html>'

async function buildServer(basePath?: string): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-not-found-${crypto.randomUUID()}`)
  const assetsDir = path.join(tmpDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  // The whole SPA-fallback block is guarded by `fs.existsSync(assetsDir)`, so
  // without a real index.html on disk every assertion below would pass for the
  // wrong reason — a headless build 404s everything already.
  fs.writeFileSync(path.join(assetsDir, 'index.html'), INDEX_HTML)

  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)

  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey: `cnry_${crypto.randomBytes(16).toString('hex')}`,
    providers: {},
    ...(basePath ? { basePath } : {}),
  }

  const app = await createServer({ config, db, logger: false, assetsDir })
  return {
    app,
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe('not-found handler: machine-facing paths', () => {
  let built: Built

  beforeAll(async () => {
    built = await buildServer()
  })

  afterAll(async () => {
    await built.cleanup()
  })

  it('serves the SPA document for a dashboard deep link', async () => {
    // The guard on the carve-out. If this ever 404s, the rule got too broad
    // and every shared project link in the product is broken.
    const res = await built.app.inject({ method: 'GET', url: '/projects/acme' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
  })

  it('serves the real authorization-server metadata rather than 404ing it', async () => {
    // This path used to 404 here, correctly, because nothing served it. It now
    // has a real handler, and the guard below must not shadow a live route.
    const res = await built.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })
    expect(res.statusCode).toBe(200)
    expect(res.json().code_challenge_methods_supported).toEqual(['S256'])
  })

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/openid-configuration',
    '/.well-known/anything-at-all',
  ])('returns a JSON 404 for %s', async (url) => {
    const res = await built.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).not.toContain('<!doctype html>')
  })

  it.each([
    '/.env',
    '/.env.local',
    '/.env.production',
    '/.git/config',
    '/backend/.env',
  ])('returns a JSON 404 for the dotfile probe %s', async (url) => {
    const res = await built.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it.each([
    '/%2eenv',
    '/%2Eenv',
    '/%2ewell-known/oauth-protected-resource',
    '/a/%2egit/config',
    '/foo%2F.env',
  ])('returns a JSON 404 for the percent-encoded probe %s', async (url) => {
    // Raw-segment matching alone lets every one of these through to the SPA
    // with 200 text/html. `%2e` is ".", and `%2F` is "/" — which would smuggle
    // a dotted segment past a naive split.
    const res = await built.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('does not throw on malformed percent-encoding', async () => {
    // decodeURIComponent('%zz') raises URIError. The handler must fall back to
    // the raw check rather than 500 — an unhandled throw here is reachable by
    // anyone who can send a request.
    const res = await built.app.inject({ method: 'GET', url: '/%zz' })
    expect(res.statusCode).toBeLessThan(500)
  })

  it('still 404s API routes as JSON', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })
})

describe('not-found handler: machine-facing paths under a base path', () => {
  let built: Built

  beforeAll(async () => {
    built = await buildServer('/t/demo')
  })

  afterAll(async () => {
    await built.cleanup()
  })

  it('returns a JSON 404 at the RFC 9728 discovery path for a base-path resource', async () => {
    // RFC 9728 s3.1 INSERTS the well-known segment between host and path: an
    // MCP resource at `/t/demo/mcp` publishes its metadata at
    // `/.well-known/oauth-protected-resource/t/demo/mcp`, NOT at
    // `/t/demo/.well-known/...`. Asserting the wrong shape here would misdirect
    // whoever implements the transport, even though the generic dotted-segment
    // rule happens to cover both.
    const res = await built.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/t/demo/mcp',
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('also 404s the base-path-prefixed well-known form', async () => {
    // Not where RFC 9728 puts discovery, but it is still a dotted segment and
    // must not return the app shell.
    const res = await built.app.inject({ method: 'GET', url: '/t/demo/.well-known/anything' })
    expect(res.statusCode).toBe(404)
  })

  it('still serves the SPA document for a deep link under the base path', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/t/demo/projects/acme' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
  })
})
