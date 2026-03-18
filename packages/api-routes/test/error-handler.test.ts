import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-handler-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)

  return { app, tmpDir }
}

describe('global error handler', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns structured AppError for not-found project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nonexistent-project-xyz' })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toContain('not found')
  })

  it('returns structured error for invalid project creation', async () => {
    // Missing required fields should trigger a validation error
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/test-err',
      payload: {
        // missing displayName, canonicalDomain, country, language
      },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBeTruthy()
  })

  it('returns structured error for non-existent run detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/00000000-0000-0000-0000-000000000000' })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('all error responses follow { error: { code, message } } shape', async () => {
    // Test multiple error endpoints to verify consistent structure
    const urls = [
      '/api/v1/projects/no-such-project',
      '/api/v1/runs/00000000-0000-0000-0000-000000000000',
      '/api/v1/projects/no-such-project/keywords',
    ]

    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url })
      const body = JSON.parse(res.body)
      expect(body.error, `${url} should have error object`).toBeDefined()
      expect(typeof body.error.code, `${url} should have error.code`).toBe('string')
      expect(typeof body.error.message, `${url} should have error.message`).toBe('string')
    }
  })
})
