import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WordpressApiError } from '@ainyc/canonry-integration-wordpress'
import type { WordpressConnectionRecord } from '@ainyc/canonry-integration-wordpress'
import { WORDPRESS_PUBLISH_CHECKS } from '../src/doctor/checks/wordpress-publish.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { WordpressConnectionStore } from '../src/wordpress.js'

const verifyMock = vi.fn()

vi.mock('@ainyc/canonry-integration-wordpress', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-wordpress')>(
    '@ainyc/canonry-integration-wordpress',
  )
  return {
    ...actual,
    verifyWordpressConnection: (...args: unknown[]) => verifyMock(...args),
  }
})

const project: ProjectInfo = {
  id: 'p1',
  name: 'demo',
  canonicalDomain: 'example.com',
  displayName: 'Demo',
}

function buildStore(connection?: Partial<WordpressConnectionRecord>): WordpressConnectionStore {
  const conn: WordpressConnectionRecord | undefined = connection
    ? {
        projectName: 'demo',
        url: 'https://example.com',
        username: 'admin',
        appPassword: 'app-pass',
        defaultEnv: 'live',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        ...connection,
      }
    : undefined
  return {
    getConnection: () => conn,
    upsertConnection: (record) => record,
    updateConnection: () => conn,
  }
}

function ctx(overrides: Partial<DoctorContext>): DoctorContext {
  return {
    db: {} as DoctorContext['db'],
    project,
    wordpressConnectionStore: buildStore({}),
    ...overrides,
  }
}

beforeEach(() => {
  verifyMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('wordpress.publish.connection', () => {
  const check = WORDPRESS_PUBLISH_CHECKS.find((c) => c.id === 'wordpress.publish.connection')!

  it('returns ok when the connection verifies', async () => {
    verifyMock.mockResolvedValue({
      url: 'https://example.com',
      reachable: true,
      pageCount: 12,
      version: '6.8.1',
      plugins: [],
    })
    const result = await check.run(ctx({}))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('wordpress.publish.connected')
    expect(result.details).toMatchObject({
      url: 'https://example.com',
      pageCount: 12,
      wordpressVersion: '6.8.1',
    })
  })

  it('skips when the project has no WordPress connection', async () => {
    const result = await check.run(ctx({ wordpressConnectionStore: buildStore() }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('wordpress.publish.not-configured')
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it('fails as unauthorized when the application password is rejected', async () => {
    verifyMock.mockRejectedValue(new WordpressApiError('AUTH_INVALID', 'Authentication failed', 401))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('wordpress.publish.unauthorized')
  })

  it('fails as verification-failed when the site is unreachable', async () => {
    verifyMock.mockRejectedValue(new Error('fetch failed'))
    const result = await check.run(ctx({}))
    expect(result.status).toBe('fail')
    expect(result.code).toBe('wordpress.publish.verification-failed')
    expect(result.details).toMatchObject({ error: 'fetch failed' })
  })

  it('skips when there is no project context', async () => {
    const result = await check.run(ctx({ project: null }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('wordpress.publish.no-project')
  })

  it('skips when the connection store is unavailable', async () => {
    const result = await check.run(ctx({ wordpressConnectionStore: undefined }))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('wordpress.publish.store-unavailable')
  })
})
