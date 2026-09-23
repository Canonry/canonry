import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GA_AUTH_CHECKS } from '../src/doctor/checks/ga-auth.js'
import { PROVIDERS_CHECKS } from '../src/doctor/checks/providers.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'

const verifyConnectionMock = vi.fn()
const verifyConnectionWithTokenMock = vi.fn()
const refreshAccessTokenMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google-analytics', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-analytics')>('@ainyc/canonry-integration-google-analytics')
  return {
    ...actual,
    verifyConnection: (...args: unknown[]) => verifyConnectionMock(...args),
    verifyConnectionWithToken: (...args: unknown[]) => verifyConnectionWithTokenMock(...args),
  }
})

vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
  return {
    ...actual,
    refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
  }
})

const project: ProjectInfo = {
  id: 'p1',
  name: 'demo',
  canonicalDomain: 'example.com',
  displayName: 'Demo',
}

function gaStore(record?: Ga4CredentialRecord | null): Ga4CredentialStore {
  return {
    getConnection: () => record ?? undefined,
    upsertConnection: (r) => r,
    deleteConnection: () => true,
  }
}

function googleStoreWithGa4(connection?: Partial<GoogleConnectionRecord>): GoogleConnectionStore {
  const conn: GoogleConnectionRecord | undefined = connection
    ? {
        domain: 'example.com',
        connectionType: 'ga4',
        propertyId: '987654321',
        accessToken: 'access',
        refreshToken: 'refresh',
        tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        ...connection,
      }
    : undefined
  return {
    listConnections: () => (conn ? [conn] : []),
    getConnection: () => conn,
    upsertConnection: (record) => record,
    updateConnection: () => conn,
    deleteConnection: () => true,
  }
}

beforeEach(() => {
  verifyConnectionMock.mockReset()
  verifyConnectionWithTokenMock.mockReset()
  refreshAccessTokenMock.mockReset()
})

const gaCheck = GA_AUTH_CHECKS[0]!

