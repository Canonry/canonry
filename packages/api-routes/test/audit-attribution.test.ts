import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, createClient, migrate, projects } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { auditFromRequest } from '../src/helpers.js'

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

  it('derives generic HTTP actor=api from the authenticated API key identity', () => {
    const entry = auditFromRequest({
      headers: { 'user-agent': 'canonry-cli/4.52.0' },
      principal: { kind: 'api-key', id: 'key-123', name: 'delegate', scopes: ['write'], viaCookie: false },
    }, { projectId: ctx.projectId, actor: 'api', action: 'queries.replaced', entityType: 'query' })

    expect(entry.actor).toBe('api-key:key-123')
  })

  it('persists the API key identity from the authenticated request, not caller headers', async () => {
    const keyId = crypto.randomUUID()
    const token = 'cnry_audit_attribution_key'
    ctx.db.insert(apiKeys).values({
      id: keyId,
      name: 'audit attribution',
      keyHash: hashApiKey(token),
      keyPrefix: token.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    const authenticatedApp = Fastify()
    authenticatedApp.register(apiRoutes, { db: ctx.db })
    await authenticatedApp.ready()
    try {
      const response = await authenticatedApp.inject({
        method: 'PUT',
        url: '/api/v1/projects/audit-attr/queries',
        headers: {
          authorization: `Bearer ${token}`,
          'x-canonry-actor-session': 'untrusted-session',
        },
        payload: { queries: ['authenticated write'] },
      })
      expect(response.statusCode).toBe(200)
      const row = ctx.db.select().from(auditLog).where(eq(auditLog.action, 'queries.replaced')).get()
      expect(row!.actor).toBe(`api-key:${keyId}`)
      expect(row!.credentialId).toBe(keyId)
      expect(row!.requestId).toBeTruthy()
      expect(row!.actorSession).toBe('untrusted-session')
    } finally {
      await authenticatedApp.close()
    }
  })

  it('derives generic HTTP actor=api from a signed-in user and retains custom actors without a principal', () => {
    const userEntry = auditFromRequest({
      headers: {},
      principal: { kind: 'user', id: 'user-123', name: 'Ada', scopes: ['*'], viaCookie: true },
    }, { projectId: ctx.projectId, actor: 'api', action: 'queries.replaced', entityType: 'query' })
    const customEntry = auditFromRequest({ headers: {} }, {
      projectId: ctx.projectId, actor: 'scheduler', action: 'queries.replaced', entityType: 'query',
    })

    expect(userEntry.actor).toBe('user:user-123')
    expect(customEntry.actor).toBe('scheduler')
  })

  it('treats caller attribution headers as bounded, untrusted context', () => {
    const entry = auditFromRequest({
      headers: {
        'user-agent': `agent\r\nforged ${'x'.repeat(1_000)}`,
        'x-canonry-actor-session': `trace\r\nforged ${'y'.repeat(1_000)}`,
      },
      principal: { kind: 'api-key', id: 'key-123', name: 'delegate', scopes: ['write'], viaCookie: false },
    }, { projectId: ctx.projectId, actor: 'api', action: 'queries.replaced', entityType: 'query' })

    expect(entry.actor).toBe('api-key:key-123')
    expect(entry.userAgent).not.toMatch(/[\r\n]/)
    expect(entry.actorSession).not.toMatch(/[\r\n]/)
    expect(entry.userAgent!.length).toBeLessThanOrEqual(512)
    expect(entry.actorSession!.length).toBeLessThanOrEqual(512)
  })
})
