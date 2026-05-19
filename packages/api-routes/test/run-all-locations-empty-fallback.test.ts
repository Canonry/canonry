import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * Regression test for the "🔧 Sweep activity FAILED — No locations configured"
 * complaint. Agents (Aero, Claude Code, external scripts) routinely pass
 * `allLocations: true` by reflex when triggering sweeps. Throwing 400 on
 * projects with no configured locations made every agent-driven sweep on an
 * unlocated project a hard failure even though the operator's intent
 * ("sweep this project") was unambiguous.
 *
 * The new behavior: `allLocations: true` on a 0-location project degrades
 * to a single locationless run — equivalent to `noLocation: true` or
 * omitting both flags. Locations DO exist → still fan out as before.
 */
describe('POST /:name/runs allLocations on a 0-location project (graceful fallback)', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-empty-loc-fallback-'))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
    // Seed a project with NO locations.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/no-loc',
      payload: {
        displayName: 'No Locations',
        canonicalDomain: 'no-loc.example.com',
        country: 'US',
        language: 'en',
        locations: [],
      },
    })
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 201 with a single locationless run instead of 400 No locations configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/no-loc/runs',
      payload: { allLocations: true },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { id: string; location: string | null; status: string }
    // Single-object response shape (not the 207 multi-location array).
    expect(Array.isArray(body)).toBe(false)
    expect(body.id).toBeDefined()
    expect(body.location).toBeNull()
    expect(body.status).toMatch(/queued|running/)
  })

  it('still fans out when the project has locations (no regression on the happy path)', async () => {
    // Sanity check: graceful-fallback path must not have broken the
    // multi-location fan-out when locations ARE configured.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/with-loc',
      payload: {
        displayName: 'With Locations',
        canonicalDomain: 'with-loc.example.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'east', city: 'New York', region: 'NY', country: 'US' },
          { label: 'west', city: 'San Francisco', region: 'CA', country: 'US' },
        ],
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/with-loc/runs',
      payload: { allLocations: true },
    })

    expect(res.statusCode).toBe(207)
    const body = JSON.parse(res.body) as Array<{ id: string; location: string; status: string }>
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    expect(body.map(r => r.location).sort()).toEqual(['east', 'west'])
  })

  it('rejects when allLocations is combined with location or noLocation (Zod refinement)', async () => {
    // The Zod refinement on runTriggerRequestSchema only allows ONE of
    // location / allLocations / noLocation. Make sure the graceful-fallback
    // didn't accidentally bypass that.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/no-loc/runs',
      payload: { allLocations: true, noLocation: true },
    })
    expect(res.statusCode).toBe(400)
  })
})
