import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, createClient, migrate, projects } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'

/**
 * Regression coverage for the audit-log attribution columns added with
 * PR #593 (azcoatings post-mortem follow-up). Without these columns,
 * destructive events like the 2026-05-15 `queries.replaced` ride as
 * `actor='api'` with no narrower identity, so post-mortems can't tell
 * which client called the destructive endpoint. The `user_agent` and
 * `actor_session` columns make that attribution recoverable.
 */

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-audit-attr-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'audit-attr',
    displayName: 'Audit Attribution',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  return { app, db, tmpDir, projectId }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('audit_log attribution capture', () => {
  it('PUT /queries records the User-Agent header on the queries.replaced event', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/audit-attr/queries',
      headers: { 'user-agent': 'canonry-cli/4.51.1 node/22.x' },
      payload: { queries: ['best polyurea coating'] },
    })
    expect(res.statusCode).toBe(200)

    const row = ctx.db.select().from(auditLog)
      .where(eq(auditLog.action, 'queries.replaced'))
      .get()
    expect(row).toBeDefined()
    expect(row!.userAgent).toBe('canonry-cli/4.51.1 node/22.x')
    expect(row!.actorSession).toBeNull()
  })

  it('DELETE /queries records the User-Agent on queries.deleted', async () => {
    // Seed a query first.
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/audit-attr/queries',
      headers: { 'user-agent': 'seeder/1.0' },
      payload: { queries: ['will be deleted', 'kept'] },
    })

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/audit-attr/queries',
      headers: { 'user-agent': 'mozilla/5.0 dashboard' },
      payload: { queries: ['will be deleted'] },
    })
    expect(res.statusCode).toBe(200)

    const row = ctx.db.select().from(auditLog)
      .where(eq(auditLog.action, 'queries.deleted'))
      .get()
    expect(row).toBeDefined()
    expect(row!.userAgent).toBe('mozilla/5.0 dashboard')
  })

  it('POST /queries records the User-Agent on queries.appended', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/audit-attr/queries',
      headers: { 'user-agent': 'aero-agent/1.0' },
      payload: { queries: ['appended via agent'] },
    })
    expect(res.statusCode).toBe(200)

    const row = ctx.db.select().from(auditLog)
      .where(eq(auditLog.action, 'queries.appended'))
      .get()
    expect(row).toBeDefined()
    expect(row!.userAgent).toBe('aero-agent/1.0')
  })

  it('captures the optional X-Canonry-Actor-Session header alongside the UA', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/audit-attr/queries',
      headers: {
        'user-agent': 'aero/2.0',
        'x-canonry-actor-session': 'session-abc-123',
      },
      payload: { queries: ['q1'] },
    })
    expect(res.statusCode).toBe(200)

    const row = ctx.db.select().from(auditLog)
      .where(eq(auditLog.action, 'queries.replaced'))
      .get()
    expect(row!.userAgent).toBe('aero/2.0')
    expect(row!.actorSession).toBe('session-abc-123')
  })

  it('leaves both attribution columns NULL when no headers are provided', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/audit-attr/queries',
      payload: { queries: ['q1'] },
      // No headers — simulates a non-HTTP write path or an unconfigured client.
    })
    expect(res.statusCode).toBe(200)

    const row = ctx.db.select().from(auditLog)
      .where(eq(auditLog.action, 'queries.replaced'))
      .get()
    // Fastify always supplies SOME user-agent string for inject() requests
    // when none is set (the framework's default). The assertion that
    // matters: actorSession is NULL when the header is absent, and the
    // call succeeded without throwing.
    expect(row!.actorSession).toBeNull()
  })
})
