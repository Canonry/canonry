import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  createClient,
  googleAdsConnections,
  gtmConnections,
  migrate,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { serializeRunError } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

interface DoctorReport {
  checks: Array<{ id: string; status: string; code: string; summary: string; details?: Record<string, unknown> }>
}

/** A server with one project, `example`; `run` gets its id and a doctor reader. */
async function withExampleProject(
  run: (env: { db: DatabaseClient; config: CanonryConfig; projectId: string; doctor: (checks: string) => Promise<DoctorReport> }) => Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-doctor-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
  }
  const previousConfigDir = process.env.CANONRY_CONFIG_DIR
  process.env.CANONRY_CONFIG_DIR = tmpDir
  const app = await createServer({ config, db, logger: false })

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    const doctor = async (checks: string): Promise<DoctorReport> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/example/doctor?check=${checks}`,
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(response.statusCode).toBe(200)
      return JSON.parse(response.body) as DoctorReport
    }
    await run({ db, config, projectId, doctor })
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previousConfigDir
  }
}

it('reports retained Google marketing evidence after disconnect as not connected', async () => {
  await withExampleProject(async ({ db, projectId, doctor }) => {
    const now = '2026-08-14T12:00:00.000Z'

    // These are the durable, redacted rows left by normal disconnect. The
    // private config intentionally has no OAuth entries for either provider.
    db.insert(googleAdsConnections).values({
      id: 'disconnected-ads',
      projectId,
      selectedLoginCustomerId: null,
      selectedCustomerId: null,
      scopes: [],
      lastInventorySnapshotAt: now,
      lastMetricsSnapshotAt: now,
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(gtmConnections).values({
      id: 'disconnected-gtm',
      projectId,
      selectedAccountId: null,
      selectedContainerId: null,
      selectedWorkspaceId: null,
      scopes: [],
      lastSnapshotAt: now,
      createdAt: now,
      updatedAt: now,
    }).run()

    const report = await doctor('google-ads.*,gtm.*')

    expect(report.checks).toHaveLength(11)
    expect(report.checks.every((check) => check.status === 'skipped')).toBe(true)
    expect(report.checks.filter((check) => check.id.startsWith('google-ads.')).map((check) => check.code))
      .toEqual([
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
        'google-ads.auth.not-connected',
        'google-ads.sync.not-connected',
      ])
    expect(report.checks.filter((check) => check.id.startsWith('gtm.')).map((check) => check.code))
      .toEqual([
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.auth.not-connected',
        'gtm.runtime.not-connected',
        'gtm.sync.not-connected',
      ])
  })
})

it('fails Google Ads sync health once the last three syncs of a connected project failed', async () => {
  await withExampleProject(async ({ db, config, projectId, doctor }) => {
    const now = '2026-09-21T06:00:00.000Z'
    db.insert(googleAdsConnections).values({
      id: 'connected-ads', projectId, selectedCustomerId: '1234567890', scopes: [], createdAt: now, updatedAt: now,
    }).run()
    config.googleAds = {
      connections: [{ projectId, projectName: 'example', accessToken: 'access-token-value', createdAt: now, updatedAt: now }],
    }
    // The run error the Google Ads executor stores when DNS filtering
    // null-routes the API host.
    const error = 'Google Ads API request failed: fetch failed (ECONNREFUSED connecting to googleads.googleapis.com at 0.0.0.0:443)'
    db.insert(runs).values({ id: 'ads-ok', projectId, kind: 'google-ads-sync', status: 'completed', trigger: 'manual', createdAt: now, finishedAt: now }).run()
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      db.insert(runs).values({
        id: `ads-failed-${day}`, projectId, kind: 'google-ads-sync', status: 'failed', trigger: 'manual',
        createdAt: `${day}T06:00:00.000Z`, finishedAt: `${day}T06:00:05.000Z`, error: serializeRunError({ message: error }),
      }).run()
    }

    const report = await doctor('google-ads.sync.*')

    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({
      id: 'google-ads.sync.recent-failures',
      status: 'fail',
      code: 'google-ads.sync.repeated-failures',
      details: { consecutiveFailures: 3, latestError: error, lastSuccessAt: now },
    })
  })
})
