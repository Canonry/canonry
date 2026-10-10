import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects } from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))

const { createServer } = await import('../src/server.js')

const NOW = '2026-10-09T12:00:00.000Z'

describe('sync outcomes reported by the server', () => {
  it('reports a requested sync the server cannot start without a Google OAuth client, attributed to the request', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sync-outcome-server-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)
    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: 'key_1', name: 'test', keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 9), scopes: ['*'], createdAt: NOW,
    }).run()
    db.insert(projects).values({
      id: 'project_1', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example.com',
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    const connection = (connectionType: 'gsc' | 'gbp') => ({
      domain: 'harborline.example.com', connectionType, propertyId: connectionType === 'gsc' ? 'sc-domain:harborline.example.com' : null,
      accessToken: 'tok', refreshToken: 'rt', tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [], createdAt: NOW, updatedAt: NOW,
    })
    // Connections without the OAuth client that refreshes them.
    const config = {
      apiUrl: 'http://localhost:4100', database: dbPath, apiKey: rawKey,
      google: { connections: [connection('gsc'), connection('gbp')] },
    } as unknown as CanonryConfig

    const app = await createServer({ config, db, logger: false })
    try {
      const cli = { authorization: `Bearer ${rawKey}`, 'user-agent': 'canonry-cli/7.19.0', 'x-canonry-surface': 'cli' }
      const scheduler = { ...cli, 'x-canonry-surface': 'system', 'x-canonry-agent': 'claude' }
      trackEvent.mockReset()
      const responses = [
        await app.inject({ method: 'POST', url: '/api/v1/projects/harborline/google/gsc/sync', headers: cli, payload: {} }),
        await app.inject({ method: 'POST', url: '/api/v1/projects/harborline/google/gsc/inspect-sitemap', headers: cli, payload: {} }),
        await app.inject({ method: 'POST', url: '/api/v1/projects/harborline/gbp/sync', headers: scheduler, payload: {} }),
      ]

      expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200])
      expect(trackEvent.mock.calls.filter((call) => call[0] === 'feature.completed').map((call) => call.slice(1))).toEqual([
        [
          {
            feature: 'search_console', operation: 'sync', trigger: 'manual', surface: 'cli',
            status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s',
          },
          { errorCode: 'NOT_CONNECTED' },
        ],
        [
          {
            feature: 'search_console', operation: 'inspect', trigger: 'manual', surface: 'cli',
            status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s',
          },
          { errorCode: 'NOT_CONNECTED' },
        ],
        [
          {
            feature: 'gbp', operation: 'sync', trigger: 'scheduled', surface: 'system',
            status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s',
          },
          { errorCode: 'NOT_CONNECTED' },
        ],
      ])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
