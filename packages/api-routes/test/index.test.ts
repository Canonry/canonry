import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/aeo-platform-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

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
        country: 'US',
        language: 'en',
      },
    })
    assert.equal(res.statusCode, 201)
    const body = JSON.parse(res.payload)
    assert.equal(body.name, 'my-site')
    assert.equal(body.displayName, 'My Site')
    assert.equal(body.canonicalDomain, 'example.com')
  })

  it('GET /api/v1/projects lists projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert(Array.isArray(body))
    assert.equal(body.length, 1)
    assert.equal(body[0].name, 'my-site')
  })

  it('GET /api/v1/projects/:name gets a single project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.payload)
    assert.equal(body.name, 'my-site')
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
})
