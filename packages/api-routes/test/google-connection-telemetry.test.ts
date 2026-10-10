import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, gbpLocations, migrate, projects } from '@ainyc/canonry-db'
import { exchangeCode, GoogleAuthError } from '@ainyc/canonry-integration-google'
import { googleRoutes, type GoogleConnectionRecord } from '../src/google.js'
import { buildSignedGoogleOAuthState, GOOGLE_OAUTH_STATE_MAX_AGE_MS } from '../src/google-oauth-state.js'
import { connectionOutcomes, outcomeApp } from './outcome-capture.js'

vi.mock('@ainyc/canonry-integration-google', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ainyc/canonry-integration-google')>(),
  exchangeCode: vi.fn(),
}))

const STATE_SECRET = 'test-secret-32-bytes-long-enough!'
const NOW = '2026-10-09T00:00:00.000Z'

async function harness() {
  const db = createClient(':memory:')
  migrate(db)
  db.insert(projects).values({
    id: 'proj-1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  const connections: GoogleConnectionRecord[] = []
  const { app, outcomes } = outcomeApp(db)
  await app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' }),
    googleConnectionStore: {
      listConnections: domain => connections.filter(c => c.domain === domain),
      getConnection: (domain, type) => connections.find(c => c.domain === domain && c.connectionType === type),
      upsertConnection: (connection) => {
        const index = connections.findIndex(c => c.domain === connection.domain && c.connectionType === connection.connectionType)
        if (index === -1) connections.push(connection)
        else connections[index] = connection
        return connection
      },
      updateConnection: (domain, type, patch) => {
        const existing = connections.find(c => c.domain === domain && c.connectionType === type)
        if (existing) Object.assign(existing, patch)
        return existing
      },
      deleteConnection: (domain, type) => {
        const index = connections.findIndex(c => c.domain === domain && c.connectionType === type)
        if (index === -1) return false
        connections.splice(index, 1)
        return true
      },
    },
    googleStateSecret: STATE_SECRET,
    publicUrl: 'https://canonry.example',
  })
  await app.ready()
  const connect = async (type: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: 'POST', url: '/projects/acme/google/connect', payload: { type }, headers })
    return new URL(res.json<{ authUrl: string }>().authUrl).searchParams.get('state')!
  }
  return { app, db, outcomes, connections, connect }
}

let current: Awaited<ReturnType<typeof harness>> | undefined
beforeEach(() => {
  vi.mocked(exchangeCode).mockReset().mockResolvedValue({
    access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'scope-a', token_type: 'Bearer',
  })
})
afterEach(async () => {
  await current?.app.close()
  current?.db.$client.close()
  current = undefined
})

