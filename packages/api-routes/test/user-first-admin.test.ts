import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { apiKeys, createClient, migrate, projects, userAuthState, users, type DatabaseClient } from '@ainyc/canonry-db'
import { UserRoles } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let root: string
let projectId: string
const account = () => ({ name: crypto.randomUUID(), password: crypto.randomUUID(), role: UserRoles.admin, onlyIfFirstAdmin: true })
const header = (key: string) => ({ authorization: `Bearer ${key}` })
function key(scopes: string[], project: string | null = null) {
  const token = crypto.randomUUID()
  db.insert(apiKeys).values({ id: crypto.randomUUID(), name: crypto.randomUUID(), keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes, projectId: project, createdAt: new Date().toISOString() }).run()
  return token
}
beforeEach(async () => {
  db = createClient(':memory:')
  migrate(db)
  projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({ id: projectId, name: crypto.randomUUID(), displayName: crypto.randomUUID(), canonicalDomain: 'example.test', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  root = key(['*'])
  app = Fastify()
  await app.register(apiRoutes, { db })
  await app.ready()
})
afterEach(async () => { await app.close(); db.$client.close() })

test('authorized setup creates a password administrator who can sign in', async () => {
  const body = account()
  const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: header(root), payload: body })
  expect(created.statusCode).toBe(201)
  expect(created.json()).toMatchObject({ name: body.name, role: UserRoles.admin, hasPassword: true })
  expect(created.json()).not.toHaveProperty('passwordHash')
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost', host: 'localhost' }, payload: { name: body.name, password: body.password } })
  expect(login.statusCode).toBe(200)
  expect(login.json().user.id).toBe(created.json().id)
})

test('two concurrent first-admin submissions create only one account', async () => {
  const responses = await Promise.all([account(), account()].map(payload => app.inject({ method: 'POST', url: '/api/v1/users', headers: header(root), payload })))
  expect(responses.map(r => r.statusCode).sort()).toEqual([201, 400])
  expect(db.select().from(users).all()).toHaveLength(1)
})

test('setup refuses a protected instance even when all account rows were removed', async () => {
  db.update(userAuthState).set({ namedAuthenticationRequired: true }).run()
  const response = await app.inject({ method: 'POST', url: '/api/v1/users', headers: header(root), payload: account() })
  expect(response.statusCode).toBe(400)
  expect(db.select().from(users).all()).toHaveLength(0)
  // Recovery through ordinary authorized account creation remains supported.
  const { onlyIfFirstAdmin: _, ...payload } = account()
  expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: header(root), payload })).statusCode).toBe(201)
})

test.each(['anonymous', 'invalid', 'read', 'settings', 'project'] as const)('first-admin setup refuses %s authority', async kind => {
  const credential = kind === 'anonymous' ? undefined : kind === 'invalid' ? crypto.randomUUID() : key(kind === 'read' ? ['read'] : kind === 'settings' ? ['settings.write'] : ['*'], kind === 'project' ? projectId : null)
  const response = await app.inject({ method: 'POST', url: '/api/v1/users', headers: credential ? header(credential) : {}, payload: account() })
  expect(response.statusCode).toBe(kind === 'anonymous' || kind === 'invalid' ? 401 : 403)
  expect(db.select().from(users).all()).toHaveLength(0)
})

test('first-admin setup cannot create a viewer', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/users', headers: header(root), payload: { ...account(), role: UserRoles.viewer } })
  expect(response.statusCode).toBe(400)
  expect(db.select().from(users).all()).toHaveLength(0)
})
