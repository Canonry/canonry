import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, oauthClients, projects, schedules, users, type DatabaseClient } from '@canonry/canonry-db'
import { createUserSession, hashUserPassword, USER_SESSION_COOKIE_NAME } from '@canonry/canonry-api-routes'
import type { FastifyInstance } from 'fastify'
import { SchedulableRunKinds } from '@canonry/canonry-contracts'

import type { CanonryConfig } from '../src/config.js'
import { handoffTarget } from './oauth-handoff.js'

export interface SyntheticMcpInstance {
  origin: string
  basePath: string
  resource: string
  transportUrl: string
  profileUrl: string
  app: FastifyInstance
  db: DatabaseClient
  rootKey: string
  user: { id: string; name: string; password: string }
  sessionCookie: string
  clientId: string
  redirectUri: string
  restart: () => Promise<void>
  close: () => Promise<void>
}

/** Reserve an ephemeral port before createServer captures its loopback API URL. */
async function unusedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener has no TCP address')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

/**
 * Real engine listener with synthetic data only. Call sequentially: construction
 * temporarily sets CANONRY_CONFIG_DIR so all host configuration stays temporary.
 * The caller must disable telemetry/update checks before importing server modules.
 */
export async function startSyntheticMcpInstance(input: {
  name: string
  basePath?: string
  publicOrigin?: string
}): Promise<SyntheticMcpInstance> {
  if (process.env.CANONRY_TELEMETRY_DISABLED !== '1' || process.env.CANONRY_DISABLE_UPDATE_CHECK !== '1') {
    throw new Error('Synthetic MCP fixtures require disabled telemetry and update checks')
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gateway-fixture-'))
  let db = createClient(path.join(directory, 'fixture.db'))
  migrate(db)
  const port = await unusedPort()
  const origin = `http://127.0.0.1:${port}`
  const basePath = input.basePath ? `/${input.basePath.replace(/^\/+|\/+$/g, '')}` : ''
  const publicOrigin = input.publicOrigin ?? origin
  const rootKey = `cnry_${crypto.randomBytes(24).toString('hex')}`
  const user = { id: crypto.randomUUID(), name: 'Synthetic reader', password: 'synthetic-fixture-only-password' }
  const now = new Date().toISOString()
  db.insert(users).values({
    id: user.id, name: user.name, nameKey: user.name.toLowerCase(),
    passwordHash: await hashUserPassword(user.password), role: 'viewer', createdAt: now,
  }).run()
  const clientId = 'synthetic-gateway-client'
  const redirectUri = 'https://gateway.example/oauth/upstream/callback'
  db.insert(oauthClients).values({
    id: clientId, name: 'Synthetic gateway', redirectUris: [redirectUri], createdAt: now,
  }).run()
  const config: CanonryConfig = {
    apiUrl: `${origin}${basePath}`, basePath: basePath || undefined,
    publicUrl: `${publicOrigin}${basePath}`, database: path.join(directory, 'fixture.db'),
    apiKey: rootKey, providers: {}, agent: { mode: 'disabled' },
    telemetry: false, updateCheck: false,
    dashboard: { managedSweeps: false }, research: { allowViewers: false },
  }
  fs.writeFileSync(path.join(directory, 'config.yaml'), JSON.stringify(config))
  async function boot(): Promise<FastifyInstance> {
    const previousConfigDir = process.env.CANONRY_CONFIG_DIR
    const previousBasePath = process.env.CANONRY_BASE_PATH
    let app: FastifyInstance | undefined
    try {
      process.env.CANONRY_CONFIG_DIR = directory
      process.env.CANONRY_BASE_PATH = basePath
      const { createServer, waitForServerRuntimeStartup } = await import('../src/server.js')
      app = await createServer({ config, db, logger: false, host: '127.0.0.1' })
      await app.listen({ host: '127.0.0.1', port })
      await waitForServerRuntimeStartup(app)
      return app
    } catch (error) {
      await app?.close()
      db.$client.close()
      fs.rmSync(directory, { recursive: true, force: true })
      throw error
    } finally {
      if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
      else process.env.CANONRY_CONFIG_DIR = previousConfigDir
      if (previousBasePath === undefined) delete process.env.CANONRY_BASE_PATH
      else process.env.CANONRY_BASE_PATH = previousBasePath
    }
  }
  let runningApp = await boot()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: input.name, displayName: input.name,
    canonicalDomain: `${input.name}.example`, country: 'US', language: 'en',
    providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: crypto.randomUUID(), projectId, kind: SchedulableRunKinds.doctor,
    cronExpr: '0 */6 * * *', enabled: false, createdAt: now, updatedAt: now,
  }).run()
  return {
    get app() { return runningApp },
    get db() { return db },
    origin, basePath, rootKey, user, clientId, redirectUri,
    resource: `${publicOrigin}${basePath}/api/v1/mcp`,
    transportUrl: `${origin}${basePath}/api/v1/mcp/readonly`,
    profileUrl: `${origin}${basePath}/api/v1/mcp/profile`,
    sessionCookie: `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, user.id)}`,
    restart: async () => {
      await runningApp.close()
      db.$client.close()
      db = createClient(config.database)
      migrate(db)
      runningApp = await boot()
    },
    close: async () => {
      await runningApp.close()
      db.$client.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

export interface SyntheticOAuthTokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

/** Obtain real tokens through consent and S256 PKCE, without a token-store shortcut. */
export async function authorizeSyntheticMcp(instance: SyntheticMcpInstance, scope = 'read offline_access'): Promise<SyntheticOAuthTokens> {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code', client_id: instance.clientId, redirect_uri: instance.redirectUri,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: instance.resource, scope,
    state: crypto.randomBytes(16).toString('hex'),
  })
  const authorization = `${instance.origin}${instance.basePath}/oauth/authorize`
  const consent = await fetch(`${authorization}?${query}`, { headers: { cookie: instance.sessionCookie } })
  const html = await consent.text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  if (consent.status !== 200 || !csrf) throw new Error(`Synthetic consent failed: ${consent.status}`)
  const approved = await fetch(`${authorization}/consent?${query}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: instance.sessionCookie, origin: instance.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, approve: 'yes' }),
  })
  const code = approved.status === 200 ? handoffTarget(await approved.text()).searchParams.get('code') : null
  if (!code) throw new Error(`Synthetic approval failed: ${approved.status}`)
  const response = await fetch(`${instance.origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: instance.clientId, redirect_uri: instance.redirectUri,
      code, code_verifier: verifier, resource: instance.resource,
    }),
  })
  if (!response.ok) throw new Error(`Synthetic token exchange failed: ${response.status}`)
  return await response.json() as SyntheticOAuthTokens
}
