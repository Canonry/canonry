import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AppError,
  GoogleMarketingProviders,
  RunKinds,
  RunStatuses,
  RunTriggers,
  UserRoles,
  type ConversionTrackingIntegrityAssessmentDto,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  migrate,
  projects,
  runs,
  users,
} from '@ainyc/canonry-db'
import { shouldSkipAuth } from '../src/auth.js'
import {
  googleMarketingRoutes,
  type GoogleMarketingStoredCredential,
} from '../src/google-marketing.js'

const NOW = '2026-08-14T12:00:00.000Z'
const SHA = 'a'.repeat(64)

interface TestContext {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  credentials: Map<string, GoogleMarketingStoredCredential>
  credentialWrites: GoogleMarketingStoredCredential[]
  oauthExchanges: string[]
  liveCalls: string[]
  syncRequests: Array<{ runId: string; projectId: string }>
  setScopes(scopes: string[]): void
  setProjectScopedKey(value: boolean): void
  setViewer(value: boolean): void
  setOAuthPrincipal(mode: 'browser-admin' | 'other-browser-admin' | 'project-key' | 'bearer-key'): void
  setHasGoogleAdsDeveloperToken(value: boolean): void
  failOAuthStart(value: boolean): void
  failOAuthExchange(value: boolean): void
  setOAuthRefreshToken(value: string | null): void
  delayOAuthExchange(): Promise<void>
  resumeOAuthExchange(): void
}

function credentialKey(projectId: string, provider: string): string {
  return `${projectId}:${provider}`
}

function oauthBindingCookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie']
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  const binding = cookies.find(cookie => cookie.startsWith('canonry_google_marketing_oauth_'))
  expect(binding).toBeTruthy()
  return binding!.split(';', 1)[0]!
}

function oauthConfirmationId(response: { body: string }): string {
  const match = response.body.match(/\/google-marketing\/callback\/confirm\/([\w-]{43})/)
  expect(match?.[1]).toBeTruthy()
  return match![1]!
}

