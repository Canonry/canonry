import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forbidden, internalError, notImplemented, validationError } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { BingApiError, getSites } from '@ainyc/canonry-integration-bing'
import { GA4ApiError, verifyConnection } from '@ainyc/canonry-integration-google-analytics'
import { getSiteStatus, runAudit, verifyWordpressConnection, WordpressApiError } from '@ainyc/canonry-integration-wordpress'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'
import type { AuthPrincipal } from '../src/auth.js'
import {
  oauthStateAttribution,
  routeOutcomeFailure,
  startConnectionAttempt,
  unverifiedOAuthStateField,
  webhookOutcomeTarget,
  webhookResponseReason,
  webhookTargetRefusalReason,
} from '../src/connection-telemetry.js'
import { buildSignedGoogleOAuthState } from '../src/google-oauth-state.js'
import type { OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'
import { connectionOutcomes } from './outcome-capture.js'
import { startRecordingSite, type RecordingSite } from './recording-site-fixture.js'

vi.mock('@ainyc/canonry-integration-bing', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ainyc/canonry-integration-bing')>(),
  getSites: vi.fn(),
}))
vi.mock('@ainyc/canonry-integration-google-analytics', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ainyc/canonry-integration-google-analytics')>(),
  verifyConnection: vi.fn(),
}))
vi.mock('@ainyc/canonry-integration-wordpress', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ainyc/canonry-integration-wordpress')>(),
  verifyWordpressConnection: vi.fn(),
  getSiteStatus: vi.fn(),
  runAudit: vi.fn(),
}))