describe('ga.auth.connection', () => {
  it('skips when no GA store is configured', async () => {
    const result = await gaCheck.run({ db: {} as DoctorContext['db'], project })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('ga.auth.store-unavailable')
  })

  it('warns when no connection exists for project', async () => {
    const result = await gaCheck.run({ db: {} as DoctorContext['db'], project, ga4CredentialStore: gaStore() })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('ga.auth.no-connection')
  })

  it('returns ok when verifyConnection succeeds', async () => {
    verifyConnectionMock.mockResolvedValue(true)
    const record: Ga4CredentialRecord = {
      projectName: 'demo',
      propertyId: '123456',
      clientEmail: 'svc@project.iam',
      privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }
    const result = await gaCheck.run({ db: {} as DoctorContext['db'], project, ga4CredentialStore: gaStore(record) })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ga.auth.verified')
  })

  it('fails when verifyConnection throws', async () => {
    verifyConnectionMock.mockRejectedValue(new Error('PERMISSION_DENIED'))
    const record: Ga4CredentialRecord = {
      projectName: 'demo',
      propertyId: '123456',
      clientEmail: 'svc@project.iam',
      privateKey: 'key',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }
    const result = await gaCheck.run({ db: {} as DoctorContext['db'], project, ga4CredentialStore: gaStore(record) })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.verify-failed')
    expect(result.details).toMatchObject({ propertyId: '123456' })
  })

  it('fails when service account is incomplete', async () => {
    const record: Ga4CredentialRecord = {
      projectName: 'demo',
      propertyId: '123456',
      clientEmail: '',
      privateKey: '',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }
    const result = await gaCheck.run({ db: {} as DoctorContext['db'], project, ga4CredentialStore: gaStore(record) })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.service-account-incomplete')
  })

  it('returns ok via OAuth when service account is absent', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    verifyConnectionWithTokenMock.mockResolvedValue(true)
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      ga4CredentialStore: gaStore(),
      googleConnectionStore: googleStoreWithGa4({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ga.auth.verified')
    expect(result.details).toMatchObject({ propertyId: '987654321', authMethod: 'oauth' })
  })

  it('reports refresh-failed when OAuth refresh throws', async () => {
    refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant'))
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      googleConnectionStore: googleStoreWithGa4({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.refresh-failed')
    expect(result.details).toMatchObject({ authMethod: 'oauth', error: 'invalid_grant' })
  })

  it('reports verify-failed when OAuth token cannot reach property', async () => {
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'tok', expires_in: 3600 })
    verifyConnectionWithTokenMock.mockRejectedValue(new Error('PERMISSION_DENIED'))
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      googleConnectionStore: googleStoreWithGa4({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.verify-failed')
    expect(result.details).toMatchObject({ authMethod: 'oauth' })
  })

  it('reports no-property-selected for OAuth connection without propertyId', async () => {
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      googleConnectionStore: googleStoreWithGa4({ propertyId: null }),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.no-property-selected')
  })

  it('reports no-refresh-token for OAuth connection missing refreshToken', async () => {
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      googleConnectionStore: googleStoreWithGa4({ refreshToken: null }),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.no-refresh-token')
  })

  it('reports oauth-not-configured when client credentials are missing', async () => {
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      googleConnectionStore: googleStoreWithGa4({}),
      getGoogleAuthConfig: () => ({}),
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('ga.auth.oauth-not-configured')
  })

  it('prefers service account over OAuth when both connections exist', async () => {
    verifyConnectionMock.mockResolvedValue(true)
    const record: Ga4CredentialRecord = {
      projectName: 'demo',
      propertyId: '123456',
      clientEmail: 'svc@project.iam',
      privateKey: 'key',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }
    const result = await gaCheck.run({
      db: {} as DoctorContext['db'],
      project,
      ga4CredentialStore: gaStore(record),
      googleConnectionStore: googleStoreWithGa4({}),
      getGoogleAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret' }),
    })
    expect(result.status).toBe('ok')
    expect(result.details).toMatchObject({ authMethod: 'service-account', propertyId: '123456' })
    expect(refreshAccessTokenMock).not.toHaveBeenCalled()
  })
})

const providersCheck = PROVIDERS_CHECKS[0]!

describe('config.providers', () => {
  it('returns ok when at least one provider is configured', () => {
    const result = providersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      providerSummary: [
        { name: 'gemini', configured: true },
        { name: 'openai', configured: false },
      ],
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('providers.configured')
    expect(result.details).toMatchObject({ configured: ['gemini'] })
  })

  it('warns that AI Visibility is optional when no providers are configured', () => {
    const result = providersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      providerSummary: [
        { name: 'gemini', configured: false },
        { name: 'openai', configured: false },
      ],
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('providers.none-configured')
    expect(result.summary).toContain('Page Health remains available')
    expect(result.remediation).toContain('canonry bootstrap')
  })

  it('skips when summary is unavailable', () => {
    const result = providersCheck.run({ db: {} as DoctorContext['db'], project: null })
    expect(result.status).toBe('skipped')
  })
})

const agentProvidersCheck = PROVIDERS_CHECKS.find((c) => c.id === 'config.agent-providers')!

function agentEntry(id: string, configured: boolean, keySource: 'config' | 'env' | null = null) {
  return { id, label: id, defaultModel: 'm', configured, keySource }
}

describe('config.agent-providers', () => {
  it('returns ok and reports the configured agent providers (incl. deepinfra)', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [
        agentEntry('claude', true, 'env'),
        agentEntry('deepinfra', true, 'config'),
        agentEntry('zai', false),
      ],
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent-providers.configured')
    expect(result.summary).toContain('deepinfra')
    expect(result.details).toMatchObject({ configured: ['claude', 'deepinfra'] })
  })

  it('warns (not fails) when no agent provider has a key', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [agentEntry('claude', false), agentEntry('deepinfra', false)],
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent-providers.none-configured')
    expect(result.remediation).toMatch(/DEEPINFRA_TOKEN/)
  })

  it('warns on an agent.provider pin with no key, even while other providers are configured', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [agentEntry('claude', true, 'config'), agentEntry('deepinfra', false)],
      getAgentPin: () => ({ provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4-Flash', configured: false, envVar: 'DEEPINFRA_TOKEN', modelError: null }),
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent-providers.pin-unconfigured')
    expect(result.remediation).toMatch(/DEEPINFRA_TOKEN/)
    expect(result.details).toMatchObject({ pin: { provider: 'deepinfra' } })
  })

  it('warns when the pinned agent.model does not resolve', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [agentEntry('claude', true, 'config')],
      getAgentPin: () => ({ provider: 'claude', model: 'not-a-model', configured: true, envVar: 'ANTHROPIC_API_KEY', modelError: 'unknown model' }),
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent-providers.pin-model-invalid')
    expect(result.summary).toContain('not-a-model')
  })

  it('names a healthy pin on the ok result', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [agentEntry('claude', true, 'config'), agentEntry('deepinfra', true, 'config')],
      getAgentPin: () => ({ provider: 'deepinfra', model: 'zai-org/GLM-5.2', configured: true, envVar: 'DEEPINFRA_TOKEN', modelError: null }),
    })
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('pinned to deepinfra (zai-org/GLM-5.2)')
  })

  it('skips when the agent provider summary is unavailable (e.g. cloud)', () => {
    const result = agentProvidersCheck.run({ db: {} as DoctorContext['db'], project: null })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent-providers.summary-unavailable')
  })

  it('tells a caller who is not an install administrator nothing', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      callerIsInstanceAdministrator: false,
      getAgentProviderSummary: () => [
        agentEntry('claude', false),
        agentEntry('deepinfra', true, 'config'),
      ],
    })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent-providers.restricted')
    // Which providers exist and that one is configured is most of the answer,
    // so a count is as disclosing as a name.
    expect(result.summary).not.toContain('deepinfra')
    expect(result.summary).not.toMatch(/\d+ of \d+/)
    expect(result.details).toBeUndefined()
  })

  it('treats an unwired caller as the operator, so the CLI doctor is unchanged', () => {
    const result = agentProvidersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      getAgentProviderSummary: () => [agentEntry('deepinfra', true, 'config')],
    })
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('deepinfra')
  })
})