async function confirmGoogleMarketingOAuth(ctx: TestContext, callback: { body: string }) {
  return ctx.app.inject({
    method: 'POST',
    url: `/google-marketing/callback/confirm/${oauthConfirmationId(callback)}`,
    headers: {
      host: 'canonry.example',
      origin: 'https://canonry.example',
      cookie: 'canonry_test_browser_session=present',
      // What the confirmation page's own `<form method="post">` sends. Omitting
      // it made every confirm assertion below pass against a request no browser
      // produces: with no content-type Fastify skips body parsing entirely, so
      // the suite was green while the real button answered 415 and no Google
      // Ads or GTM connection could be completed on any install.
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: '',
  })
}

interface BuildAppOptions {
  includeLiveReader?: boolean
  /** Make discovery throw, mirroring a real Google setup failure. */
  liveReaderError?: Error
  publicUrl?: string | null
  routePrefix?: string
}

function buildApp({
  includeLiveReader = true,
  liveReaderError,
  publicUrl = 'https://canonry.example',
  routePrefix,
}: BuildAppOptions = {}): TestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-marketing-routes-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_acme', name: 'acme', displayName: 'Acme',
    canonicalDomain: 'https://acme.example', country: 'US', language: 'en',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(users).values([
    { id: 'admin', name: 'admin', nameKey: 'admin', role: UserRoles.admin, createdAt: NOW, permissionsMigrated: true },
    { id: 'other-admin', name: 'other admin', nameKey: 'other-admin', role: UserRoles.admin, createdAt: NOW, permissionsMigrated: true },
  ]).run()

  const credentials = new Map<string, GoogleMarketingStoredCredential>()
  const credentialWrites: GoogleMarketingStoredCredential[] = []
  const oauthExchanges: string[] = []
  const liveCalls: string[] = []
  const syncRequests: Array<{ runId: string; projectId: string }> = []
  let scopes = ['*']
  let projectScopedKey = false
  let viewer = false
  let oauthPrincipal: 'browser-admin' | 'other-browser-admin' | 'project-key' | 'bearer-key' = 'browser-admin'
  let hasGoogleAdsDeveloperToken = false
  let oauthStartFails = false
  let oauthExchangeFails = false
  let oauthRefreshToken: string | null = 'refresh-token'
  let exchangeStarted: (() => void) | null = null
  let resumeExchange: (() => void) | null = null
  let waitForExchange = false
  const app = Fastify()
  app.decorate('db', db)
  app.addHook('onRequest', async (request) => {
    const isOAuthStart = request.url.includes('/google-ads/oauth/connect') || request.url.includes('/gtm/oauth/connect')
    const isOAuthConfirm = request.url.includes('/google-marketing/callback/confirm/')
    if (isOAuthStart || isOAuthConfirm) {
      switch (oauthPrincipal) {
        case 'browser-admin':
          request.principal = { kind: 'user', id: 'admin', name: 'admin', scopes: ['*'], role: UserRoles.admin, viaCookie: true }
          return
        case 'other-browser-admin':
          request.principal = { kind: 'user', id: 'other-admin', name: 'other admin', scopes: ['*'], role: UserRoles.admin, viaCookie: true }
          return
        case 'project-key':
          request.principal = {
            kind: 'api-key', id: 'test-key', name: 'test key', scopes, projectId: 'project_acme', viaCookie: true,
          }
          return
        case 'bearer-key':
          request.principal = { kind: 'api-key', id: 'test-key', name: 'test key', scopes, viaCookie: false }
          return
      }
    }
    request.principal = viewer
      ? { kind: 'user', id: 'viewer', name: 'viewer', scopes: ['*'], role: UserRoles.viewer, viaCookie: true }
      : {
          kind: 'api-key', id: 'test-key', name: 'test key', scopes,
          ...(projectScopedKey ? { projectId: 'project_acme' } : {}), viaCookie: false,
        }
    request.apiKey = !viewer && projectScopedKey
      ? { id: 'test-key', name: 'test key', scopes, projectId: 'project_acme' }
      : undefined
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    throw error
  })
  app.register(googleMarketingRoutes, {
    googleStateSecret: 'google-marketing-test-state-secret',
    ...(publicUrl === null ? {} : { publicUrl }),
    ...(routePrefix === undefined ? {} : { routePrefix }),
    googleMarketingOAuthScopes: {
      [GoogleMarketingProviders['google-ads']]: ['https://www.googleapis.com/auth/adwords'],
      [GoogleMarketingProviders.gtm]: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    },
    googleMarketingCredentialStore: {
      get: (project, provider) => credentials.get(credentialKey(project.id, provider)),
      upsert: (project, provider, credential) => {
        credentialWrites.push(credential)
        credentials.set(credentialKey(project.id, provider), credential)
      },
      delete: (project, provider) => credentials.delete(credentialKey(project.id, provider)),
      hasGoogleAdsDeveloperToken: () => hasGoogleAdsDeveloperToken,
    },
    googleMarketingOAuth: {
      authorizationUrl: ({ state }) => {
        if (oauthStartFails) throw new Error('test OAuth start failure')
        return `https://accounts.example/authorize?state=${encodeURIComponent(state)}`
      },
      exchangeCode: async ({ provider, code }) => {
        oauthExchanges.push(`${provider}:${code}`)
        if (oauthExchangeFails) throw new Error('test OAuth exchange failure')
        if (waitForExchange) {
          exchangeStarted?.()
          await new Promise<void>((resolve) => { resumeExchange = resolve })
          waitForExchange = false
          resumeExchange = null
        }
        return {
          accessToken: `${provider}-${code}-access`,
          ...(oauthRefreshToken === null ? {} : { refreshToken: oauthRefreshToken }),
          expiresAt: '2026-08-14T13:00:00.000Z', scopes: [`${provider}-scope`],
        }
      },
    },
    ...(includeLiveReader ? {
      googleMarketingLiveReader: {
        listGoogleAdsCustomers: async () => {
          liveCalls.push('google-ads-customers')
          if (liveReaderError) throw liveReaderError
          return {
            customers: [], totalAccessible: 0, truncated: false,
            selection: { loginCustomerId: null, customerId: null, selectedAt: null }, fetchedAt: NOW,
          }
        },
        listGtmAccounts: async () => {
          liveCalls.push('gtm-accounts')
          return { accounts: [], totalAccessible: 0, truncated: false, fetchedAt: NOW }
        },
        listGtmContainers: async (_project, accountId) => {
          liveCalls.push(`gtm-containers:${accountId}`)
          return { accountId, containers: [], totalAccessible: 0, truncated: false, fetchedAt: NOW }
        },
        listGtmWorkspaces: async (_project, accountId, containerId) => {
          liveCalls.push(`gtm-workspaces:${accountId}:${containerId}`)
          return { accountId, containerId, workspaces: [], totalAccessible: 0, truncated: false, fetchedAt: NOW }
        },
      },
    } : {}),
    onGoogleAdsSyncRequested: (runId, projectId) => {
      // Dispatch happens after the transaction; the runner can immediately
      // resolve the durable run ID without observing a half-created row.
      expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({ projectId, status: 'queued' })
      syncRequests.push({ runId, projectId })
    },
    assessConversionTrackingIntegrity: async ({ contract }): Promise<ConversionTrackingIntegrityAssessmentDto> => ({
      contract, status: 'statically-consistent', findings: [], evaluatedAt: NOW,
    }),
  })

  return {
    app, db, tmpDir, credentials, credentialWrites, oauthExchanges, liveCalls, syncRequests,
    setScopes(next) { scopes = next },
    setProjectScopedKey(value) { projectScopedKey = value },
    setViewer(value) { viewer = value },
    setOAuthPrincipal(mode) { oauthPrincipal = mode },
    setHasGoogleAdsDeveloperToken(value) { hasGoogleAdsDeveloperToken = value },
    failOAuthStart(value) { oauthStartFails = value },
    failOAuthExchange(value) { oauthExchangeFails = value },
    setOAuthRefreshToken(value) { oauthRefreshToken = value },
    delayOAuthExchange() {
      waitForExchange = true
      return new Promise<void>((resolve) => { exchangeStarted = resolve })
    },
    resumeOAuthExchange() { resumeExchange?.() },
  }
}

async function connectGoogleAds(ctx: TestContext): Promise<void> {
  const start = await ctx.app.inject({
    method: 'POST',
    url: '/projects/acme/google-ads/oauth/connect',
    payload: { provider: 'google-ads', developerToken: 'developer-token-never-returned' },
  })
  expect(start.statusCode).toBe(200)
  expect(start.body).not.toContain('developer-token-never-returned')
  const cookie = oauthBindingCookie(start)
  const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
  expect(state).toBeTruthy()
  const callback = await ctx.app.inject({
    method: 'GET',
    url: `/google-marketing/callback?code=good-code&state=${encodeURIComponent(state!)}`,
    headers: { cookie },
  })
  expect(callback.statusCode).toBe(200)
  expect(callback.headers['content-type']).toContain('text/html')
  const confirmed = await confirmGoogleMarketingOAuth(ctx, callback)
  expect(confirmed.statusCode).toBe(200)
}

