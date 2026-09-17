import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects, users } from '@ainyc/canonry-db'
import { apiRoutes, createUserSession, hashApiKey, USER_SESSION_COOKIE_NAME } from '../src/index.js'

async function fixture(operatorApiKeyIds = ['operator', 'writer', 'project', 'delegated'], accountless = false) {
  const db = createClient(':memory:')
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project', name: 'customer', displayName: 'Customer', canonicalDomain: 'customer.invalid', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  if (!accountless) for (const role of ['admin', 'viewer'] as const) db.insert(users).values({ id: role, name: role, nameKey: role, passwordHash: 'unused', role, createdAt: now }).run()
  for (const [id, scopes] of [
    ['operator', ['logs.read']], ['writer', ['logs.read', 'settings.write']],
    ['customer', ['*']], ['observer', ['logs.read']], ['forged', ['*', 'operator', 'operator.read']],
    ['project', ['*']], ['delegated', ['*']],
  ] as const) db.insert(apiKeys).values({
    id, name: id, scopes: [...scopes], keyHash: hashApiKey(`cnry_fixture_${id}`), keyPrefix: 'cnry_fixture', createdAt: now,
    projectId: id === 'project' ? 'project' : null, delegatedUserId: id === 'delegated' && !accountless ? 'admin' : null,
  }).run()
  const list = vi.fn(() => ({ entries: [], nextCursor: null, truncated: 0, dropped: 0, retention: 'process' as const, observedAt: now }))
  const getTelemetry = vi.fn(() => ({ enabled: false }))
  const setTelemetry = vi.fn()
  const app = Fastify()
  onTestFinished(async () => { await app.close(); db.$client.close() })
  await app.register(apiRoutes, { db, operatorApiKeyIds, sessionCookieName: 'legacy', resolveSessionApiKeyId: () => 'operator', listOperationalLogs: list, getTelemetryStatus: getTelemetry, setTelemetryEnabled: setTelemetry })
  await app.ready()
  return { app, db, list, getTelemetry, setTelemetry }
}

const headers = (id: string) => ({ authorization: `Bearer cnry_fixture_${id}` })

it.each(['customer', 'observer', 'forged', 'project', 'delegated'])('denies internal diagnostics to %s, regardless of claimed scopes', async id => {
  const { app, list, getTelemetry, setTelemetry } = await fixture()
  for (const url of ['/api/v1/operations/logs', '/api/v1/telemetry']) {
    expect((await app.inject({ url, headers: { ...headers(id), 'x-canonry-operator': 'true' } })).statusCode).toBe(403)
  }
  expect((await app.inject({ method: 'PUT', url: '/api/v1/telemetry', headers: headers(id), payload: { enabled: true } })).statusCode).toBe(403)
  expect(list).not.toHaveBeenCalled()
  expect(getTelemetry).not.toHaveBeenCalled()
  expect(setTelemetry).not.toHaveBeenCalled()
  expect((await app.inject({ url: '/api/v1/keys/self', headers: headers(id) })).json().operator).toBe(false)
  expect((await app.inject({ url: '/api/v1/projects/customer', headers: headers(id) })).statusCode).toBe(200)
})

it.each(['admin', 'viewer'])('denies customer %s sessions, including admin-issued wildcard keys', async role => {
  const { app, db } = await fixture()
  const cookie = `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, role)}`
  for (const url of ['/api/v1/operations/logs', '/api/v1/telemetry']) expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(403)
  if (role === 'admin') {
    const created = await app.inject({ method: 'POST', url: '/api/v1/keys', headers: { cookie, host: 'localhost', origin: 'http://localhost' }, payload: { name: 'claimed operator', scopes: ['*', 'logs.read', 'operator'], operator: true, id: 'operator' } })
    expect(created.statusCode).toBe(200)
    expect(created.json().id).not.toBe('operator')
    expect((await app.inject({ url: '/api/v1/operations/logs', headers: { authorization: `Bearer ${created.json().key}` } })).statusCode).toBe(403)
  }
})

it('requires a host grant as well as normal read/write permissions', async () => {
  const { app, setTelemetry } = await fixture()
  for (const url of ['/api/v1/operations/logs', '/api/v1/telemetry']) expect((await app.inject({ url, headers: headers('operator') })).statusCode).toBe(200)
  expect((await app.inject({ url: '/api/v1/keys/self', headers: headers('operator') })).json()).toMatchObject({ operator: true, readOnly: true })
  expect((await app.inject({ method: 'PUT', url: '/api/v1/telemetry', headers: headers('operator'), payload: { enabled: true } })).statusCode).toBe(403)
  expect((await app.inject({ method: 'PUT', url: '/api/v1/telemetry', headers: headers('writer'), payload: { enabled: true } })).statusCode).toBe(200)
  expect(setTelemetry).toHaveBeenCalledExactlyOnceWith(true)
})

it('fails closed when no operator allowlist is configured', async () => {
  const { app } = await fixture([])
  expect((await app.inject({ url: '/api/v1/operations/logs', headers: headers('operator') })).statusCode).toBe(403)
  expect((await app.inject({ url: '/api/v1/telemetry', headers: headers('customer') })).statusCode).toBe(403)
})

it('does not carry operator authority into a shared-password/key browser cookie', async () => {
  const { app } = await fixture(['operator'], true)
  const cookie = { cookie: 'legacy=fixture' }
  expect((await app.inject({ url: '/api/v1/keys/self', headers: cookie })).json()).toMatchObject({ id: 'operator', operator: false })
  expect((await app.inject({ url: '/api/v1/operations/logs', headers: cookie })).statusCode).toBe(403)
  expect((await app.inject({ url: '/api/v1/telemetry', headers: cookie })).statusCode).toBe(403)
})

it('revokes operator access immediately through the normal credential revocation gate', async () => {
  const { app, db } = await fixture()
  expect((await app.inject({ url: '/api/v1/operations/logs', headers: headers('operator') })).statusCode).toBe(200)
  db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, 'operator')).run()
  expect((await app.inject({ url: '/api/v1/operations/logs', headers: headers('operator') })).statusCode).toBe(401)
})

it('does not leak internal telemetry state through the ordinary audit-history API', async () => {
  const { app } = await fixture()
  expect((await app.inject({ method: 'PUT', url: '/api/v1/telemetry', headers: headers('writer'), payload: { enabled: true } })).statusCode).toBe(200)
  const customer = await app.inject({ url: '/api/v1/history', headers: headers('customer') })
  expect(customer.statusCode).toBe(200)
  expect(customer.body).not.toContain('telemetry.updated')
  const operator = await app.inject({ url: '/api/v1/history', headers: headers('operator') })
  expect(operator.body).toContain('telemetry.updated')
})