const NOW = '2026-10-09T00:00:00.000Z'
const DONE = { durationBucket: 'under_1s' } as const

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(options: Partial<Omit<ApiRoutesOptions, 'db'>> = {}, principal?: AuthPrincipal & { operator?: boolean }) {
  const db = createClient(':memory:')
  migrate(db)
  db.insert(projects).values({
    id: 'proj-1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  const outcomes: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  if (principal) {
    app.addHook('onRequest', async (request) => {
      request.principal = principal
      if (principal.operator) request.operatorAccess = true
    })
  }
  await app.register(apiRoutes, { db, skipAuth: true, allowLoopbackWebhooks: true, onOutcome: event => { outcomes.push(event) }, ...options })
  await app.ready()
  cleanups.push(async () => { await app.close(); db.$client.close() })
  return { app, db, outcomes, connections: () => connectionOutcomes(outcomes) }
}

describe('connection outcome helpers', () => {
  it('reads a route error as a reason and class name, never its message', () => {
    expect(routeOutcomeFailure(forbidden('This action requires the "settings.write" scope on your API key.')))
      .toEqual({ reasonCode: 'GATE_REFUSED', errorName: 'AppError' })
    expect(routeOutcomeFailure(forbidden('Reconnect Google', { upstreamStatus: 401 })))
      .toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'AppError' })
    expect(routeOutcomeFailure(forbidden('No access', { upstreamStatus: 403 })))
      .toEqual({ reasonCode: 'PERMISSION_MISSING', errorName: 'AppError' })
    expect(routeOutcomeFailure(notImplemented('not here'))).toEqual({ reasonCode: 'UNSUPPORTED', errorName: 'AppError' })
    expect(routeOutcomeFailure(internalError('boom'))).toEqual({ reasonCode: 'INTERNAL', errorName: 'AppError' })
    expect(routeOutcomeFailure(validationError('bad'))).toEqual({ reasonCode: 'VALIDATION', errorName: 'AppError' })
    expect(routeOutcomeFailure(validationError('bad'), 'BLOCKED_UNSAFE_URL')).toEqual({ reasonCode: 'BLOCKED_UNSAFE_URL', errorName: 'AppError' })
    expect(routeOutcomeFailure(undefined, 'NETWORK')).toEqual({ reasonCode: 'NETWORK' })
  })

  it('classifies a webhook answer: only 2xx succeeds, and a redirect is unsupported', () => {
    expect(webhookResponseReason({ status: 204 })).toBeUndefined()
    expect(webhookResponseReason({ status: 0 })).toBe('NETWORK')
    expect(webhookResponseReason({ status: 0, timedOut: true })).toBe('TIMEOUT')
    expect(webhookResponseReason({ status: 302 })).toBe('UNSUPPORTED')
    expect(webhookResponseReason({ status: 404 })).toBe('HTTP_4XX')
    expect(webhookResponseReason({ status: 429 })).toBe('HTTP_4XX')
    expect(webhookResponseReason({ status: 503 })).toBe('HTTP_5XX')
    expect(webhookTargetRefusalReason({ ok: false, message: 'x', blocked: true })).toBe('BLOCKED_UNSAFE_URL')
    expect(webhookTargetRefusalReason({ ok: false, message: 'x', unresolved: true })).toBe('NETWORK')
    expect(webhookTargetRefusalReason({ ok: false, message: 'x' })).toBe('VALIDATION')
  })

  it('names a webhook destination by kind only, matching chat hosts exactly and only over HTTPS', () => {
    expect(webhookOutcomeTarget('https://hooks.slack.com/services/T000/B000/XXX')).toBe('slack')
    expect(webhookOutcomeTarget('https://discord.com/api/webhooks/1/abc')).toBe('discord')
    expect(webhookOutcomeTarget('http://hooks.slack.com/services/T000/B000/XXX')).toBe('first_party')
    expect(webhookOutcomeTarget('https://hooks.slack.com.evil.test/services/x')).toBe('first_party')
    expect(webhookOutcomeTarget('not a url')).toBe('first_party')
  })

  it('reports the first outcome only, and never throws without a sink or from a failing one', () => {
    const seen: unknown[] = []
    const app = { emitOutcome: (event: unknown) => { seen.push(event) } } as unknown as FastifyInstance
    const attempt = startConnectionAttempt(app, { integration: 'bing', action: 'connect' })
    attempt.failed(new Error('upstream said no'), 'INVALID_CREDENTIALS')
    attempt.succeeded()
    attempt.cancelled('NOT_CONNECTED')
    expect(seen).toEqual([{
      event: 'integration.connection',
      properties: { integration: 'bing', action: 'connect', status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error', ...DONE },
    }])

    expect(() => startConnectionAttempt({} as FastifyInstance, { integration: 'bing', action: 'connect' }).succeeded()).not.toThrow()
    const throwing = { emitOutcome: () => { throw new Error('collector down') } } as unknown as FastifyInstance
    expect(() => startConnectionAttempt(throwing, { integration: 'bing', action: 'connect' }).succeeded()).not.toThrow()
  })

  it('reads labels back from a state, and an unverified field only as a plain string', () => {
    expect(oauthStateAttribution({ surface: 'cli', agent: 'Claude Code' })).toEqual({ surface: 'cli', agent: 'claude-code' })
    expect(oauthStateAttribution({ surface: 'evil', agent: 42 })).toEqual({})
    const state = buildSignedGoogleOAuthState({ type: 'gsc', propertyId: 7 }, 'secret')
    expect(unverifiedOAuthStateField(state, 'type')).toBe('gsc')
    expect(unverifiedOAuthStateField(state, 'propertyId')).toBeUndefined()
    expect(unverifiedOAuthStateField('not-base64-json', 'type')).toBeUndefined()
    expect(unverifiedOAuthStateField(undefined, 'type')).toBeUndefined()
  })
})

