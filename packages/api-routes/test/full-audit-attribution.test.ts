import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, createClient, migrate, projects, users } from '@ainyc/canonry-db'
import { eq, inArray } from 'drizzle-orm'
import { apiRoutes, hashApiKey, hashUserPassword } from '../src/index.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'

describe('full HTTP audit attribution', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  it('attributes representative local mutations to normal keys, named users, and delegated MCP keys', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-full-audit-'))
    const db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    db.insert(projects).values({ id: projectId, name: 'audit-full', displayName: 'Audit full', canonicalDomain: 'audit-full.example', country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: now, updatedAt: now }).run()
    const normalKeyId = crypto.randomUUID()
    const delegatedKeyId = crypto.randomUUID()
    db.insert(users).values([
      { id: 'user-one', name: 'One', nameKey: 'one', passwordHash: await hashUserPassword('password-for-user-one'), role: 'admin', createdAt: now },
      { id: 'user-two', name: 'Two', nameKey: 'two', passwordHash: await hashUserPassword('password-for-user-two'), role: 'admin', createdAt: now },
    ]).run()
    db.insert(apiKeys).values([
      { id: normalKeyId, name: 'friendly but untrusted name', keyHash: hashApiKey('cnry_normal_audit_key'), keyPrefix: 'cnry_norm', scopes: ['*'], createdAt: now },
      { id: delegatedKeyId, name: 'mcp key name is not identity', keyHash: hashApiKey('cnry_delegated_audit_key'), keyPrefix: 'cnry_dele', scopes: ['*'], delegatedUserId: 'user-one', createdAt: now },
    ]).run()
    const app = Fastify()
    app.register(apiRoutes, { db, allowLoopbackWebhooks: true })
    cleanups.push(async () => { await app.close(); db.$client.close(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

    const login = async (name: string, password: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN, host: HOST }, payload: { name, password } })
      expect(response.statusCode).toBe(200)
      const raw = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0]! : String(response.headers['set-cookie'])
      return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
    }
    const normal = { authorization: 'Bearer cnry_normal_audit_key', 'x-actor': 'user:forged', 'user-agent': 'normal-client', 'x-canonry-actor-session': 'normal-session' }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/projects/audit-full/competitors', headers: normal, payload: { competitors: ['normal.example'] } })).statusCode).toBe(200)
    const userOneSession = await login('One', 'password-for-user-one')
    const userTwoSession = await login('Two', 'password-for-user-two')
    const sessionHeaders = (token: string) => ({ cookie: `${USER_SESSION_COOKIE_NAME}=${token}`, origin: ORIGIN, host: HOST })
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/audit-full/notifications', headers: sessionHeaders(userOneSession), payload: { channel: 'webhook', url: 'http://127.0.0.1:9/audit', events: ['run.completed'] } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/audit-full/competitors', headers: sessionHeaders(userTwoSession), payload: { competitors: ['user-two.example'] } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/audit-full/competitors', headers: { authorization: 'Bearer cnry_delegated_audit_key', 'x-actor': 'api-key:forged' }, payload: { competitors: ['delegated.example'] } })).statusCode).toBe(200)

    const rows = db.select().from(auditLog).where(inArray(auditLog.action, ['competitors.replaced', 'competitors.appended', 'notification.created'])).all()
    expect(rows.find(row => row.action === 'competitors.replaced')).toMatchObject({ actor: `api-key:${normalKeyId}`, credentialId: normalKeyId, userAgent: 'normal-client', actorSession: 'normal-session' })
    expect(rows.find(row => row.action === 'notification.created')).toMatchObject({ actor: 'user:user-one', credentialId: null })
    const appended = rows.filter(row => row.action === 'competitors.appended')
    expect(appended.map(row => row.actor)).toEqual(expect.arrayContaining(['user:user-two', 'user:user-one']))
    expect(appended.find(row => row.actor === 'user:user-one')).toMatchObject({ credentialId: delegatedKeyId })
    expect(rows.every(row => row.requestId && row.requestId.length > 0)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('friendly but untrusted name')
    expect(db.select().from(auditLog).where(eq(auditLog.actor, 'api')).all()).toEqual([])
  })
})