describe('Google OAuth connection outcomes', () => {
  it('reports the redirect as started and the callback as succeeded, under the surface that started it', async () => {
    current = await harness()
    const state = await current.connect('gsc', { 'x-canonry-surface': 'cli', 'x-canonry-agent': 'codex', 'user-agent': 'canonry-cli/7.21.0' })
    const callback = await current.app.inject({ url: `/google/callback?code=abc&state=${state}` })
    expect(callback.statusCode).toBe(200)

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gsc', action: 'connect', status: 'started' },
      { integration: 'gsc', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex', durationBucket: 'under_1s' },
    ])
    // The start carries its request's raw labels; the callback carries the browser's.
    expect(current.outcomes[0]!.attribution).toEqual({ userAgent: 'canonry-cli/7.21.0', surfaceLabel: 'cli', agentLabel: 'codex' })
  })

  it('reports a second authorization of an existing connection as a reauth at both ends', async () => {
    current = await harness()
    await current.app.inject({ url: `/google/callback?code=abc&state=${await current.connect('ga4')}` })
    current.outcomes.length = 0

    await current.app.inject({ url: `/google/callback?code=def&state=${await current.connect('ga4')}` })
    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'ga4', action: 'reauth', status: 'started' },
      { integration: 'ga4', action: 'reauth', status: 'succeeded', durationBucket: 'under_1s' },
    ])
  })

  it('tells a consent the user declined from one Google refused', async () => {
    current = await harness()
    const state = await current.connect('gbp')
    await current.app.inject({ url: `/google/callback?error=access_denied&state=${state}` })
    await current.app.inject({ url: `/google/callback?error=admin_policy_enforced&state=${state}` })

    expect(connectionOutcomes(current.outcomes).slice(1)).toEqual([
      { integration: 'gbp', action: 'connect', status: 'cancelled', reasonCode: 'OAUTH_CANCELLED', durationBucket: 'under_1s' },
      { integration: 'gbp', action: 'connect', status: 'failed', reasonCode: 'AUTH_DENIED', durationBucket: 'under_1s' },
    ])
  })

  it('reports an expired state as invalid for the integration it names, and nothing for a state with none', async () => {
    current = await harness()
    const expired = buildSignedGoogleOAuthState(
      { projectId: 'proj-1', projectName: 'acme', domain: 'acme.example', type: 'gsc', redirectUri: 'https://canonry.example/api/v1/google/callback' },
      STATE_SECRET,
      Date.now() - GOOGLE_OAUTH_STATE_MAX_AGE_MS - 1_000,
    )
    expect((await current.app.inject({ url: `/google/callback?code=abc&state=${expired}` })).statusCode).toBe(400)
    expect((await current.app.inject({ url: '/google/callback?code=abc&state=invalid-garbage' })).statusCode).toBe(400)

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gsc', action: 'connect', status: 'failed', reasonCode: 'OAUTH_STATE_INVALID', durationBucket: 'under_1s' },
    ])
    expect(vi.mocked(exchangeCode)).not.toHaveBeenCalled()
  })

  it('classifies a failed code exchange by its status and class, never its message, under the action its start reported', async () => {
    current = await harness()
    await current.app.inject({ url: `/google/callback?code=abc&state=${await current.connect('gsc')}` })
    current.outcomes.length = 0
    vi.mocked(exchangeCode).mockRejectedValue(new GoogleAuthError('invalid_grant for https://canonry.example', 400))
    await current.app.inject({ url: `/google/callback?code=abc&state=${await current.connect('gsc')}` })

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gsc', action: 'reauth', status: 'started' },
      { integration: 'gsc', action: 'reauth', status: 'failed', reasonCode: 'HTTP_4XX', errorName: 'GoogleAuthError', durationBucket: 'under_1s' },
    ])
  })

  it('reports a connection another project owns as already connected', async () => {
    current = await harness()
    current.connections.push({
      domain: 'acme.example', connectionType: 'gsc', propertyId: null, accessToken: 'a', refreshToken: 'r',
      tokenExpiresAt: NOW, scopes: [], createdByProjectId: 'other-project', createdAt: NOW, updatedAt: NOW,
    })
    const state = await current.connect('gsc')
    expect((await current.app.inject({ url: `/google/callback?code=abc&state=${state}` })).statusCode).toBe(403)

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gsc', action: 'reauth', status: 'started' },
      { integration: 'gsc', action: 'reauth', status: 'failed', reasonCode: 'ALREADY_CONNECTED', durationBucket: 'under_1s' },
    ])
  })

  it('reports nothing for a connect that names no Google integration', async () => {
    current = await harness()
    expect((await current.app.inject({ method: 'POST', url: '/projects/acme/google/connect', payload: { type: 'youtube' } })).statusCode).toBe(400)
    expect(current.outcomes).toEqual([])
  })

  it('reports property selection, disconnect, and both against a missing connection', async () => {
    current = await harness()
    await current.app.inject({ url: `/google/callback?code=abc&state=${await current.connect('gsc')}` })
    current.outcomes.length = 0

    await current.app.inject({ method: 'PUT', url: '/projects/acme/google/connections/gsc/property', payload: { propertyId: 'sc-domain:acme.example' } })
    await current.app.inject({ method: 'PUT', url: '/projects/acme/google/connections/ga4/property', payload: { propertyId: '123' } })
    await current.app.inject({ method: 'DELETE', url: '/projects/acme/google/connections/gsc' })
    await current.app.inject({ method: 'DELETE', url: '/projects/acme/google/connections/gsc' })
    await current.app.inject({ method: 'DELETE', url: '/projects/acme/google/connections/youtube' })

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gsc', action: 'select', status: 'succeeded', durationBucket: 'under_1s' },
      { integration: 'ga4', action: 'select', status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s' },
      { integration: 'gsc', action: 'disconnect', status: 'succeeded', durationBucket: 'under_1s' },
      { integration: 'gsc', action: 'disconnect', status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s' },
    ])
  })

  it('reports Business Profile location selection and disconnect', async () => {
    current = await harness()
    current.db.insert(gbpLocations).values({
      id: 'loc-1', projectId: 'proj-1', accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Acme HQ',
      createdAt: NOW, updatedAt: NOW,
    }).run()
    await current.app.inject({ url: `/google/callback?code=abc&state=${await current.connect('gbp')}` })
    current.outcomes.length = 0

    await current.app.inject({ method: 'PUT', url: `/projects/acme/gbp/locations/${encodeURIComponent('locations/1')}/selection`, payload: { selected: false } })
    await current.app.inject({ method: 'PUT', url: `/projects/acme/gbp/locations/${encodeURIComponent('locations/404')}/selection`, payload: { selected: true } })
    await current.app.inject({ method: 'DELETE', url: '/projects/acme/gbp/connection' })
    await current.app.inject({ method: 'DELETE', url: '/projects/acme/gbp/connection' })

    expect(connectionOutcomes(current.outcomes)).toEqual([
      { integration: 'gbp', action: 'select', status: 'succeeded', durationBucket: 'under_1s' },
      { integration: 'gbp', action: 'select', status: 'failed', reasonCode: 'NOT_FOUND', errorName: 'AppError', durationBucket: 'under_1s' },
      { integration: 'gbp', action: 'disconnect', status: 'succeeded', durationBucket: 'under_1s' },
      { integration: 'gbp', action: 'disconnect', status: 'cancelled', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s' },
    ])
  })
})