describe('provider connections', () => {
  const adapter = {
    name: 'gemini', displayName: 'Gemini', mode: 'api' as const, modelConfigurable: true, defaultModel: 'gemini-flash-latest',
    knownModels: [], modelValidationPattern: /^gemini-/, modelValidationHint: 'a gemini model',
  }

  it('reports a key as a connect, a key over a configured provider as a reauth, and a model change as nothing', async () => {
    const summary = [{ name: 'gemini', configured: false }]
    const h = await harness({
      providerAdapters: [adapter],
      providerSummary: summary,
      onProviderUpdate: (name) => ({ name, configured: true }),
    })
    const put = (payload: object) => h.app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', payload })

    expect((await put({ apiKey: 'key-1' })).statusCode).toBe(200)
    summary[0]!.configured = true
    expect((await put({ apiKey: 'key-2' })).statusCode).toBe(200)
    expect((await put({ model: 'gemini-pro' })).statusCode).toBe(200)
    expect((await put({ apiKey: 'key-3', model: 'gpt-5' })).statusCode).toBe(400)

    expect(h.connections()).toEqual([
      { integration: 'provider', provider: 'gemini', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'provider', provider: 'gemini', action: 'reauth', status: 'succeeded', ...DONE },
      { integration: 'provider', provider: 'gemini', action: 'reauth', status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError', ...DONE },
    ])
  })

  it('reports a store failure as internal and a refused scope as a gate, and nothing for an unknown provider', async () => {
    const h = await harness({
      providerAdapters: [adapter],
      providerSummary: [{ name: 'gemini', configured: false }],
      onProviderUpdate: () => null,
    })
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', payload: { apiKey: 'key-1' } })
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/providers/acme-llm', payload: { apiKey: 'key-1' } })
    const gated = await harness(
      { providerAdapters: [adapter], providerSummary: [], onProviderUpdate: (name) => ({ name, configured: true }) },
      { kind: 'api-key', id: 'reader', name: 'reader', scopes: ['read'], viaCookie: false },
    )
    expect((await gated.app.inject({ method: 'PUT', url: '/api/v1/settings/providers/gemini', payload: { apiKey: 'key-1' } })).statusCode).toBe(403)

    expect(h.connections()).toEqual([
      { integration: 'provider', provider: 'gemini', action: 'connect', status: 'failed', reasonCode: 'INTERNAL', errorName: 'AppError', ...DONE },
    ])
    expect(gated.connections()).toEqual([
      { integration: 'provider', provider: 'gemini', action: 'connect', status: 'failed', reasonCode: 'GATE_REFUSED', errorName: 'AppError', ...DONE },
    ])
  })
})

describe('CDP connections', () => {
  it('reports endpoint saves, and refuses a non-loopback host as unsafe', async () => {
    const onCdpConfigure = vi.fn()
    const h = await harness({ onCdpConfigure })
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/cdp', payload: { host: 'localhost', port: 9222 } })
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/cdp', payload: { host: '169.254.169.254' } })
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/cdp', payload: { host: 'localhost', port: 70_000 } })
    onCdpConfigure.mockRejectedValueOnce(new TypeError('config write failed'))
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/settings/cdp', payload: { host: '127.0.0.1' } })).statusCode).toBe(500)
    const bare = await harness()
    await bare.app.inject({ method: 'PUT', url: '/api/v1/settings/cdp', payload: { host: 'localhost' } })

    expect(h.connections()).toEqual([
      { integration: 'cdp', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'cdp', action: 'connect', status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL', errorName: 'AppError', ...DONE },
      { integration: 'cdp', action: 'connect', status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError', ...DONE },
      { integration: 'cdp', action: 'connect', status: 'failed', reasonCode: 'UNKNOWN', errorName: 'TypeError', ...DONE },
    ])
    expect(bare.connections()).toEqual([
      { integration: 'cdp', action: 'connect', status: 'failed', reasonCode: 'UNSUPPORTED', errorName: 'AppError', ...DONE },
    ])
  })

  it('reports a status read as a test only once an endpoint is configured', async () => {
    const getCdpStatus = vi.fn()
    const h = await harness({ getCdpStatus })
    getCdpStatus.mockResolvedValueOnce({ connected: true, endpoint: 'ws://localhost:9222', targets: [] })
    getCdpStatus.mockResolvedValueOnce({ connected: false, endpoint: 'ws://localhost:9222', targets: [] })
    getCdpStatus.mockResolvedValueOnce({ connected: false, endpoint: '', targets: [] })
    getCdpStatus.mockRejectedValueOnce(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))
    for (let i = 0; i < 4; i++) await h.app.inject({ url: '/api/v1/cdp/status' })

    expect(h.connections()).toEqual([
      { integration: 'cdp', action: 'test', status: 'succeeded', ...DONE },
      { integration: 'cdp', action: 'test', status: 'failed', reasonCode: 'NETWORK', ...DONE },
      { integration: 'cdp', action: 'test', status: 'failed', reasonCode: 'NETWORK', errorName: 'Error', ...DONE },
    ])
  })
})

describe('webhook connections', () => {
  let receiver: RecordingSite
  let answer = 204
  beforeEach(async () => {
    answer = 204
    receiver = await startRecordingSite((_request, response) => {
      if (answer === 302) response.writeHead(302, { location: '/elsewhere' }).end()
      else response.writeHead(answer).end()
    })
    cleanups.push(() => receiver.close())
  })

  const create = (app: FastifyInstance, url: string, source?: string) => app.inject({
    method: 'POST', url: '/api/v1/projects/acme/notifications',
    payload: { channel: 'webhook', url, events: ['run.completed'], ...(source ? { source } : {}) },
  })

  it('reports create, an unsafe or unresolvable destination, and delete, apart for the agent webhook', async () => {
    const h = await harness()
    const hook = (await create(h.app, `http://127.0.0.1:${receiver.port}/hook`)).json<{ id: string }>()
    const agent = (await create(h.app, `http://127.0.0.1:${receiver.port}/agent`, 'agent')).json<{ id: string }>()
    expect((await create(h.app, 'http://169.254.169.254/latest/meta-data')).statusCode).toBe(400)
    // The test DNS guard leaves the name without an address.
    expect((await create(h.app, 'https://hooks.slack.com/services/T000/B000/XXX')).statusCode).toBe(400)
    expect((await create(h.app, 'ftp://example.com/hook')).statusCode).toBe(400)
    await h.app.inject({ method: 'DELETE', url: `/api/v1/projects/acme/notifications/${hook.id}` })
    await h.app.inject({ method: 'DELETE', url: `/api/v1/projects/acme/notifications/${agent.id}` })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/notifications/missing' })

    expect(h.connections()).toEqual([
      { integration: 'webhook', action: 'connect', status: 'succeeded', target: 'first_party', ...DONE },
      { integration: 'agent_webhook', action: 'connect', status: 'succeeded', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'connect', status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'connect', status: 'failed', reasonCode: 'NETWORK', target: 'slack', ...DONE },
      { integration: 'webhook', action: 'connect', status: 'failed', reasonCode: 'VALIDATION', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'disconnect', status: 'succeeded', target: 'first_party', ...DONE },
      { integration: 'agent_webhook', action: 'disconnect', status: 'succeeded', target: 'first_party', ...DONE },
    ])
  })

  it('reports a test as succeeded only when the destination answers 2xx', async () => {
    const h = await harness()
    const hook = (await create(h.app, `http://127.0.0.1:${receiver.port}/hook`)).json<{ id: string }>()
    h.outcomes.length = 0
    const test = () => h.app.inject({ method: 'POST', url: `/api/v1/projects/acme/notifications/${hook.id}/test` })

    for (const status of [204, 404, 503, 302]) {
      answer = status
      expect((await test()).json()).toEqual({ status, ok: status === 204 })
    }
    await receiver.close()
    expect((await test()).statusCode).toBe(502)

    expect(h.connections()).toEqual([
      { integration: 'webhook', action: 'test', status: 'succeeded', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'HTTP_4XX', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'HTTP_5XX', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'UNSUPPORTED', target: 'first_party', ...DONE },
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'NETWORK', target: 'first_party', ...DONE },
    ])
  })

  it('reports a test of a stored destination that is now refused as unsafe', async () => {
    const h = await harness()
    const hook = (await create(h.app, `http://127.0.0.1:${receiver.port}/hook`)).json<{ id: string }>()
    h.outcomes.length = 0
    const strict = await harness({ allowLoopbackWebhooks: false })
    // Same stored row, read by a server that no longer admits loopback.
    const { notifications } = await import('@ainyc/canonry-db')
    const row = h.db.select().from(notifications).all()[0]!
    strict.db.insert(notifications).values(row).run()
    expect((await strict.app.inject({ method: 'POST', url: `/api/v1/projects/acme/notifications/${hook.id}/test` })).statusCode).toBe(400)

    expect(strict.connections()).toEqual([
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL', target: 'first_party', ...DONE },
    ])
  })
})

describe('telemetry opt-out attribution', () => {
  it('hands the host the raw labels of the request that turned telemetry off', async () => {
    const setTelemetryEnabled = vi.fn()
    const h = await harness(
      { getTelemetryStatus: () => ({ enabled: false }), setTelemetryEnabled },
      { kind: 'api-key', id: 'operator', name: 'operator', scopes: ['*'], viaCookie: false, operator: true },
    )
    const res = await h.app.inject({
      method: 'PUT', url: '/api/v1/telemetry', payload: { enabled: false },
      headers: { 'user-agent': 'canonry-mcp', 'x-canonry-surface': 'mcp-stdio', 'x-canonry-agent': 'claude' },
    })
    expect(res.statusCode).toBe(200)
    expect(setTelemetryEnabled).toHaveBeenCalledExactlyOnceWith(false, { userAgent: 'canonry-mcp', surfaceLabel: 'mcp-stdio', agentLabel: 'claude' })
  })
})

describe('Bing, OpenAI Ads, WordPress and GA4 connections', () => {
  beforeEach(() => {
    vi.mocked(getSites).mockReset().mockResolvedValue([])
    vi.mocked(verifyConnection).mockReset().mockResolvedValue(undefined as never)
    vi.mocked(verifyWordpressConnection).mockReset().mockResolvedValue(undefined as never)
    vi.mocked(getSiteStatus).mockReset().mockResolvedValue({ reachable: true } as never)
    vi.mocked(runAudit).mockReset().mockRejectedValue(new Error('audit not under test'))
  })

  it('reports Bing connect, reconnect, site selection and disconnect', async () => {
    const store = new Map<string, Record<string, unknown>>()
    const h = await harness({
      bingConnectionStore: {
        getConnection: domain => store.get(domain) as never,
        upsertConnection: (record) => { store.set(record.domain, record as never); return record },
        updateConnection: (domain, patch) => { const next = { ...store.get(domain), ...patch }; store.set(domain, next); return next as never },
        deleteConnection: domain => store.delete(domain),
      },
    })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/bing/set-site', payload: { siteUrl: 'https://acme.example/' } })
    vi.mocked(getSites).mockRejectedValueOnce(new BingApiError('key rejected for acme.example', 401))
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/bing/connect', payload: { apiKey: 'bad' } })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/bing/connect', payload: { apiKey: 'good' } })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/bing/connect', payload: { apiKey: 'rotated' } })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/bing/set-site', payload: { siteUrl: 'https://acme.example/' } })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/bing/disconnect' })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/bing/disconnect' })

    expect(h.connections()).toEqual([
      { integration: 'bing', action: 'select', status: 'failed', reasonCode: 'NOT_CONNECTED', errorName: 'AppError', ...DONE },
      { integration: 'bing', action: 'connect', status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'BingApiError', ...DONE },
      { integration: 'bing', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'bing', action: 'reauth', status: 'succeeded', ...DONE },
      { integration: 'bing', action: 'select', status: 'succeeded', ...DONE },
      { integration: 'bing', action: 'disconnect', status: 'succeeded', ...DONE },
      { integration: 'bing', action: 'disconnect', status: 'failed', reasonCode: 'NOT_CONNECTED', ...DONE },
    ])
  })

  it('reports OpenAI Ads connect with the rejected key classified, and a disconnect with nothing connected as cancelled', async () => {
    const configs = new Map<string, unknown>()
    const verifyAdsAccount = vi.fn().mockResolvedValue({
      id: 'acct_1', name: 'Acme', status: 'active', currencyCode: 'USD', timezone: 'UTC', reviewStatus: null, integrityReviewStatus: null, integrityDecision: null,
    })
    const h = await harness({
      adsCredentialStore: {
        getConnection: name => configs.get(name) as never,
        upsertConnection: (entry) => { configs.set((entry as { projectName: string }).projectName, entry) },
        removeConnection: name => configs.delete(name),
      },
      verifyAdsAccount,
    })
    verifyAdsAccount.mockRejectedValueOnce(Object.assign(new Error('401 from api.openai.com'), { status: 401 }))
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/ads/connect', payload: { apiKey: 'bad' } })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/ads/connect', payload: { apiKey: 'good' } })
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/ads/connect', payload: { apiKey: 'rotated' } })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/ads/connection' })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/ads/connection' })

    expect(h.connections()).toEqual([
      { integration: 'openai_ads', action: 'connect', status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error', ...DONE },
      { integration: 'openai_ads', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'openai_ads', action: 'reauth', status: 'succeeded', ...DONE },
      { integration: 'openai_ads', action: 'disconnect', status: 'succeeded', ...DONE },
      { integration: 'openai_ads', action: 'disconnect', status: 'cancelled', reasonCode: 'NOT_CONNECTED', ...DONE },
    ])
  })

  it('reports WordPress connect, onboarding and disconnect, with refusals and rejected credentials classified', async () => {
    const site = await startRecordingSite((_request, response) => response.writeHead(200).end())
    cleanups.push(() => site.close())
    const records = new Map<string, unknown>()
    const h = await harness({
      wordpressConnectionStore: {
        getConnection: name => records.get(name) as never,
        upsertConnection: (record) => { records.set(record.projectName, record); return record },
        updateConnection: () => undefined,
        deleteConnection: name => records.delete(name),
      },
    })
    const url = `http://127.0.0.1:${site.port}`
    const connect = (payload: object) => h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/wordpress/connect', payload })
    const credentials = { username: 'editor', appPassword: 'app pass' }

    await connect({ url: 'http://169.254.169.254', ...credentials })
    vi.mocked(verifyWordpressConnection).mockRejectedValueOnce(new WordpressApiError('AUTH_INVALID', 'rejected at the site', 401))
    await connect({ url, ...credentials })
    await connect({ url, ...credentials })
    await connect({ url, ...credentials })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/wordpress/disconnect' })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/wordpress/disconnect' })
    const onboard = await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/wordpress/onboard', payload: { url, ...credentials, skipSchema: true, skipSubmit: true } })
    expect(onboard.statusCode).toBe(200)
    vi.mocked(verifyWordpressConnection).mockRejectedValueOnce(new WordpressApiError('UPSTREAM_ERROR', 'site down', 503))
    await h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/wordpress/onboard', payload: { url, ...credentials, skipSchema: true, skipSubmit: true } })

    expect(h.connections()).toEqual([
      { integration: 'wordpress', action: 'connect', status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL', ...DONE },
      { integration: 'wordpress', action: 'connect', status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'WordpressApiError', ...DONE },
      { integration: 'wordpress', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'wordpress', action: 'reauth', status: 'succeeded', ...DONE },
      { integration: 'wordpress', action: 'disconnect', status: 'succeeded', ...DONE },
      { integration: 'wordpress', action: 'disconnect', status: 'failed', reasonCode: 'NOT_CONNECTED', ...DONE },
      { integration: 'wordpress', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'wordpress', action: 'reauth', status: 'failed', reasonCode: 'HTTP_5XX', errorName: 'WordpressApiError', ...DONE },
    ])
  })

  it('reports a GA4 key file as a connect, an OAuth property pick as a select, and disconnect', async () => {
    const records = new Map<string, unknown>()
    const h = await harness({
      ga4CredentialStore: {
        getConnection: name => records.get(name) as never,
        upsertConnection: (record) => { records.set(record.projectName, record); return record },
        deleteConnection: name => records.delete(name),
      },
    })
    const keyJson = JSON.stringify({ client_email: 'svc@acme.iam.gserviceaccount.com', private_key: 'pem' })
    const connect = (payload: object) => h.app.inject({ method: 'POST', url: '/api/v1/projects/acme/ga/connect', payload })

    vi.mocked(verifyConnection).mockRejectedValueOnce(new GA4ApiError('no access to properties/123', 403))
    await connect({ propertyId: '123', keyJson })
    await connect({ propertyId: '123', keyJson })
    await connect({ propertyId: '123', keyJson })
    await connect({ propertyId: '123' })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/ga/disconnect' })
    await h.app.inject({ method: 'DELETE', url: '/api/v1/projects/acme/ga/disconnect' })

    expect(h.connections()).toEqual([
      { integration: 'ga4', action: 'connect', status: 'failed', reasonCode: 'PERMISSION_MISSING', errorName: 'GA4ApiError', ...DONE },
      { integration: 'ga4', action: 'connect', status: 'succeeded', ...DONE },
      { integration: 'ga4', action: 'reauth', status: 'succeeded', ...DONE },
      { integration: 'ga4', action: 'select', status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError', ...DONE },
      { integration: 'ga4', action: 'disconnect', status: 'succeeded', ...DONE },
      { integration: 'ga4', action: 'disconnect', status: 'failed', reasonCode: 'NOT_CONNECTED', ...DONE },
    ])
  })
})
