import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-error-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, name: string) {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    locations: '[]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
  return id
}

function insertRun(
  db: ReturnType<typeof createClient>,
  projectId: string,
  fields: { status: string; error: string | null },
) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: fields.status,
    trigger: 'manual',
    location: null,
    startedAt: now,
    finishedAt: now,
    error: fields.error,
    createdAt: now,
  }).run()
  return id
}

let ctx: ReturnType<typeof buildApp>

beforeEach(async () => {
  ctx = buildApp()
  await ctx.app.ready()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/runs/:id error shape', () => {
  it('returns the new structured shape for runs written by the new writer', async () => {
    const projectId = insertProject(ctx.db, 'newshape')
    const errPayload = JSON.stringify({
      providers: {
        gemini: { message: 'API key not valid', raw: { error: { code: 400, message: 'API key not valid' } } },
      },
    })
    const runId = insertRun(ctx.db, projectId, { status: 'failed', error: errPayload })

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error).toEqual({
      providers: {
        gemini: { message: 'API key not valid', raw: { error: { code: 400, message: 'API key not valid' } } },
      },
    })
  })

  it('upgrades legacy double-stringified rows on read', async () => {
    const projectId = insertProject(ctx.db, 'legacy')
    // The pre-PR writer stored: JSON.stringify({ gemini: "[provider-gemini] {...}" })
    const legacyPayload = JSON.stringify({
      gemini: '[provider-gemini] {"error":{"code":400,"message":"API key not valid"}}',
    })
    const runId = insertRun(ctx.db, projectId, { status: 'failed', error: legacyPayload })

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error).toEqual({
      providers: {
        gemini: {
          message: 'API key not valid',
          raw: { error: { code: 400, message: 'API key not valid' } },
        },
      },
    })
  })

  it('promotes plain-string cancellation rows to {message}', async () => {
    const projectId = insertProject(ctx.db, 'plain')
    const runId = insertRun(ctx.db, projectId, { status: 'cancelled', error: 'Cancelled by user' })

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error).toEqual({ message: 'Cancelled by user' })
  })

  it('returns null when the run had no error', async () => {
    const projectId = insertProject(ctx.db, 'success')
    const runId = insertRun(ctx.db, projectId, { status: 'completed', error: null })

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error).toBeNull()
  })

  it('keeps the row stored in structured form after a cancel via API', async () => {
    const projectId = insertProject(ctx.db, 'roundtrip')
    const runId = insertRun(ctx.db, projectId, { status: 'queued', error: null })

    await ctx.app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/cancel` })

    const stored = ctx.db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(stored?.error).toBe(JSON.stringify({ message: 'Cancelled by user' }))
  })
})
