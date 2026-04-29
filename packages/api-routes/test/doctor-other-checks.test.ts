import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GA_AUTH_CHECKS } from '../src/doctor/checks/ga-auth.js'
import { PROVIDERS_CHECKS } from '../src/doctor/checks/providers.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'

const verifyConnectionMock = vi.fn()

vi.mock('@ainyc/canonry-integration-google-analytics', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google-analytics')>('@ainyc/canonry-integration-google-analytics')
  return {
    ...actual,
    verifyConnection: (...args: unknown[]) => verifyConnectionMock(...args),
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

beforeEach(() => {
  verifyConnectionMock.mockReset()
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

  it('fails when no providers are configured', () => {
    const result = providersCheck.run({
      db: {} as DoctorContext['db'],
      project: null,
      providerSummary: [
        { name: 'gemini', configured: false },
        { name: 'openai', configured: false },
      ],
    })
    expect(result.status).toBe('fail')
    expect(result.code).toBe('providers.none-configured')
  })

  it('skips when summary is unavailable', () => {
    const result = providersCheck.run({ db: {} as DoctorContext['db'], project: null })
    expect(result.status).toBe('skipped')
  })
})
