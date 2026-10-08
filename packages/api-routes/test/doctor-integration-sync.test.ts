import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, gbpLocations, migrate, projects, runs } from '@ainyc/canonry-db'
import { serializeRunError } from '@ainyc/canonry-contracts'
import { INTEGRATION_SYNC_CHECKS } from '../src/doctor/checks/integration-sync.js'
import type { GoogleMarketingDoctorInput } from '../src/doctor/checks/google-marketing.js'
import { ALL_CHECKS, scheduledHealthCheckIds } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'
import type { CheckDefinition, DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

// A queued sync answers its endpoint before any provider call, so a sync that
// fails every day leaves only failed run rows behind. These pin when that
// becomes a doctor failure, and when it must stay quiet.

const byId = (id: string): CheckDefinition => {
  const found = INTEGRATION_SYNC_CHECKS.find(check => check.id === id)
  if (!found) throw new Error(`no check ${id}`)
  return found
}
const adsCheck = byId('google-ads.sync.recent-failures')
const gscCheck = byId('gsc.sync.recent-failures')
const gbpCheck = byId('gbp.sync.recent-failures')
const gaCheck = byId('ga.sync.recent-failures')

// The run error each executor writes: Google Ads and GBP store a serialized
// `RunErrorDto`, the GSC and GA4 syncs the plain message.
const ADS_NETWORK_ERROR = 'Google Ads API request failed: fetch failed (ECONNREFUSED connecting to googleads.googleapis.com at 0.0.0.0:443)'
const GBP_NO_LOCATIONS_ERROR = 'No selected GBP locations to sync. Discover and select locations first.'
const GA_NO_CREDENTIALS_ERROR = 'No GA4 credentials found. Run "canonry ga connect <project> --key-file <path>" or "canonry google connect <project> --type ga4" to authenticate.'
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

type StoredConnection = { createdAt?: string }
function store(connected: Partial<Record<'gsc' | 'gbp' | 'ga4', StoredConnection>>): GoogleConnectionStore {
  return {
    getConnection: (_domain: string, type: 'gsc' | 'gbp' | 'ga4') => {
      const connection = connected[type]
      return connection ? ({ connectionType: type, ...connection } as never) : undefined
    },
  } as unknown as GoogleConnectionStore
}

describe('integration sync failure checks', () => {
  let tmp: string
  let db: ReturnType<typeof createClient>
  let project: ProjectInfo

  // What the server's Google marketing resolver reports: a connection only
  // while an OAuth credential exists, never from a retained connection row.
  let marketing: GoogleMarketingDoctorInput
  const ctx = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    db, project, getGoogleMarketingDoctorInput: () => marketing, ...overrides,
  })
  const connectGoogleAds = () => {
    marketing = {
      ...marketing,
      googleAds: {
        credentialsPresent: true, grantedScopes: ['https://www.googleapis.com/auth/adwords'],
        selectedLoginCustomerId: null, selectedCustomerId: '1234567890', latestSnapshotAt: null,
      },
    }
  }
  const run = (kind: 'google-ads-sync' | 'gsc-sync' | 'gbp-sync' | 'ga-sync', status: string, createdAt: string, error: string | null = null) => {
    db.insert(runs).values({
      id: crypto.randomUUID(), projectId: project.id, kind, status, trigger: 'manual', createdAt,
      ...(status === 'queued' || status === 'running' ? {} : { finishedAt: new Date(Date.parse(createdAt) + 60_000).toISOString() }),
      error,
    }).run()
  }
  const adsFailure = (createdAt: string) => run('google-ads-sync', 'failed', createdAt, serializeRunError({ message: ADS_NETWORK_ERROR }))

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-integration-sync-'))
    db = createClient(path.join(tmp, 'test.db'))
    migrate(db)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id, name: 'client', displayName: 'client', canonicalDomain: 'client.example', country: 'US', language: 'en',
      providers: [], createdAt: now, updatedAt: now,
    } as typeof projects.$inferInsert).run()
    project = { id, name: 'client', canonicalDomain: 'client.example', displayName: 'client' }
    marketing = { googleAds: null, gtm: null }
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('fails after three straight failures, naming the latest error, the streak, and the last success', async () => {
    connectGoogleAds()
    const lastSuccessStarted = daysAgo(17)
    run('google-ads-sync', 'completed', lastSuccessStarted)
    for (const days of [16, 3, 2, 1]) adsFailure(daysAgo(days))
    // Neither an in-flight nor a cancelled run proves the sync works again.
    run('google-ads-sync', 'cancelled', daysAgo(0.5))
    run('google-ads-sync', 'queued', daysAgo(0.1))

    const result = await adsCheck.run(ctx())

    const lastSuccessAt = new Date(Date.parse(lastSuccessStarted) + 60_000).toISOString()
    expect(result).toMatchObject({
      status: 'fail',
      code: 'google-ads.sync.repeated-failures',
      details: { consecutiveFailures: 4, latestStatus: 'failed', latestError: ADS_NETWORK_ERROR, lastSuccessAt, runKind: 'google-ads-sync', window: 3 },
    })
    expect(result.summary).toBe(`The last 4 Google Ads syncs failed (last success: ${lastSuccessAt}). Latest error: ${ADS_NETWORK_ERROR}`)
    expect(result.remediation).toContain('canonry google-ads sync client')
  })

  it('reports a sync that never succeeded as last success "never"', async () => {
    connectGoogleAds()
    for (const days of [3, 2, 1]) adsFailure(daysAgo(days))

    const result = await adsCheck.run(ctx())

    expect(result).toMatchObject({ status: 'fail', code: 'google-ads.sync.repeated-failures', details: { consecutiveFailures: 3, lastSuccessAt: null } })
    expect(result.summary).toContain('(last success: never)')
  })

  it('is ok when a success sits among the latest three, or fewer than three have failed', async () => {
    connectGoogleAds()
    adsFailure(daysAgo(3))
    run('google-ads-sync', 'partial', daysAgo(2))
    adsFailure(daysAgo(1))
    expect(await adsCheck.run(ctx())).toMatchObject({
      status: 'ok', code: 'google-ads.sync.ok', details: { consecutiveFailures: 1, latestStatus: 'failed', latestError: ADS_NETWORK_ERROR },
    })

    db.delete(runs).run()
    adsFailure(daysAgo(2))
    adsFailure(daysAgo(1))
    expect(await adsCheck.run(ctx())).toMatchObject({ status: 'ok', code: 'google-ads.sync.ok', details: { consecutiveFailures: 2, lastSuccessAt: null } })
  })

  it('skips an integration that is not connected, even with old failures on record, and one with no finished runs', async () => {
    for (const days of [3, 2, 1]) adsFailure(daysAgo(days))
    expect(await adsCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'google-ads.sync.not-connected' })
    expect(await adsCheck.run(ctx({ getGoogleMarketingDoctorInput: undefined }))).toMatchObject({ status: 'skipped', code: 'google-ads.sync.store-unavailable' })

    db.delete(runs).run()
    connectGoogleAds()
    run('google-ads-sync', 'queued', daysAgo(0))
    expect(await adsCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'google-ads.sync.no-runs' })
  })

  it('reads a plain-text run error and skips a deployment without a Google connection store', async () => {
    for (const days of [3, 2, 1]) run('gsc-sync', 'failed', daysAgo(days), 'fetch failed')

    expect(await gscCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'gsc.sync.store-unavailable' })
    expect(await gscCheck.run(ctx({ googleConnectionStore: store({ gbp: {} }) }))).toMatchObject({ status: 'skipped', code: 'gsc.sync.not-connected' })
    const result = await gscCheck.run(ctx({ googleConnectionStore: store({ gsc: {} }) }))
    expect(result).toMatchObject({ status: 'fail', code: 'gsc.sync.repeated-failures', details: { latestError: 'fetch failed' } })
    expect(result.remediation).toContain('canonry google sync client')
  })

  it('skips a GBP connection until the project selects a location, then grades only gbp-sync runs', async () => {
    // Every project on the domain shares the GBP connection, so the data
    // refresh syncs projects that never selected a location, and each sync fails.
    for (const days of [3, 2, 1]) run('gbp-sync', 'failed', daysAgo(days), serializeRunError({ message: GBP_NO_LOCATIONS_ERROR }))
    const connected = ctx({ googleConnectionStore: store({ gbp: {} }) })
    expect(await gbpCheck.run(connected)).toMatchObject({ status: 'skipped', code: 'gbp.sync.no-selected-locations' })
    expect(await gbpCheck.run(ctx({ googleConnectionStore: store({ gsc: {} }) }))).toMatchObject({ status: 'skipped', code: 'gbp.sync.not-connected' })
    expect(await gbpCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'gbp.sync.store-unavailable' })

    const location = (id: string, selected: boolean) => db.insert(gbpLocations).values({
      id, projectId: project.id, accountName: 'accounts/123', locationName: `locations/${id}`, displayName: id,
      selected, createdAt: daysAgo(4), updatedAt: daysAgo(4),
    }).run()
    location('deselected', false)
    expect(await gbpCheck.run(connected)).toMatchObject({ status: 'skipped', code: 'gbp.sync.no-selected-locations' })

    location('selected', true)
    expect(await gbpCheck.run(connected)).toMatchObject({
      status: 'fail', code: 'gbp.sync.repeated-failures', details: { runKind: 'gbp-sync', consecutiveFailures: 3, latestError: GBP_NO_LOCATIONS_ERROR },
    })
    expect((await gbpCheck.run(connected)).remediation).toContain('canonry gbp sync client')

    // A Search Console failure streak is not a GBP one.
    db.delete(runs).run()
    for (const days of [3, 2, 1]) run('gsc-sync', 'failed', daysAgo(days), 'fetch failed')
    expect(await gbpCheck.run(connected)).toMatchObject({ status: 'skipped', code: 'gbp.sync.no-runs' })
  })

  it('grades only GA4 syncs since the current connection, ignoring failures from before GA4 was connected', async () => {
    // The GA4 sync writes its run before it resolves credentials, so a
    // project without GA4 collects one failed run per data refresh.
    for (const days of [10, 9, 8, 7]) run('ga-sync', 'failed', daysAgo(days), GA_NO_CREDENTIALS_ERROR)
    expect(await gaCheck.run(ctx())).toMatchObject({ status: 'skipped', code: 'ga.sync.store-unavailable' })
    expect(await gaCheck.run(ctx({ googleConnectionStore: store({ gsc: {} }) }))).toMatchObject({ status: 'skipped', code: 'ga.sync.not-connected' })

    const oauth = ctx({ googleConnectionStore: store({ ga4: { createdAt: daysAgo(5) } }) })
    expect(await gaCheck.run(oauth)).toMatchObject({ status: 'skipped', code: 'ga.sync.no-runs' })

    run('ga-sync', 'completed', daysAgo(4))
    expect(await gaCheck.run(oauth)).toMatchObject({ status: 'ok', code: 'ga.sync.ok', details: { runKind: 'ga-sync', consecutiveFailures: 0 } })

    for (const days of [3, 2, 1]) run('ga-sync', 'failed', daysAgo(days), 'GA4 API error (503): unavailable')
    const result = await gaCheck.run(oauth)
    expect(result).toMatchObject({ status: 'fail', code: 'ga.sync.repeated-failures', details: { consecutiveFailures: 3, latestError: 'GA4 API error (503): unavailable' } })
    expect(result.remediation).toContain('canonry ga sync client')

    // A service account is the credential the sync uses first, so its
    // connection time bounds the window.
    const ga4CredentialStore = {
      getConnection: (name: string) => (name === 'client' ? ({ propertyId: '1', createdAt: daysAgo(1.5) } as never) : undefined),
    } as unknown as DoctorContext['ga4CredentialStore']
    expect(await gaCheck.run(ctx({ ga4CredentialStore }))).toMatchObject({ status: 'ok', code: 'ga.sync.ok', details: { consecutiveFailures: 1 } })
  })

  it('skips every integration without a project context', async () => {
    for (const check of INTEGRATION_SYNC_CHECKS) {
      const prefix = check.id.replace('.sync.recent-failures', '')
      expect(await check.run(ctx({ project: undefined }))).toMatchObject({ status: 'skipped', code: `${prefix}.sync.no-project` })
    }
  })

  it('runs in the scheduled health pass, so a repeated failure reaches health alerts', async () => {
    connectGoogleAds()
    for (const days of [3, 2, 1]) adsFailure(daysAgo(days))

    const report = await runChecks(ctx(), ALL_CHECKS, { checkIds: scheduledHealthCheckIds() })

    expect(report.checks.find(check => check.id === 'google-ads.sync.recent-failures')).toMatchObject({
      status: 'fail', code: 'google-ads.sync.repeated-failures',
    })
  })
})
