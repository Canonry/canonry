import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { apiKeys, createClient, migrate, projects, users, type DatabaseClient } from '@ainyc/canonry-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

const MCP_ACCEPT = 'application/json, text/event-stream'
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-user-access-test', version: '1' } },
}

interface HttpResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
  [key: string]: unknown
}

interface McpRpcResponse {
  result?: McpToolResult & { tools?: Array<{ name: string }> }
}

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  db: DatabaseClient
  origin: string
  keys: { admin: string; viewer: string; analyst: string; projectAdmin: string; revokedTarget: string }
  users: { admin: string; viewer: string; analyst: string; target: string }
  cleanup: () => Promise<void>
}

async function reservePort(): Promise<number> {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({ port: 0, host: '127.0.0.1' }, () => resolve())
  })
  const address = listener.address()
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a loopback port.')
  return address.port
}

function newRawKey(): string {
  return `cnry_${crypto.randomBytes(24).toString('hex')}`
}

function keyHash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function insertUser(db: DatabaseClient, role: 'admin' | 'analyst' | 'viewer', name: string): string {
  const id = crypto.randomUUID()
  db.insert(users).values({
    id,
    name,
    nameKey: name.toLowerCase(),
    passwordHash: 'test-password-hash',
    role,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function insertDelegatedKey(
  db: DatabaseClient,
  userId: string,
  scopes: string[],
  projectId?: string,
): string {
  const raw = newRawKey()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: `mcp-user-access:${userId}`,
    keyHash: keyHash(raw),
    keyPrefix: raw.slice(0, 9),
    scopes,
    delegatedUserId: userId,
    delegatedUserAuthVersion: 0,
    ...(projectId ? { projectId } : {}),
    createdAt: new Date().toISOString(),
  }).run()
  return raw
}

async function buildServer(): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-mcp-user-access-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const admin = insertUser(db, 'admin', 'admin')
  const viewer = insertUser(db, 'viewer', 'viewer')
  const analyst = insertUser(db, 'analyst', 'analyst')
  const target = insertUser(db, 'analyst', 'target')
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'scoped-project',
    displayName: 'Scoped project',
    canonicalDomain: 'scoped.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const port = await reservePort()
  const config: CanonryConfig = {
    apiUrl: `http://127.0.0.1:${port}`,
    database: dbPath,
    apiKey: newRawKey(),
    publicUrl: 'https://instance.example.test',
    providers: {},
    auth: { google: { enabled: true, clientId: 'google-client-id', clientSecret: 'google-client-secret' } },
  }
  const app = await createServer({ config, db, logger: false })
  await app.listen({ port, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${port}`

  const accountScopes = ['users.read', 'users.write']
  return {
    app,
    db,
    origin,
    keys: {
      admin: insertDelegatedKey(db, admin, accountScopes),
      viewer: insertDelegatedKey(db, viewer, accountScopes),
      analyst: insertDelegatedKey(db, analyst, accountScopes),
      projectAdmin: insertDelegatedKey(db, admin, accountScopes, projectId),
      revokedTarget: insertDelegatedKey(db, target, accountScopes),
    },
    users: { admin, viewer, analyst, target },
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

async function request(
  built: Built,
  key: string,
  payload: unknown,
  sessionId?: string,
): Promise<HttpResponse> {
  const response = await fetch(`${built.origin}/api/v1/mcp/x/setup`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      accept: MCP_ACCEPT,
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(payload),
  })
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  }
}

function rpcBody(response: HttpResponse): McpRpcResponse {
  const frame = response.body.split('\n').find(line => line.startsWith('data:'))
  return JSON.parse((frame ?? response.body).replace(/^data:\s*/, '')) as McpRpcResponse
}

async function open(built: Built, key: string): Promise<{ sessionId: string; tools: string[] }> {
  const initialized = await request(built, key, INITIALIZE)
  expect(initialized.statusCode).toBe(200)
  const sessionId = initialized.headers['mcp-session-id']
  expect(sessionId).toBeTruthy()
  const listed = await request(built, key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId)
  expect(listed.statusCode).toBe(200)
  const tools = (rpcBody(listed).result?.tools ?? []).map((tool: { name: string }) => tool.name)
  return { sessionId, tools }
}

async function call(
  built: Built,
  key: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const response = await request(built, key, {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'tools/call',
    params: { name, arguments: args },
  }, sessionId)
  expect(response.statusCode).toBe(200)
  return rpcBody(response).result as McpToolResult
}

function textResult(result: McpToolResult): Record<string, unknown> {
  const content = result.content?.find(item => item.type === 'text')
  return JSON.parse(content?.text ?? '{}') as Record<string, unknown>
}

describe('MCP user access tools', () => {
  let built: Built

  beforeEach(async () => {
    built = await buildServer()
  })

  afterEach(async () => {
    await built?.cleanup()
  })

  it('exposes bounded account tools on the setup transport tier', async () => {
    const { tools } = await open(built, built.keys.admin)
    expect(tools).toEqual(expect.arrayContaining([
      'canonry_user_list',
      'canonry_user_update',
      'canonry_user_revoke_access',
      'canonry_user_access_history',
      'canonry_user_invitation_list',
      'canonry_user_invitation_create',
      'canonry_user_invitation_replace',
      'canonry_user_invitation_revoke',
      'canonry_user_google_sign_in_settings_get',
    ]))
  })

  it('lets an active admin manage bounded access state and invalidates a revoked delegated token', async () => {
    const { sessionId } = await open(built, built.keys.admin)

    expect(textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_list')).users)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: built.users.target, role: 'analyst' })]))

    const updated = textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_update', {
      userId: built.users.target,
      request: { role: 'viewer', status: 'active', displayName: 'Target person', email: 'target@example.test' },
    }))
    expect(updated).toMatchObject({ id: built.users.target, role: 'viewer', displayName: 'Target person', email: 'target@example.test' })

    const history = textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_access_history', { userId: built.users.target }))
    expect(history.events).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'user.updated' })]))

    expect(textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_invitation_list')).invitations).toEqual([])
    const created = textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_invitation_create', {
      request: { email: 'invitee@example.test', role: 'analyst' },
    }))
    expect(created.invitation).toMatchObject({ email: 'invitee@example.test', role: 'analyst', status: 'pending' })
    const invitationUrl = new URL(created.invitationUrl)
    expect(invitationUrl.search).toBe('')
    expect(new URLSearchParams(invitationUrl.hash.slice(1)).get('invitation')).toBeTruthy()

    const replaced = textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_invitation_replace', {
      invitationId: created.invitation.id,
    }))
    expect(replaced.invitation).toMatchObject({ email: 'invitee@example.test', status: 'pending' })
    expect(replaced.invitation.id).toBe(created.invitation.id)

    expect(textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_invitation_revoke', {
      invitationId: replaced.invitation.id,
    }))).toMatchObject({ ok: true })

    const google = textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_google_sign_in_settings_get'))
    expect(google).toMatchObject({ enabled: true, configured: true, clientId: 'google-client-id', hasClientSecret: true })
    expect(google).not.toHaveProperty('clientSecret')

    expect(textResult(await call(built, built.keys.admin, sessionId, 'canonry_user_revoke_access', {
      userId: built.users.target,
    }))).toEqual({ revoked: true })
    const revoked = await request(built, built.keys.revokedTarget, INITIALIZE)
    expect(revoked.statusCode).toBe(401)
  })

  it.each([
    ['viewer', () => built.keys.viewer],
    ['analyst', () => built.keys.analyst],
    ['project-scoped admin key', () => built.keys.projectAdmin],
  ])('the server blocks a %s from account administration', async (_label, getKey) => {
    const key = getKey()
    const { sessionId } = await open(built, key)
    const result = await call(built, key, sessionId, 'canonry_user_list')
    expect(result.isError).toBe(true)
    expect(textResult(result).error).toMatchObject({ code: 'FORBIDDEN' })
  })
})
