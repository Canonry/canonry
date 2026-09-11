import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, createClient, migrate } from '@ainyc/canonry-db'
import { eq, inArray } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  keyId: string
  token: string
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-core-audit-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const keyId = crypto.randomUUID()
  const token = 'cnry_core_audit_attribution_key'
  db.insert(apiKeys).values({
    id: keyId,
    name: 'core audit attribution',
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()
  const app = Fastify()
  app.register(apiRoutes, { db })
  return { app, db, tmpDir, keyId, token }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  ctx.db.$client.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('core HTTP audit attribution', () => {
  it('attributes project, apply, schedule, and run writes to the authenticated API key', async () => {
    const actorSession = 'agent-session-core-123'
    const userAgent = `canonry-test/${'x'.repeat(700)}`
    const headers = {
      authorization: `Bearer ${ctx.token}`,
      'user-agent': userAgent,
      'x-canonry-actor-session': actorSession,
    }
    const projectBody = {
      displayName: 'Core audit project',
      canonicalDomain: 'core-audit.example',
      country: 'US',
      language: 'en',
    }

    expect((await ctx.app.inject({ method: 'PUT', url: '/api/v1/projects/core-audit', headers, payload: projectBody })).statusCode).toBe(201)
    expect((await ctx.app.inject({
      method: 'POST', url: '/api/v1/apply', headers, payload: {
        apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'core-audit' },
        spec: { ...projectBody, queries: ['core audit query'] },
      },
    })).statusCode).toBe(200)
    expect((await ctx.app.inject({
      method: 'PUT', url: '/api/v1/projects/core-audit/schedule', headers,
      payload: { preset: 'daily', timezone: 'UTC' },
    })).statusCode).toBe(201)
    const run = await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/core-audit/runs', headers, payload: {} })
    expect(run.statusCode).toBe(201)
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/runs/${run.json().id}/cancel`, headers })).statusCode).toBe(200)

    const actions = ['project.created', 'project.applied', 'schedule.created', 'run.created', 'run.cancelled'] as const
    const rows = ctx.db.select().from(auditLog).where(inArray(auditLog.action, actions)).all()
    expect(rows).toHaveLength(actions.length)
    for (const row of rows) {
      expect(row.actor).toBe(`api-key:${ctx.keyId}`)
      expect(row.actorSession).toBe(actorSession)
      expect(row.userAgent).toBe(userAgent.slice(0, 512))
      expect(JSON.stringify(row)).not.toContain(ctx.token)
    }
    expect(ctx.db.select().from(auditLog).where(eq(auditLog.actor, 'api')).all()).toEqual([])
  })
})
