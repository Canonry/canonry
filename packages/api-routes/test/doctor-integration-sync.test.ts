import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, gbpLocations, migrate, projects, runs } from '@ainyc/canonry-db'
import { CheckCategories, GBP_NO_SELECTED_LOCATIONS_ERROR, serializeRunError } from '@ainyc/canonry-contracts'
import { INTEGRATION_SYNC_CHECKS } from '../src/doctor/checks/integration-sync.js'
import type { GoogleMarketingDoctorInput } from '../src/doctor/checks/google-marketing.js'
import { ALL_CHECKS, scheduledHealthCheckIds } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'
import type { CheckDefinition, DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

// The Search Console auth checks refresh the token live; nothing here may reach Google.
const refreshAccessTokenMock = vi.fn()
vi.mock('@ainyc/canonry-integration-google', async () => {
  const actual = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
  return { ...actual, refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args) }
})

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
const GA_NO_CREDENTIALS_ERROR = 'No GA4 credentials found. Run "canonry ga connect <project> --key-file <path>" or "canonry google connect <project> --type ga4" to authenticate.'
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

type StoredConnection = { createdAt?: string; refreshToken?: string; propertyId?: string; scopes?: string[] }
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
  // Stored exactly as the GBP sync stores it (`packages/canonry/src/gbp-sync.ts`).
  const gbpNothingToSync = (createdAt: string) => run('gbp-sync', 'failed', createdAt, serializeRunError({ message: GBP_NO_SELECTED_LOCATIONS_ERROR }))
  const selectGbpLocation = () => db.insert(gbpLocations).values({
    id: 'selected', projectId: project.id, accountName: 'accounts/123', locationName: 'locations/selected', displayName: 'selected',
    selected: true, createdAt: daysAgo(30), updatedAt: daysAgo(30),
  }).run()

  beforeEach(() => {
    refreshAccessTokenMock.mockReset()
    refreshAccessTokenMock.mockRejectedValue(new Error('unexpected token refresh'))
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

  it('skips a GBP connection until the project selects a location, then grades only gbp-sync runs that had work', async () => {
    // Every project on the domain shares the GBP connection, so the data
    // refresh syncs projects that never selected a location, and each sync fails.
    for (const days of [3, 2, 1]) gbpNothingToSync(daysAgo(days))
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

    // Those failures had nothing to sync, so selecting a location starts
    // the grading fresh rather than paging on them at once.
    location('selected', true)
    expect(await gbpCheck.run(connected)).toMatchObject({ status: 'skipped', code: 'gbp.sync.no-runs' })

    for (const days of [0.9, 0.8, 0.7]) run('gbp-sync', 'failed', daysAgo(days), serializeRunError({ message: 'GBP API error (503): unavailable' }))
    const result = await gbpCheck.run(connected)
    expect(result).toMatchObject({
      status: 'fail', code: 'gbp.sync.repeated-failures', details: { runKind: 'gbp-sync', consecutiveFailures: 3, latestError: 'GBP API error (503): unavailable' },
    })
    expect(result.remediation).toContain('canonry gbp sync client')

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

  it('counts a GBP streak only from runs that had a location to sync, through weeks of by-design failures', async () => {
    const connected = ctx({ googleConnectionStore: store({ gbp: {} }) })
    // A success while a location was selected, then weeks with none selected:
    // every daily sync in between failed with nothing to sync.
    const successStarted = daysAgo(40)
    run('gbp-sync', 'completed', successStarted)
    for (let days = 30; days >= 3; days--) gbpNothingToSync(daysAgo(days))
    selectGbpLocation()

    const GBP_DNS_ERROR = 'fetch failed (ENOTFOUND resolving mybusinessbusinessinformation.googleapis.com)'
    const gbpFailure = (days: number) => run('gbp-sync', 'failed', daysAgo(days), serializeRunError({ message: GBP_DNS_ERROR }))
    gbpFailure(2)
    gbpFailure(1)
    expect(await gbpCheck.run(connected)).toMatchObject({
      status: 'ok', code: 'gbp.sync.ok', details: { consecutiveFailures: 2, latestError: GBP_DNS_ERROR },
    })

    gbpFailure(0.5)
    const lastSuccessAt = new Date(Date.parse(successStarted) + 60_000).toISOString()
    const result = await gbpCheck.run(connected)
    // Without the exclusion, the 28 by-design failures would also count.
    expect(result).toMatchObject({
      status: 'fail', code: 'gbp.sync.repeated-failures', details: { consecutiveFailures: 3, lastSuccessAt, latestError: GBP_DNS_ERROR },
    })
    expect(result.summary).toBe(`The last 3 Google Business Profile syncs failed (last success: ${lastSuccessAt}). Latest error: ${GBP_DNS_ERROR}`)
  })

  it('counts the GA4 streak and the last success over the same runs, from the current connection', async () => {
    const connectedAt = daysAgo(5)
    const oauth = ctx({ googleConnectionStore: store({ ga4: { createdAt: connectedAt } }) })
    // A success under an earlier connection, then failures before this one.
    run('ga-sync', 'completed', daysAgo(8))
    for (const days of [7, 6]) run('ga-sync', 'failed', daysAgo(days), GA_NO_CREDENTIALS_ERROR)
    for (const days of [3, 2, 1]) run('ga-sync', 'failed', daysAgo(days), 'GA4 API error (503): unavailable')

    const result = await gaCheck.run(oauth)

    // Not "3 failed, last success 8 days ago": 5 failed since then. Both
    // fields describe this connection's runs, and say so.
    expect(result).toMatchObject({
      status: 'fail', code: 'ga.sync.repeated-failures',
      details: { consecutiveFailures: 3, lastSuccessAt: null, gradedSince: connectedAt },
    })
    expect(result.summary).toBe(`The last 3 GA4 syncs failed (last success: none since connecting at ${connectedAt}). Latest error: GA4 API error (503): unavailable`)

    // A success under this connection is its last success.
    const successStarted = daysAgo(4)
    run('ga-sync', 'completed', successStarted)
    expect(await gaCheck.run(oauth)).toMatchObject({
      status: 'fail', details: { consecutiveFailures: 3, lastSuccessAt: new Date(Date.parse(successStarted) + 60_000).toISOString() },
    })
  })

  it('is superseded by each integration\'s auth checks, which are registered auth checks', () => {
    for (const check of INTEGRATION_SYNC_CHECKS) {
      expect(check.supersededBy?.length, check.id).toBeGreaterThan(0)
      for (const causeId of check.supersededBy ?? []) {
        const cause = ALL_CHECKS.find(candidate => candidate.id === causeId)
        expect(cause, `${check.id} -> ${causeId}`).toMatchObject({ category: CheckCategories.auth, scope: check.scope })
        expect(scheduledHealthCheckIds()).toContain(causeId)
      }
    }
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

  it('stands aside in the scheduled health pass while a Google Ads auth check fails', async () => {
    connectGoogleAds()
    marketing = { ...marketing, googleAds: { ...marketing.googleAds!, grantedScopes: [] } }
    for (const days of [3, 2, 1]) adsFailure(daysAgo(days))

    const report = await runChecks(ctx(), ALL_CHECKS, { checkIds: scheduledHealthCheckIds() })

    expect(report.checks.find(check => check.id === 'google-ads.auth.scopes')).toMatchObject({ status: 'fail', code: 'google-ads.auth.required-scope-missing' })
    expect(report.checks.find(check => check.id === 'google-ads.sync.recent-failures')).toMatchObject({
      status: 'skipped',
      code: 'google-ads.sync.recent-failures.superseded',
      details: { supersededBy: ['google-ads.auth.scopes'], supersededCode: 'google-ads.sync.repeated-failures', consecutiveFailures: 3 },
    })
  })
  // Search Console as a scheduled pass sees it: a connection with a refresh
  // token and the scopes it needs, and the last three syncs failing on DNS.
  const GSC_DNS_ERROR = 'fetch failed (ENOTFOUND resolving www.googleapis.com)'
  const gscWithFailingSyncs = (): DoctorContext => {
    for (const days of [3, 2, 1]) run('gsc-sync', 'failed', daysAgo(days), GSC_DNS_ERROR)
    return ctx({
      getGoogleAuthConfig: () => ({ clientId: 'client-id', clientSecret: 'client-secret' }),
      googleConnectionStore: store({
        gsc: {
          refreshToken: 'refresh-token', propertyId: 'sc-domain:client.example',
          scopes: ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/indexing'],
        },
      }),
    })
  }

  it('keeps a network sync failure leading while the auth check cannot reach Google either', async () => {
    // What Node's fetch rejects with when the resolver refuses the token host.
    refreshAccessTokenMock.mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), {
        code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'oauth2.googleapis.com',
      }),
    }))

    const report = await runChecks(gscWithFailingSyncs(), ALL_CHECKS, { checkIds: scheduledHealthCheckIds() })

    // The auth check tested no grant, so it says Google was unreachable rather
    // than that the token was rejected, and names no cause for the syncs.
    const auth = report.checks.find(check => check.id === 'google.auth.connection')
    expect(auth).toMatchObject({ status: 'fail', code: 'google.auth.refresh-unreachable' })
    expect(auth?.summary).toContain('ENOTFOUND resolving oauth2.googleapis.com')
    const sync = report.checks.find(check => check.id === 'gsc.sync.recent-failures')
    expect(sync).toMatchObject({ status: 'fail', code: 'gsc.sync.repeated-failures', details: { latestError: GSC_DNS_ERROR } })
    expect(sync?.summary).toContain(GSC_DNS_ERROR)
  })

  it('stands aside while Google rejects the Search Console grant', async () => {
    const { GoogleAuthError } = await vi.importActual<typeof import('@ainyc/canonry-integration-google')>('@ainyc/canonry-integration-google')
    refreshAccessTokenMock.mockRejectedValue(new GoogleAuthError('Token refresh failed (400): invalid_grant'))

    const report = await runChecks(gscWithFailingSyncs(), ALL_CHECKS, { checkIds: scheduledHealthCheckIds() })

    expect(report.checks.find(check => check.id === 'google.auth.connection')).toMatchObject({ status: 'fail', code: 'google.auth.refresh-failed' })
    expect(report.checks.find(check => check.id === 'gsc.sync.recent-failures')).toMatchObject({
      status: 'skipped', code: 'gsc.sync.recent-failures.superseded', details: { supersededBy: ['google.auth.connection'], latestError: GSC_DNS_ERROR },
    })
  })
})