describe('Google Marketing routes', () => {
  const contexts: TestContext[] = []

  afterEach(async () => {
    while (contexts.length > 0) {
      const context = contexts.pop()!
      await context.app.close()
      fs.rmSync(context.tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps the shared callback narrowly unauthenticated', () => {
    expect(shouldSkipAuth('/api/v1/google-marketing/callback')).toBe(true)
    expect(shouldSkipAuth('/api/v1/google-marketing/callback/extra')).toBe(false)
    expect(shouldSkipAuth('/api/v1/projects/acme/google-marketing/callback')).toBe(true)
  })

  it('uses configured deployment bases once and preserves the mounted callback cookie path', async () => {
    const context = buildApp({
      publicUrl: 'https://canonry.example/canonry',
      routePrefix: '/canonry/api/v1',
    })
    contexts.push(context)
    await context.app.ready()

    const configured = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-configured-base' },
    })
    expect(configured.statusCode).toBe(200)
    expect(configured.json()).toMatchObject({
      redirectUri: 'https://canonry.example/canonry/api/v1/google-marketing/callback',
    })
    expect(String(configured.headers['set-cookie']))
      .toContain('Path=/canonry/api/v1/google-marketing/callback')

    const override = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: {
        provider: 'google-ads',
        developerToken: 'developer-token-body-base',
        publicUrl: 'https://operator.example/control-plane',
      },
    })
    expect(override.statusCode).toBe(200)
    expect(override.json()).toMatchObject({
      redirectUri: 'https://operator.example/control-plane/api/v1/google-marketing/callback',
    })

    const headerDerived = buildApp({ publicUrl: null, routePrefix: '/canonry/api/v1' })
    contexts.push(headerDerived)
    await headerDerived.app.ready()
    const derived = await headerDerived.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      headers: { host: 'local.example', 'x-forwarded-proto': 'https' },
      payload: { provider: 'google-ads', developerToken: 'developer-token-header-base' },
    })
    expect(derived.statusCode).toBe(200)
    expect(derived.json()).toMatchObject({
      redirectUri: 'https://local.example/canonry/api/v1/google-marketing/callback',
    })
  })

  it('persists a supplied Ads developer token only after one successful OAuth callback', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const developerToken = 'developer-token-pending-only'
    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken },
    })
    expect(start.statusCode).toBe(200)
    expect(start.body).not.toContain(developerToken)
    expect(context.credentials).toHaveLength(0)
    expect(context.credentialWrites).toHaveLength(0)
    const cookie = oauthBindingCookie(start)
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    const callback = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=good-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(callback.statusCode).toBe(200)
    expect(context.oauthExchanges).toEqual(['google-ads:good-code'])
    expect(context.credentialWrites).toHaveLength(0)
    const confirmed = await confirmGoogleMarketingOAuth(context, callback)
    expect(confirmed.statusCode).toBe(200)
    expect(context.credentialWrites).toHaveLength(1)
    expect(context.credentials.get(credentialKey('project_acme', 'google-ads'))).toMatchObject({
      accessToken: 'google-ads-good-code-access', developerToken,
    })

    const replay = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=second-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(replay.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual(['google-ads:good-code'])
    expect(context.credentialWrites).toHaveLength(1)
  })

  it('fails closed when a reconnect exchange omits a fresh refresh token', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    await connectGoogleAds(context)

    const key = credentialKey('project_acme', 'google-ads')
    const existing = context.credentials.get(key)
    expect(existing).toBeDefined()
    const existingSnapshot = { ...existing! }
    context.setOAuthRefreshToken(null)

    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-reconnect' },
    })
    expect(start.statusCode).toBe(200)
    const cookie = oauthBindingCookie(start)
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    const callback = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=missing-refresh-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(callback.statusCode).toBe(400)
    expect(callback.body).toContain('offline access')
    expect(callback.body).not.toContain('/google-marketing/callback/confirm/')
    expect(context.credentials.get(key)).toEqual(existingSnapshot)
    expect(context.credentialWrites).toHaveLength(1)

    const replay = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=replay-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(replay.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual([
      'google-ads:good-code',
      'google-ads:missing-refresh-code',
    ])
  })

  it('replaces the prior refresh token after a successful reconnect', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    await connectGoogleAds(context)

    const key = credentialKey('project_acme', 'google-ads')
    const original = context.credentials.get(key)
    expect(original?.refreshToken).toBe('refresh-token')
    context.setOAuthRefreshToken('new-refresh-token')

    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-fresh-reconnect' },
    })
    const cookie = oauthBindingCookie(start)
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()
    const callback = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=fresh-reconnect-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(callback.statusCode).toBe(200)
    const confirmed = await confirmGoogleMarketingOAuth(context, callback)
    expect(confirmed.statusCode).toBe(200)
    expect(context.credentials.get(key)).toMatchObject({
      accessToken: 'google-ads-fresh-reconnect-code-access',
      refreshToken: 'new-refresh-token',
    })
  })

  it('starts a new selection generation and clears resource evidence on OAuth reconnect', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    context.db.insert(googleAdsConnections).values({
      id: 'ads-reconnect', projectId: 'project_acme', selectedLoginCustomerId: '1112223333',
      selectedCustomerId: '1234567890', selectedCustomerName: 'Old Ads', selectionGeneration: 7,
      lastCustomerSnapshotId: 'old-customer', lastInventorySnapshotAt: NOW,
      lastInventorySnapshotId: 'old-inventory', lastMetricsSnapshotAt: NOW,
      lastMetricsSnapshotId: 'old-metrics', scopes: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    context.db.insert(gtmConnections).values({
      id: 'gtm-reconnect', projectId: 'project_acme', selectedAccountId: 'account_1',
      selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1', selectionGeneration: 11,
      lastSnapshotAt: NOW, lastSnapshotId: 'old-gtm-snapshot', scopes: [], createdAt: NOW, updatedAt: NOW,
    }).run()

    const reconnect = async (provider: 'google-ads' | 'gtm') => {
      const start = await context.app.inject({
        method: 'POST', url: `/projects/acme/${provider}/oauth/connect`,
        payload: provider === 'google-ads'
          ? { provider, developerToken: 'developer-token-reconnect' }
          : { provider },
      })
      expect(start.statusCode).toBe(200)
      const cookie = oauthBindingCookie(start)
      const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
      expect(state).toBeTruthy()
      const callback = await context.app.inject({
        method: 'GET',
        url: `/google-marketing/callback?code=${provider}-reconnect&state=${encodeURIComponent(state!)}`,
        headers: { cookie },
      })
      expect(callback.statusCode).toBe(200)
      expect((await confirmGoogleMarketingOAuth(context, callback)).statusCode).toBe(200)
    }

    await reconnect('google-ads')
    expect(context.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.id, 'ads-reconnect')).get()).toMatchObject({
      selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
      selectionGeneration: 8, lastCustomerSnapshotId: null,
      lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
      lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null,
    })

    await reconnect('gtm')
    expect(context.db.select().from(gtmConnections)
      .where(eq(gtmConnections.id, 'gtm-reconnect')).get()).toMatchObject({
      selectedAccountId: null, selectedContainerId: null, selectedWorkspaceId: null,
      selectionGeneration: 12, lastSnapshotAt: null, lastSnapshotId: null,
    })
  })

  it('requires the same browser-bound OAuth cookie before consuming state', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-browser-bound' },
    })
    expect(start.statusCode).toBe(200)
    const cookie = oauthBindingCookie(start)
    expect(cookie).toContain('canonry_google_marketing_oauth_')
    expect(String(start.headers['set-cookie'])).toContain('HttpOnly')
    expect(String(start.headers['set-cookie'])).toContain('SameSite=Lax')
    expect(String(start.headers['set-cookie'])).toContain('Secure')
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    const leakedElsewhere = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=attacker-code&state=${encodeURIComponent(state!)}`,
    })
    expect(leakedElsewhere.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual([])
    expect(context.credentialWrites).toHaveLength(0)

    const wrongBrowser = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=attacker-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie: 'canonry_google_marketing_oauth_unrelated=wrong' },
    })
    expect(wrongBrowser.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual([])
    expect(context.credentialWrites).toHaveLength(0)

    const callback = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=good-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(callback.statusCode).toBe(200)
    expect(String(callback.headers['set-cookie'])).toContain('Max-Age=0')
    expect(context.oauthExchanges).toEqual(['google-ads:good-code'])
    expect(context.credentialWrites).toHaveLength(0)

    const noOrigin = await context.app.inject({
      method: 'POST',
      url: `/google-marketing/callback/confirm/${oauthConfirmationId(callback)}`,
      headers: { host: 'canonry.example' },
    })
    expect(noOrigin.statusCode).toBe(403)
    expect(context.credentialWrites).toHaveLength(0)

    context.setOAuthPrincipal('other-browser-admin')
    const wrongInitiator = await confirmGoogleMarketingOAuth(context, callback)
    expect(wrongInitiator.statusCode).toBe(400)
    expect(context.credentialWrites).toHaveLength(0)

    context.setOAuthPrincipal('browser-admin')
    const confirmed = await confirmGoogleMarketingOAuth(context, callback)
    expect(confirmed.statusCode).toBe(200)
    expect(context.credentialWrites).toHaveLength(1)
  })

  it('invalidates prior and disconnected OAuth starts before a callback can recreate a connection', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const first = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-first-flow' },
    })
    const firstCookie = oauthBindingCookie(first)
    const firstState = new URL(first.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(firstState).toBeTruthy()

    const second = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-second-flow' },
    })
    const secondCookie = oauthBindingCookie(second)
    const secondState = new URL(second.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(secondState).toBeTruthy()

    const superseded = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=first-code&state=${encodeURIComponent(firstState!)}`,
      headers: { cookie: firstCookie },
    })
    expect(superseded.statusCode).toBe(400)

    const disconnect = await context.app.inject({ method: 'DELETE', url: '/projects/acme/google-ads/connection' })
    expect(disconnect.statusCode).toBe(200)
    const afterDisconnect = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=second-code&state=${encodeURIComponent(secondState!)}`,
      headers: { cookie: secondCookie },
    })
    expect(afterDisconnect.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual([])
    expect(context.credentialWrites).toHaveLength(0)
  })

  it('does not persist an exchanged code after disconnect invalidates its generation', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-delayed-exchange' },
    })
    const cookie = oauthBindingCookie(start)
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    const exchangeStarted = context.delayOAuthExchange()
    const callbackPromise = context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=delayed-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    await exchangeStarted

    const disconnect = await context.app.inject({ method: 'DELETE', url: '/projects/acme/google-ads/connection' })
    expect(disconnect.statusCode).toBe(200)
    context.resumeOAuthExchange()

    const callback = await callbackPromise
    expect(callback.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual(['google-ads:delayed-code'])
    expect(context.credentialWrites).toHaveLength(0)
    expect(context.db.select().from(googleAdsConnections).all()).toEqual([])
  })

  it('leaves no credential behind when OAuth start or code exchange fails', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    context.failOAuthStart(true)
    const failedStart = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-failed-start' },
    })
    expect(failedStart.statusCode).toBe(502)
    expect(context.credentials).toHaveLength(0)
    expect(context.credentialWrites).toHaveLength(0)

    context.failOAuthStart(false)
    const start = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'developer-token-failed-callback' },
    })
    expect(start.statusCode).toBe(200)
    const cookie = oauthBindingCookie(start)
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get('state')
    expect(state).toBeTruthy()

    context.failOAuthExchange(true)
    const failedCallback = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=bad-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(failedCallback.statusCode).toBe(502)
    expect(context.credentials).toHaveLength(0)
    expect(context.credentialWrites).toHaveLength(0)

    context.failOAuthExchange(false)
    const replayAfterFailure = await context.app.inject({
      method: 'GET',
      url: `/google-marketing/callback?code=good-code&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    })
    expect(replayAfterFailure.statusCode).toBe(400)
    expect(context.oauthExchanges).toEqual(['google-ads:bad-code'])
  })

  it('requires broad instance authority to supply a global Ads developer token', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    context.setScopes(['*'])
    context.setOAuthPrincipal('bearer-key')
    const bearerDenied = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'bearer-key-cannot-start-browser-oauth' },
    })
    expect(bearerDenied.statusCode).toBe(403)

    context.setScopes(['google-marketing.write'])
    context.setOAuthPrincipal('project-key')
    const denied = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads', developerToken: 'project-key-cannot-set-global-token' },
    })
    expect(denied.statusCode).toBe(403)
    expect(context.credentials).toHaveLength(0)
    expect(context.credentialWrites).toHaveLength(0)

    // A project-scoped integration key can still start its own OAuth flow
    // when the host confirms a preconfigured install-global developer token.
    context.setHasGoogleAdsDeveloperToken(true)
    const existingGlobalToken = await context.app.inject({
      method: 'POST',
      url: '/projects/acme/google-ads/oauth/connect',
      payload: { provider: 'google-ads' },
    })
    expect(existingGlobalToken.statusCode).toBe(200)
    expect(context.credentials).toHaveLength(0)
    expect(context.credentialWrites).toHaveLength(0)
  })

  it('stores OAuth material only in the injected credential store and requires stored evidence for connected status', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()

    await connectGoogleAds(context)
    const credential = context.credentials.get(credentialKey('project_acme', 'google-ads'))
    expect(credential).toMatchObject({
      accessToken: 'google-ads-good-code-access', developerToken: 'developer-token-never-returned',
    })
    const initial = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/status' })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toMatchObject({ connected: true, status: 'selection-required' })

    const selected = await context.app.inject({
      method: 'PUT', url: '/projects/acme/google-ads/selection',
      payload: { customerId: '123-456-7890', loginCustomerId: null },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toMatchObject({ connected: true, status: 'selection-required' })

    const connection = context.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, 'project_acme')).get()!
    expect(connection.selectedCustomerId).toBe('1234567890')

    // Selecting a customer clears every snapshot pointer, so without this the
    // operator is left connected with no data and every downstream surface has
    // to invent copy for it. Selection queues the sync itself.
    const queuedSync = context.db.select().from(runs)
      .where(eq(runs.kind, RunKinds['google-ads-sync'])).all()
    expect(queuedSync.length).toBeGreaterThan(0)

    // Reselecting must queue a SUCCESSOR, never reuse the in-flight run.
    // Selection bumps selectionGeneration and the sync worker CAS-writes gated
    // on it, so a run queued before this selection is already doomed; reusing
    // it would leave the new selection with no sync at all.
    const before = queuedSync.length
    const reselected = await context.app.inject({
      method: 'PUT', url: '/projects/acme/google-ads/selection',
      payload: { customerId: '123-456-7890', loginCustomerId: null },
    })
    expect(reselected.statusCode).toBe(200)
    const afterRuns = context.db.select().from(runs)
      .where(eq(runs.kind, RunKinds['google-ads-sync'])).all()
    expect(afterRuns.length).toBe(before + 1)
    const capturedAt = connection.lastValidatedAt ?? NOW
    context.db.insert(runs).values({
      id: 'ads-sync-1', projectId: 'project_acme', kind: RunKinds['google-ads-sync'],
      status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW,
    }).run()
    context.db.insert(googleAdsRawSnapshots).values({
      id: 'ads-snapshot-1', projectId: 'project_acme', connectionId: connection.id,
      runId: 'ads-sync-1', kind: 'accessible-customers', customerId: '1234567890',
      payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null, redactedFieldCount: 0,
      payload: {
        kind: 'accessible-customers',
        data: {
          customers: [{
            resourceName: 'customers/1234567890', customerId: '1234567890', parentCustomerId: null,
            descriptiveName: 'Acme Ads', currencyCode: 'USD', timeZone: 'America/New_York',
            manager: false, hidden: false, testAccount: false, level: 0, status: 'enabled',
          }],
          totalAccessible: 1, truncated: false,
          selection: { loginCustomerId: null, customerId: '1234567890', selectedAt: capturedAt },
          fetchedAt: capturedAt,
        },
      },
      capturedAt, createdAt: capturedAt,
    }).run()
    // A migration-era timestamp alone cannot prove this observation belongs to
    // the current selection generation.
    const unanchored = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/status' })
    expect(unanchored.statusCode).toBe(200)
    expect(unanchored.json()).toMatchObject({ connected: true, status: 'selection-required' })
    context.db.update(googleAdsConnections).set({ lastCustomerSnapshotId: 'ads-snapshot-1' })
      .where(eq(googleAdsConnections.id, connection.id)).run()

    const connected = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/status' })
    expect(connected.statusCode).toBe(200)
    expect(connected.json()).toMatchObject({
      connected: true, status: 'connected', selectedCustomer: { customerId: '1234567890' },
    })
    const list = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/snapshots?limit=1' })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({ total: 1, snapshots: [{ id: 'ads-snapshot-1' }] })
    const snapshot = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/snapshots/ads-snapshot-1' })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json()).toMatchObject({ snapshot: { payload: { kind: 'accessible-customers' } } })
  })

  it('persists canonical Google Ads and scoped GTM resource selections', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    const credential = {
      accessToken: 'test-access-token', refreshToken: 'test-refresh-token', scopes: [],
      createdAt: NOW, updatedAt: NOW,
    }
    context.credentials.set(credentialKey('project_acme', 'google-ads'), credential)
    context.credentials.set(credentialKey('project_acme', 'gtm'), credential)
    context.db.insert(googleAdsConnections).values({
      id: 'ads-selection-canonical', projectId: 'project_acme', scopes: [],
      lastValidatedAt: NOW, lastCustomerSnapshotId: 'old-customer-snapshot',
      lastInventorySnapshotAt: NOW, lastInventorySnapshotId: 'old-inventory-snapshot',
      lastMetricsSnapshotAt: NOW, lastMetricsSnapshotId: 'old-metrics-snapshot',
      createdAt: NOW, updatedAt: NOW,
    }).run()
    context.db.insert(gtmConnections).values({
      id: 'gtm-selection-canonical', projectId: 'project_acme', scopes: [],
      selectedAccountId: '1', selectedContainerId: '2', selectedWorkspaceId: 'old-workspace',
      selectedWorkspaceName: 'Old workspace', lastSnapshotAt: NOW,
      createdAt: NOW, updatedAt: NOW,
    }).run()

    const ads = await context.app.inject({
      method: 'PUT',
      url: '/projects/acme/google-ads/selection',
      payload: { customerId: '123-456-7890', loginCustomerId: '111-222-3333' },
    })
    expect(ads.statusCode).toBe(200)

    const gtm = await context.app.inject({
      method: 'PUT',
      url: '/projects/acme/gtm/selection',
      payload: {
        accountId: 'accounts/1',
        containerId: 'accounts/1/containers/2',
        workspaceId: 'accounts/1/containers/2/workspaces/3',
      },
    })
    expect(gtm.statusCode).toBe(200)

    expect(context.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.id, 'ads-selection-canonical')).get()).toMatchObject({
      selectedLoginCustomerId: '1112223333',
      selectedCustomerId: '1234567890',
      selectionGeneration: 1,
      lastCustomerSnapshotId: null,
      lastInventorySnapshotAt: null,
      lastInventorySnapshotId: null,
      lastMetricsSnapshotAt: null,
      lastMetricsSnapshotId: null,
    })
    expect(context.db.select().from(gtmConnections)
      .where(eq(gtmConnections.id, 'gtm-selection-canonical')).get()).toMatchObject({
      selectedAccountId: '1',
      selectedContainerId: '2',
      selectedWorkspaceId: '3',
      selectedWorkspaceName: null,
      selectionGeneration: 1,
      lastSnapshotAt: null,
      lastSnapshotId: null,
    })
  })

  it('requires exact GTM snapshot provenance after a same-millisecond workspace reselection', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    context.credentials.set(credentialKey('project_acme', 'gtm'), {
      accessToken: 'gtm-access-token', scopes: [], createdAt: NOW, updatedAt: NOW,
    })
    context.db.insert(runs).values({
      id: 'gtm-provenance-run', projectId: 'project_acme', kind: RunKinds['gtm-sync'],
      status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW,
    }).run()
    context.db.insert(gtmConnections).values({
      id: 'gtm-provenance-connection', projectId: 'project_acme',
      selectedAccountId: 'account_1', selectedContainerId: 'container_1',
      selectedWorkspaceId: 'workspace_2', scopes: [],
      lastValidatedAt: NOW, lastSnapshotAt: NOW,
      lastSnapshotId: 'gtm-provenance-current-workspace', createdAt: NOW, updatedAt: NOW,
    }).run()

    const payload = (workspaceId: string) => ({
      kind: 'container' as const,
      data: {
        account: { id: 'account_1', path: 'accounts/account_1', name: 'Acme', shareData: null },
        container: {
          accountId: 'account_1', id: 'container_1',
          path: 'accounts/account_1/containers/container_1', name: 'Web', publicId: 'GTM-ACME',
          domainName: 'acme.example', usageContexts: ['web'],
        },
        workspaces: [{
          accountId: 'account_1', containerId: 'container_1', id: workspaceId,
          path: `accounts/account_1/containers/container_1/workspaces/${workspaceId}`,
          name: workspaceId, description: null, fingerprint: null,
        }],
        live: null, draft: null, fetchedAt: NOW,
      },
    })
    const insertSnapshot = (id: string, workspaceId: string) => {
      context.db.insert(gtmRawSnapshots).values({
        id, projectId: 'project_acme', connectionId: 'gtm-provenance-connection',
        runId: 'gtm-provenance-run', kind: 'container', accountId: 'account_1',
        containerId: 'container_1', workspaceId, payloadChecksum: SHA,
        rawPayloadSha256: null, rawPayloadBytes: null, redactedFieldCount: 0,
        capturedAt: NOW, createdAt: NOW, payload: payload(workspaceId),
      }).run()
    }

    // Timestamp equality alone cannot distinguish the old workspace snapshot.
    insertSnapshot('gtm-provenance-old-workspace', 'workspace_1')
    const mismatchedWorkspace = await context.app.inject({
      method: 'GET', url: '/projects/acme/gtm/status',
    })
    expect(mismatchedWorkspace.statusCode).toBe(200)
    expect(mismatchedWorkspace.json()).toMatchObject({
      connected: true, status: 'stale', selection: { workspaceId: 'workspace_2' },
    })

    // The old and new selection can have the same timestamp and exact resource
    // IDs. Only the connection's exact snapshot anchor distinguishes them.
    insertSnapshot('gtm-provenance-old-current-workspace', 'workspace_2')
    const oldCurrentSelection = await context.app.inject({ method: 'GET', url: '/projects/acme/gtm/status' })
    expect(oldCurrentSelection.statusCode).toBe(200)
    expect(oldCurrentSelection.json()).toMatchObject({ connected: true, status: 'stale' })

    insertSnapshot('gtm-provenance-current-workspace', 'workspace_2')
    const current = await context.app.inject({ method: 'GET', url: '/projects/acme/gtm/status' })
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({
      connected: true, status: 'connected', selection: { workspaceId: 'workspace_2' },
    })

    // A same-value write is also a new selection generation.
    const sameSelection = await context.app.inject({
      method: 'PUT', url: '/projects/acme/gtm/selection',
      payload: {
        accountId: 'account_1', containerId: 'container_1', workspaceId: 'workspace_2',
      },
    })
    expect(sameSelection.statusCode).toBe(200)
    expect(sameSelection.json()).toMatchObject({ connected: true, status: 'stale' })
    expect(context.db.select().from(gtmConnections)
      .where(eq(gtmConnections.id, 'gtm-provenance-connection')).get()).toMatchObject({
      selectionGeneration: 1, lastSnapshotAt: null, lastSnapshotId: null,
    })

    // The normal selection mutation clears lastSnapshotAt. Even when both
    // operations share NOW, no prior observation can satisfy the new selection.
    context.db.update(gtmConnections).set({
      selectedWorkspaceId: 'workspace_3', lastValidatedAt: NOW, lastSnapshotAt: null, lastSnapshotId: null,
    }).where(eq(gtmConnections.id, 'gtm-provenance-connection')).run()
    const reselected = await context.app.inject({ method: 'GET', url: '/projects/acme/gtm/status' })
    expect(reselected.statusCode).toBe(200)
    expect(reselected.json()).toMatchObject({
      connected: true, status: 'stale', selection: { workspaceId: 'workspace_3' },
    })
  })

  it('requires the explicit live-read scope before provider discovery and syncs through a committed run', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    await connectGoogleAds(context)

    context.setScopes(['google-marketing.write'])
    const denied = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/customers' })
    expect(denied.statusCode).toBe(403)
    expect(context.liveCalls).toEqual([])

    context.setScopes(['google-marketing.write', 'google-marketing.read-live'])
    context.setViewer(true)
    const viewerDenied = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/customers' })
    expect(viewerDenied.statusCode).toBe(403)
    expect(context.liveCalls).toEqual([])

    context.setViewer(false)
    const discovered = await context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/customers' })
    expect(discovered.statusCode).toBe(200)
    expect(context.liveCalls).toEqual(['google-ads-customers'])

    const sync = await context.app.inject({ method: 'POST', url: '/projects/acme/google-ads/sync' })
    expect(sync.statusCode).toBe(200)
    expect(sync.json()).toMatchObject({ kind: 'google-ads-sync', status: 'queued' })
    const duplicateSync = await context.app.inject({ method: 'POST', url: '/projects/acme/google-ads/sync' })
    expect(duplicateSync.statusCode).toBe(200)
    expect(duplicateSync.json<{ id: string }>().id).toBe(sync.json<{ id: string }>().id)
    expect(context.syncRequests).toHaveLength(1)
  })

  it('refuses project-scoped keys on provider-wide Google Marketing discovery', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    const credential = {
      accessToken: 'test-access-token', scopes: [], createdAt: NOW, updatedAt: NOW,
    }
    context.credentials.set(credentialKey('project_acme', 'google-ads'), credential)
    context.credentials.set(credentialKey('project_acme', 'gtm'), credential)
    context.setScopes(['google-marketing.read-live'])
    context.setProjectScopedKey(true)

    const discoveryUrls = [
      '/projects/acme/google-ads/customers',
      '/projects/acme/gtm/accounts',
      '/projects/acme/gtm/accounts/account-1/containers',
      '/projects/acme/gtm/accounts/account-1/containers/container-1/workspaces',
    ]
    const denied = await Promise.all(discoveryUrls.map(url => context.app.inject({ method: 'GET', url })))
    expect(denied.map(response => response.statusCode)).toEqual([403, 403, 403, 403])
    expect(context.liveCalls).toEqual([])

    context.setProjectScopedKey(false)
    const allowed = await Promise.all(discoveryUrls.map(url => context.app.inject({ method: 'GET', url })))
    expect(allowed.map(response => response.statusCode)).toEqual([200, 200, 200, 200])
    expect(context.liveCalls).toEqual([
      'google-ads-customers',
      'gtm-accounts',
      'gtm-containers:account-1',
      'gtm-workspaces:account-1:container-1',
    ])
  })

  it('normalizes returned GTM resource paths before live container and workspace discovery', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    context.credentials.set(credentialKey('project_acme', 'gtm'), {
      accessToken: 'gtm-access-token', scopes: [], createdAt: NOW, updatedAt: NOW,
    })
    context.setScopes(['google-marketing.read-live'])

    const [containers, workspaces] = await Promise.all([
      context.app.inject({ method: 'GET', url: '/projects/acme/gtm/accounts/accounts%2F1/containers' }),
      context.app.inject({
        method: 'GET',
        url: '/projects/acme/gtm/accounts/accounts%2F1/containers/accounts%2F1%2Fcontainers%2F2/workspaces',
      }),
    ])

    expect(containers.statusCode).toBe(200)
    expect(workspaces.statusCode).toBe(200)
    expect(context.liveCalls).toEqual([
      'gtm-containers:1',
      'gtm-workspaces:1:2',
    ])
  })

  it('returns not-implemented when live discovery is not configured', async () => {
    const context = buildApp({ includeLiveReader: false })
    contexts.push(context)
    await context.app.ready()

    const credential = {
      accessToken: 'test-access-token', scopes: [], createdAt: NOW, updatedAt: NOW,
    }
    context.credentials.set(credentialKey('project_acme', 'google-ads'), credential)
    context.credentials.set(credentialKey('project_acme', 'gtm'), credential)
    context.db.insert(googleAdsConnections).values({
      id: 'ads-connection-no-reader', projectId: 'project_acme', scopes: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    context.db.insert(gtmConnections).values({
      id: 'gtm-connection-no-reader', projectId: 'project_acme', scopes: [], createdAt: NOW, updatedAt: NOW,
    }).run()

    const responses = await Promise.all([
      context.app.inject({ method: 'GET', url: '/projects/acme/google-ads/customers' }),
      context.app.inject({ method: 'GET', url: '/projects/acme/gtm/accounts' }),
      context.app.inject({ method: 'GET', url: '/projects/acme/gtm/accounts/account-1/containers' }),
      context.app.inject({ method: 'GET', url: '/projects/acme/gtm/accounts/account-1/containers/container-1/workspaces' }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(501)
      expect(response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } })
    }
  })

  it('owns conversion contract identity and returns an injected stored-evidence integrity assessment', async () => {
    const context = buildApp()
    contexts.push(context)
    await context.app.ready()
    const create = await context.app.inject({
      method: 'POST', url: '/projects/acme/conversion-tracking/contracts',
      payload: {
        name: 'Purchase', eventName: 'purchase',
        googleAds: { customerId: '123', conversionActionId: 'action_1' },
        gtm: { accountId: 'account_1', containerId: 'container_1', tagId: 'tag_1' },
        runtime: { verificationRequired: false, productionHosts: ['https://www.Acme.example/checkout'] },
      },
    })
    expect(create.statusCode).toBe(200)
    const contract = create.json<{ id: string; projectId: string; runtime: { productionHosts: string[] } }>()
    expect(contract.projectId).toBe('project_acme')
    expect(contract.runtime.productionHosts).toEqual(['acme.example'])
    context.db.insert(runs).values([
      {
        id: 'integrity-ads-run', projectId: 'project_acme', kind: RunKinds['google-ads-sync'],
        status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW,
      },
      {
        id: 'integrity-gtm-run', projectId: 'project_acme', kind: RunKinds['gtm-sync'],
        status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW,
      },
    ]).run()
    context.db.insert(googleAdsConnections).values({
      id: 'integrity-ads-connection', projectId: 'project_acme', selectedCustomerId: '123',
      scopes: [], lastInventorySnapshotAt: NOW, lastInventorySnapshotId: 'integrity-ads-snapshot',
      createdAt: NOW, updatedAt: NOW,
    }).run()
    context.db.insert(googleAdsRawSnapshots).values({
      id: 'integrity-ads-snapshot', projectId: 'project_acme',
      connectionId: 'integrity-ads-connection', runId: 'integrity-ads-run', kind: 'inventory',
      customerId: '123', payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null,
      redactedFieldCount: 0, capturedAt: NOW, createdAt: NOW,
      payload: {
        kind: 'inventory',
        data: {
          customerId: '123', fetchedAt: NOW, campaigns: [], conversionActions: [],
          customerConversionGoals: [], campaignConversionGoals: [], customConversionGoals: [],
          campaignGoalConfigurations: [],
        },
      },
    }).run()
    // Sort order must not substitute for current-generation provenance when
    // two append-only observations share the same captured millisecond.
    context.db.insert(googleAdsRawSnapshots).values({
      id: 'integrity-ads-zzz-stale', projectId: 'project_acme',
      connectionId: 'integrity-ads-connection', runId: 'integrity-ads-run', kind: 'inventory',
      customerId: '123', payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null,
      redactedFieldCount: 0, capturedAt: NOW, createdAt: NOW,
      payload: {
        kind: 'inventory',
        data: {
          customerId: '123', fetchedAt: NOW, campaigns: [], conversionActions: [],
          customerConversionGoals: [], campaignConversionGoals: [], customConversionGoals: [],
          campaignGoalConfigurations: [],
        },
      },
    }).run()
    context.db.insert(gtmConnections).values({
      id: 'integrity-gtm-connection', projectId: 'project_acme', selectedAccountId: 'account_1',
      selectedContainerId: 'container_1', scopes: [], lastSnapshotAt: NOW,
      lastSnapshotId: 'integrity-gtm-snapshot', createdAt: NOW, updatedAt: NOW,
    }).run()
    context.db.insert(gtmRawSnapshots).values({
      id: 'integrity-gtm-snapshot', projectId: 'project_acme',
      connectionId: 'integrity-gtm-connection', runId: 'integrity-gtm-run', kind: 'container',
      accountId: 'account_1', containerId: 'container_1', workspaceId: null,
      payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null,
      redactedFieldCount: 0, capturedAt: NOW, createdAt: NOW,
      payload: {
        kind: 'container',
        data: {
          account: { id: 'account_1', path: 'accounts/account_1', name: 'Acme', shareData: null },
          container: {
            accountId: 'account_1', id: 'container_1',
            path: 'accounts/account_1/containers/container_1', name: 'Web', publicId: 'GTM-ACME',
            domainName: 'acme.example', usageContexts: ['web'],
          },
          workspaces: [], live: null, draft: null, fetchedAt: NOW,
        },
      },
    }).run()
    context.db.insert(gtmRawSnapshots).values({
      id: 'integrity-gtm-zzz-stale', projectId: 'project_acme',
      connectionId: 'integrity-gtm-connection', runId: 'integrity-gtm-run', kind: 'container',
      accountId: 'account_1', containerId: 'container_1', workspaceId: null,
      payloadChecksum: SHA, rawPayloadSha256: null, rawPayloadBytes: null,
      redactedFieldCount: 0, capturedAt: NOW, createdAt: NOW,
      payload: {
        kind: 'container',
        data: {
          account: { id: 'account_1', path: 'accounts/account_1', name: 'Stale', shareData: null },
          container: {
            accountId: 'account_1', id: 'container_1',
            path: 'accounts/account_1/containers/container_1', name: 'Stale', publicId: 'GTM-STALE',
            domainName: 'acme.example', usageContexts: ['web'],
          },
          workspaces: [], live: null, draft: null, fetchedAt: NOW,
        },
      },
    }).run()
    const integrity = await context.app.inject({
      method: 'GET', url: `/projects/acme/conversion-tracking/contracts/${contract.id}/integrity`,
    })
    expect(integrity.statusCode).toBe(200)
    expect(integrity.json()).toMatchObject({
      assessment: { contract: { id: contract.id }, status: 'statically-consistent' },
      googleAdsSnapshot: { id: 'integrity-ads-snapshot', kind: 'inventory' },
      gtmSnapshot: { id: 'integrity-gtm-snapshot', kind: 'container' },
    })

    // Re-selecting creates a new durable selection generation. Its snapshot
    // anchor is cleared, so append-only evidence cannot be reused even when
    // timestamps and account/container IDs happen to match again.
    const reselectedAt = '2026-08-14T13:00:00.000Z'
    context.db.update(googleAdsConnections).set({
      selectionGeneration: 1, lastValidatedAt: reselectedAt,
      lastCustomerSnapshotId: null, lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
      lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null,
    })
      .where(eq(googleAdsConnections.id, 'integrity-ads-connection')).run()
    context.db.update(gtmConnections).set({
      selectionGeneration: 1, lastValidatedAt: reselectedAt, lastSnapshotAt: null, lastSnapshotId: null,
    })
      .where(eq(gtmConnections.id, 'integrity-gtm-connection')).run()
    const staleIntegrity = await context.app.inject({
      method: 'GET', url: `/projects/acme/conversion-tracking/contracts/${contract.id}/integrity`,
    })
    expect(staleIntegrity.statusCode).toBe(200)
    expect(staleIntegrity.json()).toMatchObject({ googleAdsSnapshot: null, gtmSnapshot: null })
  })

  it('surfaces the provider cause when discovery fails, instead of a dead end', async () => {
    // The real failure this came from: the Google Ads API was not enabled on the
    // Cloud project that owns the OAuth client. Google says exactly that, but a
    // bare `catch` discarded it and answered "discovery failed", so diagnosing it
    // needed `gcloud services list` against the project. Nothing in the product
    // pointed there. Assert the cause reaches the operator.
    const cause = new Error(
      'Google Ads API has not been used in project 701814655766 before or it is disabled (SERVICE_DISABLED)',
    )
    const ctx = buildApp({ liveReaderError: cause })
    contexts.push(ctx)
    await connectGoogleAds(ctx)

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/google-ads/customers',
    })
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.payload) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PROVIDER_ERROR')
    // Names the operation AND why it failed. The bare-catch version returned
    // only the first half, which is what made it undiagnosable.
    expect(body.error.message).toContain('Google Ads customer discovery failed')
    expect(body.error.message).toContain('SERVICE_DISABLED')
  })

})
