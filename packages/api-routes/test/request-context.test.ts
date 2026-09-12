import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { getRequestContext, registerRequestContext, sanitizeRequestContext } from '../src/request-context.js'
import { writeAuditLog } from '../src/helpers.js'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

describe('request-scoped audit context', () => {
  it('does not attribute later background continuations to a completed HTTP request', async () => {
    const app = Fastify()
    apps.push(app)
    registerRequestContext(app)
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let background!: Promise<unknown>
    app.get('/schedule', async () => {
      background = released.then(() => getRequestContext())
      return { ok: true }
    })
    await app.inject('/schedule')
    release()
    expect(await background).toBeUndefined()
  })

  it('retains authenticated identity when authorization rejects before preHandler', async () => {
    const app = Fastify()
    apps.push(app)
    registerRequestContext(app)
    app.addHook('onRequest', (request, reply, done) => {
      request.principal = { kind: 'api-key', id: 'denied-key', name: 'denied', scopes: ['read'], viaCookie: false }
      reply.code(403).send({ error: 'forbidden' })
      done()
    })
    let observed: unknown
    app.addHook('onResponse', async () => { observed = { ...getRequestContext() } })
    app.get('/denied', async () => ({}))
    expect((await app.inject('/denied')).statusCode).toBe(403)
    expect(observed).toMatchObject({ actor: 'api-key:denied-key', credentialId: 'denied-key', requestId: expect.any(String) })
  })

  it('redacts and bounds caller correlation headers, including explicit audit hints', () => {
    const hint = `Bearer must-not-leak ${'x'.repeat(600)}`
    expect(sanitizeRequestContext(hint)).not.toContain('must-not-leak')
    expect(sanitizeRequestContext(hint)?.length).toBeLessThanOrEqual(512)
    let saved: Record<string, unknown> = {}
    writeAuditLog({ insert: () => ({ values: (row: Record<string, unknown>) => ({ run: () => { saved = row } }) }) } as never, {
      actor: 'system', action: 'test', entityType: 'test', userAgent: hint, actorSession: hint,
    })
    expect(saved.actor).toBe('system')
    expect(saved.userAgent).toBe(sanitizeRequestContext(hint))
    expect(saved.actorSession).toBe(sanitizeRequestContext(hint))
  })

  it('keeps concurrent Fastify continuations isolated and enriches generic audit writes', async () => {
    const app = Fastify()
    apps.push(app)
    const rows: Array<Record<string, unknown>> = []
    // Simulate authPlugin before the context hook's preHandler resolves identity.
    app.addHook('onRequest', (request, _reply, done) => {
      const keyId = String(request.headers['x-test-key-id'])
      request.apiKey = { id: keyId, name: keyId, scopes: ['*'] }
      request.principal = { kind: 'api-key', id: keyId, name: keyId, scopes: ['*'], viaCookie: false }
      done()
    })
    registerRequestContext(app)
    app.post('/write', async request => {
      await new Promise(resolve => setTimeout(resolve, Number(request.headers['x-delay-ms']) || 0))
      writeAuditLog({
        insert: () => ({ values: (row: Record<string, unknown>) => ({ run: () => rows.push(row) }) }),
      } as never, { actor: 'api', action: 'test.written', entityType: 'test' })
      return getRequestContext()
    })

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/write', headers: { 'x-test-key-id': 'key-a', 'x-delay-ms': '20', 'user-agent': 'agent-a', 'x-canonry-actor-session': 'session-a' } }),
      app.inject({ method: 'POST', url: '/write', headers: { 'x-test-key-id': 'key-b', 'x-delay-ms': '1', 'user-agent': 'agent-b', 'x-canonry-actor-session': 'session-b' } }),
    ])

    expect(first.json()).toMatchObject({ actor: 'api-key:key-a', credentialId: 'key-a', userAgent: 'agent-a', actorSession: 'session-a' })
    expect(second.json()).toMatchObject({ actor: 'api-key:key-b', credentialId: 'key-b', userAgent: 'agent-b', actorSession: 'session-b' })
    expect(first.json().requestId).not.toBe(second.json().requestId)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'api-key:key-a', credentialId: 'key-a', userAgent: 'agent-a', actorSession: 'session-a' }),
      expect.objectContaining({ actor: 'api-key:key-b', credentialId: 'key-b', userAgent: 'agent-b', actorSession: 'session-b' }),
    ]))
  })

  it('has no request context outside an HTTP continuation', () => {
    expect(getRequestContext()).toBeUndefined()
  })

  it('keeps all audit inserts behind the central enrichment helper', () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
    const files = fs.readdirSync(sourceRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    const bypasses = files.filter(file => {
      if (file === 'helpers.ts') return false
      return fs.readFileSync(path.join(sourceRoot, file), 'utf8').includes('insert(auditLog)')
    })
    expect(bypasses).toEqual([])
  })
})
