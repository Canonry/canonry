import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, gbpLocations, migrate, projects } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { GoogleConnectionRecord, GoogleConnectionStore } from '../src/google.js'
import { GOOGLE_TOKEN_URL, GSC_API_BASE, INDEXING_API_BASE, URL_INSPECTION_API } from '../../integration-google/src/constants.js'
import { GA4_ADMIN_API_BASE, GA4_DATA_API_BASE, GOOGLE_TOKEN_URL as GA_TOKEN_URL } from '../../integration-google-analytics/src/constants.js'
import { GBP_ACCOUNT_MANAGEMENT_BASE, GBP_BUSINESS_INFO_BASE, GBP_LEGACY_V4_BASE, GBP_LODGING_BASE, GBP_PERFORMANCE_BASE, GBP_PLACE_ACTIONS_BASE } from '../../integration-google-business-profile/src/constants.js'
import { BING_WMT_API_BASE } from '../../integration-bing/src/constants.js'
import { API_HOST_TABLE } from '../src/doctor/checks/api-hosts.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function buildApp(probe: (host: string) => Promise<{ kind: 'reachable' | 'null-routed' | 'private-address' | 'no-address' | 'resolver-unavailable' | 'connect-failed' | 'tls-failed'; host: string; addresses: string[]; durationMs: number }>, connected = true, integration: 'gsc' | 'gbp' = 'gsc') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-api-hosts-'))
  const db = createClient(path.join(dir, 'doctor.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({ id: projectId, name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  if (integration === 'gbp') {
    db.insert(gbpLocations).values({ id: crypto.randomUUID(), projectId, accountName: 'accounts/1', locationName: 'locations/1', displayName: 'Demo', selected: true, createdAt: now, updatedAt: now }).run()
  }
  const record: GoogleConnectionRecord = { domain: 'example.com', connectionType: integration, propertyId: 'sc-domain:example.com', accessToken: 'token', refreshToken: 'refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), scopes: [], createdAt: now, updatedAt: now }
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
    expect(API_HOST_TABLE.gsc).toEqual([new URL(GSC_API_BASE).hostname, new URL(URL_INSPECTION_API).hostname, new URL(GOOGLE_TOKEN_URL).hostname])
    expect(API_HOST_TABLE.gsc).not.toContain(new URL(INDEXING_API_BASE).hostname)
    expect(API_HOST_TABLE.ga).toEqual([new URL(GA4_DATA_API_BASE).hostname, new URL(GA4_ADMIN_API_BASE).hostname, new URL(GA_TOKEN_URL).hostname])
    expect(API_HOST_TABLE.gbp).toEqual([new URL(GBP_ACCOUNT_MANAGEMENT_BASE).hostname, new URL(GBP_BUSINESS_INFO_BASE).hostname, new URL(GBP_PLACE_ACTIONS_BASE).hostname, new URL(GBP_PERFORMANCE_BASE).hostname, new URL(GBP_LEGACY_V4_BASE).hostname, new URL(GBP_LODGING_BASE).hostname, new URL(GA_TOKEN_URL).hostname])
    expect(API_HOST_TABLE.bing).toEqual([new URL(BING_WMT_API_BASE).hostname])
    expect(API_HOST_TABLE['google-ads']).toEqual(['googleads.googleapis.com', 'oauth2.googleapis.com'])
    expect(API_HOST_TABLE.gtm).toEqual(['tagmanager.googleapis.com', 'oauth2.googleapis.com'])
    expect(API_HOST_TABLE.ads).toEqual(['api.ads.openai.com'])
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
    expect(check.details.hosts).toEqual(API_HOST_TABLE.gsc.map(host => result(host, kind)))
    expect(check.details.hosts.every((host: { kind: string; addresses: string[]; durationMs: number }) => host.kind === kind && host.addresses.length > 0 && host.durationMs === 1)).toBe(true)
    if (kind === 'null-routed') expect(check.remediation).toContain('canonry doctor --project demo --check gsc.api.reachable')
    if (kind === 'null-routed') expect(check.remediation).toContain('canonry google sync demo')
  })

  it('does not report complete reachability when one host could not be resolved', async () => {
    const app = buildApp(async host => result(host, host === 'oauth2.googleapis.com' ? 'resolver-unavailable' : 'reachable'))
    const response = await app.inject({ url: '/api/v1/projects/demo/doctor?check=gsc.api.reachable' })
    expect(response.statusCode).toBe(200)
    expect(response.json().checks[0]).toMatchObject({ status: 'skipped', code: 'gsc.api.probe-unavailable' })
  })

  it('reports a blocked Place Actions host for a connected GBP project with a selected location', async () => {
    const placeActionsHost = 'mybusinessplaceactions.googleapis.com'
    const app = buildApp(async host => result(host, host === placeActionsHost ? 'null-routed' : 'reachable', host === placeActionsHost ? ['0.0.0.0'] : ['192.0.2.10']), true, 'gbp')
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/doctor?check=gbp.api.reachable' })
    expect(response.statusCode).toBe(200)
    const check = response.json().checks[0]
    expect(check).toMatchObject({ status: 'fail', code: 'gbp.api.dns-blocked' })
    expect(check.details.hosts).toContainEqual(result(placeActionsHost, 'null-routed', ['0.0.0.0']))
    expect(check.summary).toContain(placeActionsHost)
    expect(check.remediation).toContain('canonry gbp sync demo')
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
