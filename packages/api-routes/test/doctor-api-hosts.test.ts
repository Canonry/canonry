import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'
import { GOOGLE_TOKEN_URL, GSC_API_BASE, URL_INSPECTION_API } from '../../integration-google/src/constants.js'
import { GA4_ADMIN_API_BASE, GA4_DATA_API_BASE, GOOGLE_TOKEN_URL as GA_TOKEN_URL } from '../../integration-google-analytics/src/constants.js'
import { GBP_ACCOUNT_MANAGEMENT_BASE, GBP_BUSINESS_INFO_BASE, GBP_LEGACY_V4_BASE, GBP_LODGING_BASE, GBP_PERFORMANCE_BASE } from '../../integration-google-business-profile/src/constants.js'
import { BING_WMT_API_BASE } from '../../integration-bing/src/constants.js'
import { API_HOST_TABLE } from '../src/doctor/checks/api-hosts.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function buildApp(probe: (host: string) => Promise<{ kind: 'reachable' | 'null-routed' | 'private-address' | 'no-address' | 'resolver-unavailable' | 'connect-failed' | 'tls-failed'; host: string; addresses: string[]; durationMs: number }>, connected = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-api-hosts-'))
  const db = createClient(path.join(dir, 'doctor.db'))
  migrate(db)
  db.insert(projects).values({ id: crypto.randomUUID(), name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
  const record: GoogleConnectionRecord = { domain: 'example.com', connectionType: 'gsc', propertyId: 'sc-domain:example.com', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), scopes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const store: GoogleConnectionStore = {
    getConnection: () => connected ? record : undefined,
    listConnections: () => connected ? [record] : [],
    upsertConnection: value => value,
    updateConnection: () => connected ? record : undefined,
    deleteConnection: () => true,
  }
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, googleConnectionStore: store, googleStateSecret: 'api-host-test-secret-long-enough', probeApiHost: probe })
  cleanups.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return app
}

function result(host: string, kind: 'reachable' | 'null-routed' | 'private-address' | 'no-address' | 'resolver-unavailable' | 'connect-failed' | 'tls-failed', addresses = ['192.0.2.10']) {
  return { host, kind, addresses, durationMs: 1 }
}

describe('provider API host doctor checks', () => {
  it('keeps the supported provider host table aligned with integration constants', () => {
    expect(API_HOST_TABLE.gsc).toEqual(expect.arrayContaining([new URL(GSC_API_BASE).hostname, new URL(URL_INSPECTION_API).hostname, new URL(GOOGLE_TOKEN_URL).hostname]))
    expect(API_HOST_TABLE.ga).toEqual(expect.arrayContaining([new URL(GA4_DATA_API_BASE).hostname, new URL(GA4_ADMIN_API_BASE).hostname, new URL(GA_TOKEN_URL).hostname]))
    expect(API_HOST_TABLE.gbp).toEqual(expect.arrayContaining([new URL(GBP_ACCOUNT_MANAGEMENT_BASE).hostname, new URL(GBP_BUSINESS_INFO_BASE).hostname, new URL(GBP_LEGACY_V4_BASE).hostname, new URL(GBP_PERFORMANCE_BASE).hostname, new URL(GBP_LODGING_BASE).hostname]))
    expect(API_HOST_TABLE.bing).toEqual([new URL(BING_WMT_API_BASE).hostname])
  })

  it.each([
    ['reachable', 'ok'], ['private-address', 'private-address'], ['connect-failed', 'connect-failed'], ['tls-failed', 'tls-failed'], ['resolver-unavailable', 'probe-unavailable'],
  ] as const)('grades %s', async (kind, code) => {
    const app = buildApp(async host => result(host, kind))
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/doctor?check=gsc.api.reachable' })
    expect(response.statusCode).toBe(200)
    const check = JSON.parse(response.payload).checks[0]
    expect(check.code).toBe(`gsc.api.${code}`)
    expect(check.details.hosts).toHaveLength(3)
  })

  it('names a null-routed host and skips disconnected integrations', async () => {
    const app = buildApp(async host => result(host, host === 'www.googleapis.com' ? 'null-routed' : 'reachable', host === 'www.googleapis.com' ? ['0.0.0.0'] : ['192.0.2.10']))
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/doctor?check=gsc.api.reachable' })
    const check = JSON.parse(response.payload).checks[0]
    expect(check.code).toBe('gsc.api.dns-blocked')
    expect(check.summary).toContain('www.googleapis.com')
    expect(check.summary).toContain('0.0.0.0')

    const disconnected = buildApp(async host => result(host, 'reachable'), false)
    await disconnected.ready()
    const skipped = await disconnected.inject({ method: 'GET', url: '/api/v1/projects/demo/doctor?check=gsc.api.reachable' })
    expect(JSON.parse(skipped.payload).checks[0].code).toBe('gsc.api.not-connected')
  })
})
