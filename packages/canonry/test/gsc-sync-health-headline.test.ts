import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { createClient, migrate, notifications, runs, type DatabaseClient } from '@ainyc/canonry-db'
import type { HealthWebhookPayload } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from '../src/config.js'
import { Notifier } from '../src/notifier.js'

// The Search Console auth check refreshes the token live; nothing here may reach Google.
const refreshAccessTokenMock = vi.fn()
vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
  return { ...actual, refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args) }
})

// Imported after the mock is registered so the doctor checks pick it up.
const { createServer } = await import('../src/server.js')
const { GoogleAuthError } = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')

interface DoctorReport {
  checks: Array<{ id: string; category: string; status: string; code: string; summary: string; remediation: string | null; details?: Record<string, unknown> }>
}

// The error the GSC sync stores when a DNS filter refuses the API host.
const SYNC_DNS_ERROR = 'fetch failed (ENOTFOUND resolving www.googleapis.com)'

beforeEach(() => {
  refreshAccessTokenMock.mockReset()
})

/**
 * Three failed Search Console syncs on a connected project, graded by the
 * doctor route, then handed to the notifier: the alert an operator receives.
 */
async function healthAlertForGscSyncFailures(): Promise<{ payload: HealthWebhookPayload | undefined; report: DoctorReport }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gsc-sync-headline-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const now = '2026-09-21T06:00:00.000Z'
  const config = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
    google: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connections: [{
        domain: 'example.com', connectionType: 'gsc', propertyId: 'sc-domain:example.com', sitemapUrl: null,
        accessToken: 'access-token', refreshToken: 'refresh-token', tokenExpiresAt: now,
        scopes: ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/indexing'],
        createdAt: now, updatedAt: now,
      }],
    },
  } as unknown as CanonryConfig
  const previousConfigDir = process.env.CANONRY_CONFIG_DIR
  process.env.CANONRY_CONFIG_DIR = tmpDir
  const app = await createServer({ config, db, logger: false })

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { displayName: 'Example', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(created.statusCode).toBe(201)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      db.insert(runs).values({
        id: `gsc-failed-${day}`, projectId, kind: 'gsc-sync', status: 'failed', trigger: 'scheduled',
        createdAt: `${day}T06:00:00.000Z`, finishedAt: `${day}T06:00:05.000Z`, error: SYNC_DNS_ERROR,
      }).run()
    }
    db.insert(notifications).values({
      id: 'health-hook', projectId, channel: 'webhook',
      config: { url: 'https://hooks.example/health', events: ['health.degraded'] },
      enabled: true, createdAt: now, updatedAt: now,
    } as never).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/example/doctor?check=google.auth.*,gsc.sync.*',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(response.statusCode).toBe(200)
    const report = JSON.parse(response.body) as DoctorReport

    const notifier = new Notifier(db, 'https://canonry.test')
    const sent: HealthWebhookPayload[] = []
    // Capture the alert instead of delivering it.
    const delivery = notifier as unknown as { sendWebhook: (url: string, payload: unknown) => Promise<boolean> }
    vi.spyOn(delivery, 'sendWebhook').mockImplementation(async (_url, payload) => {
      sent.push(payload as HealthWebhookPayload)
      return true
    })
    expect(await notifier.onHealthChecked(projectId, { checks: report.checks, checkedAt: '2026-10-03T12:00:00.000Z' })).toBe('health.degraded')
    return { payload: sent[0], report }
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previousConfigDir
  }
}

it('headlines the sync failure that names DNS when the token refresh cannot reach Google either', async () => {
  // A DNS filter refusing Google fails the auth check's live token refresh as
  // well. That refresh tested no grant, so it must not claim the cause.
  refreshAccessTokenMock.mockRejectedValue(new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), {
      code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'oauth2.googleapis.com',
    }),
  }))

  const { payload } = await healthAlertForGscSyncFailures()

  expect(payload?.health).toMatchObject({ status: 'fail', code: 'gsc.sync.repeated-failures' })
  expect(payload?.health.summary).toContain(SYNC_DNS_ERROR)
  expect(payload?.health.failing.find(check => check.id === 'google.auth.connection')).toMatchObject({
    code: 'google.auth.refresh-unreachable',
    summary: 'Could not reach Google to refresh the GSC token: fetch failed (ENOTFOUND resolving oauth2.googleapis.com)',
  })
})

it('headlines the rejected grant, not the Search Console syncs it breaks', async () => {
  refreshAccessTokenMock.mockRejectedValue(new GoogleAuthError('Token refresh failed (400): invalid_grant'))

  const { payload, report } = await healthAlertForGscSyncFailures()

  expect(payload?.health).toMatchObject({ status: 'fail', code: 'google.auth.refresh-failed' })
  expect(payload?.health.failing.map(check => check.id)).not.toContain('gsc.sync.recent-failures')
  expect(report.checks.find(check => check.id === 'gsc.sync.recent-failures')).toMatchObject({
    status: 'skipped', code: 'gsc.sync.recent-failures.superseded', details: { supersededBy: ['google.auth.connection'], latestError: SYNC_DNS_ERROR },
  })
})
