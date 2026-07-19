import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { AppError } from '@ainyc/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  runs,
  auditLog,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
  adsOperations,
} from '@ainyc/canonry-db'
import { adsRoutes } from '../src/ads.js'
import type { AdsConnectionConfigEntryLike, AdsOperator, AdsReader, VerifiedAdsAccount } from '../src/ads.js'

const NOW = '2026-06-10T00:00:00.000Z'

const VERIFIED: VerifiedAdsAccount = {
  id: 'adacct_aaa',
  name: 'Acme Exteriors, Inc',
  status: 'active',
  currencyCode: 'USD',
  timezone: 'America/Denver',
  reviewStatus: 'in_review',
  integrityReviewStatus: 'approved',
  integrityDecision: 'allowed',
}

function buildApp(overrides: {
  verifyShouldFail?: boolean
  operatorShouldFail?: boolean
  readerError?: unknown
  scopes?: string[]
  currentUpdatedAt?: number
  currentStatus?: string
  currentCampaignBiddingType?: 'impressions' | 'clicks' | null
  currentCampaignConversionEventSettingIds?: string[] | null
  currentAdGroupBillingEventType?: 'impression' | 'click' | null
  getCampaignFailures?: number
  mutationStatus?: string
  pauseStatus?: string
  pauseShouldFail?: boolean
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-routes-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const configConnections: AdsConnectionConfigEntryLike[] = []
  const syncRequests: Array<{ runId: string; projectId: string }> = []
  const operatorCalls: Array<{ method: string; input?: unknown }> = []
  const readerCalls: Array<{ method: string; apiKey: string; input?: unknown }> = []
  let remainingGetCampaignFailures = overrides.getCampaignFailures ?? 0

  const app = Fastify()
  app.decorate('db', db)
  if (overrides.scopes) {
    app.addHook('onRequest', async (request) => {
      request.apiKey = { id: 'key_test', name: 'test', scopes: overrides.scopes! }
    })
  }
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })

  const entity = (method: string, id: string, status: string) => ({
    id,
    status,
    updatedAt: overrides.currentUpdatedAt ?? 123,
    reviewStatus: id.startsWith('ad_') ? 'approved' : null,
    ...(method === 'getCampaign'
      ? {
          biddingType: overrides.currentCampaignBiddingType === undefined
            ? 'impressions' as const
            : overrides.currentCampaignBiddingType,
          conversionEventSettingIds: overrides.currentCampaignConversionEventSettingIds === undefined
            ? []
            : overrides.currentCampaignConversionEventSettingIds,
        }
      : {}),
    ...(method === 'getAdGroup'
      ? {
          billingEventType: overrides.currentAdGroupBillingEventType === undefined
            ? 'impression' as const
            : overrides.currentAdGroupBillingEventType,
        }
      : {}),
  })
  const call = async (method: string, id: string, input?: unknown) => {
    operatorCalls.push({ method, input })
    if (method === 'getCampaign' && remainingGetCampaignFailures > 0) {
      remainingGetCampaignFailures -= 1
      throw new Error('socket closed during campaign read with sk-test')
    }
    if (overrides.operatorShouldFail) {
      throw new Error('socket closed after request write with sk-test and https://secret.example/token')
    }
    if (overrides.pauseShouldFail && method.startsWith('pause')) {
      throw new Error('socket closed while confirming emergency pause')
    }
    const status = method.startsWith('get')
      ? overrides.currentStatus ?? 'paused'
      : method.startsWith('pause')
        ? overrides.pauseStatus ?? 'paused'
        : overrides.mutationStatus ?? 'paused'
    return entity(method, id, status)
  }
  const adsOperator: AdsOperator = {
    uploadImage: async (_apiKey, imageUrl) => {
      operatorCalls.push({ method: 'uploadImage', input: imageUrl })
      if (overrides.operatorShouldFail) {
        throw new Error('socket closed after request write with sk-test and https://secret.example/token')
      }
      return { fileId: 'file_new' }
    },
    getCampaign: async (_apiKey, id) => call('getCampaign', id),
    createCampaign: async (_apiKey, input) => call('createCampaign', 'cmpn_new', input),
    updateCampaign: async (_apiKey, id, input) => call('updateCampaign', id, input),
    pauseCampaign: async (_apiKey, id) => call('pauseCampaign', id),
    getAdGroup: async (_apiKey, id) => call('getAdGroup', id),
    createAdGroup: async (_apiKey, input) => call('createAdGroup', 'adgrp_new', input),
    updateAdGroup: async (_apiKey, id, input) => call('updateAdGroup', id, input),
    pauseAdGroup: async (_apiKey, id) => call('pauseAdGroup', id),
    getAd: async (_apiKey, id) => call('getAd', id),
    createAd: async (_apiKey, input) => call('createAd', 'ad_new', input),
    updateAd: async (_apiKey, id, input) => call('updateAd', id, input),
    pauseAd: async (_apiKey, id) => call('pauseAd', id),
  }
  const adsReader: AdsReader = {
    getAccount: async (apiKey) => {
      readerCalls.push({ method: 'getAccount', apiKey })
      if (overrides.readerError) throw overrides.readerError
      return {
        id: 'adacct_aaa',
        name: 'Acme Exteriors, Inc',
        status: 'active',
        currencyCode: 'USD',
        timezone: 'America/Denver',
        url: 'https://acme.example',
        reviewStatus: 'in_review',
        integrityReviewStatus: 'approved',
        integrityDecision: 'allowed',
      }
    },
    searchGeo: async (apiKey, input) => {
      readerCalls.push({ method: 'searchGeo', apiKey, input })
      if (overrides.readerError) throw overrides.readerError
      return {
        count: 1,
        query: input.q,
        results: [{
          id: '1014221',
          type: 'city',
          canonicalName: 'San Francisco, California, United States',
          countryCode: 'US',
          name: 'San Francisco',
          regionCode: 'CA',
        }],
      }
    },
    listConversionPixels: async (apiKey) => {
      readerCalls.push({ method: 'listConversionPixels', apiKey })
      if (overrides.readerError) throw overrides.readerError
      return {
        pixels: [{
          id: 'pixel_aaa',
          clientType: 'web',
          name: 'Canonry audit pixel',
          pixelId: 'px_aaa',
        }],
      }
    },
    listConversionEventSettings: async (apiKey) => {
      readerCalls.push({ method: 'listConversionEventSettings', apiKey })
      if (overrides.readerError) throw overrides.readerError
      return {
        eventSettings: [{
          id: 'cevent_1111',
          name: 'Audit booked',
          eventType: 'custom',
          customEventName: 'audit_booked',
          attributionWindowDays: 30,
          adAccountId: 'adacct_aaa',
          sourceIds: ['pixel_aaa'],
          sources: [{ id: 'pixel_aaa', name: 'Canonry audit pixel' }],
          archived: false,
          version: 1,
        }],
      }
    },
  }

  void app.register(adsRoutes, {
    adsCredentialStore: {
      getConnection: (projectName) => configConnections.find((c) => c.projectName === projectName),
      upsertConnection: (entry) => {
        const idx = configConnections.findIndex((c) => c.projectName === entry.projectName)
        if (idx === -1) configConnections.push(entry)
        else configConnections[idx] = entry
        return entry
      },
      removeConnection: (projectName) => {
        const idx = configConnections.findIndex((c) => c.projectName === projectName)
        if (idx === -1) return false
        configConnections.splice(idx, 1)
        return true
      },
    },
    verifyAdsAccount: async (apiKey) => {
      if (overrides.verifyShouldFail || apiKey === 'bad-key') {
        throw new Error('OpenAI Ads API key is invalid or unauthorized')
      }
      return VERIFIED
    },
    onAdsSyncRequested: (runId, projectId) => {
      syncRequests.push({ runId, projectId })
    },
    adsReader,
    adsOperator,
  })

  function seedProject(name = 'acme'): string {
    const id = crypto.randomUUID()
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
    }).run()
    return id
  }

  function seedConnection(projectId: string, projectName = 'acme', apiKey = 'sk-test') {
    const adAccountId = projectName === 'acme' ? 'adacct_aaa' : `adacct_${projectName}`
    db.insert(adsConnections).values({
      id: crypto.randomUUID(), projectId, adAccountId,
      displayName: 'Acme Exteriors, Inc', currencyCode: 'USD', timezone: 'America/Denver',
      status: 'active', reviewStatus: 'in_review', integrityReviewStatus: 'approved', integrityDecision: 'allowed',
      conversionTrackingConfigured: true, lastSyncedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }).run()
    if (!configConnections.some((entry) => entry.projectName === projectName)) {
      configConnections.push({
        projectName, apiKey, adAccountId, createdAt: NOW, updatedAt: NOW,
      })
    }
  }

  function seedSnapshots(projectId: string) {
    db.insert(adsCampaigns).values({
      id: 'cmpn_bbb', projectId, name: 'Homeowners Free Estimate', status: 'active',
      biddingType: 'clicks', dailySpendLimitMicros: 150_000_000, syncedAt: NOW,
      conversionEventSettingIds: ['cevent_1111'],
      description: 'Homeowner lead generation', startTime: 1_765_843_200, endTime: 1_768_521_600,
      targeting: { locations: { include: [{ id: '3000001' }] } }, upstreamUpdatedAt: 123,
    }).run()
    db.insert(adsAdGroups).values({
      id: 'adgrp_ddd', projectId, campaignId: 'cmpn_bbb', name: 'Deck Project Planning',
      status: 'active', billingEventType: 'click', maxBidMicros: 2_000_000,
      description: 'Deck demand', contextHints: ['how much does a new deck cost', 'measure my yard'],
      upstreamUpdatedAt: 124, syncedAt: NOW,
    }).run()
    db.insert(adsAds).values({
      id: 'ad_eee', projectId, adGroupId: 'adgrp_ddd', name: 'HO Deck - Materials',
      status: 'active', reviewStatus: 'approved',
      creative: {
        type: 'chat_card', title: 'Free Estimate', body: 'b',
        target_url: 'https://lp.example/x', file_id: 'file_eee',
      },
      upstreamUpdatedAt: 125, syncedAt: NOW,
    }).run()
  }

  function seedInsights(projectId: string) {
    const rows = [
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-09', impressions: 3326, clicks: 40, spendMicros: 90_450_000, conversions: 4 },
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-10', impressions: 1736, clicks: 23, spendMicros: 39_280_000, conversions: 2 },
      // subdivision of the campaign rows — must NOT be double-counted in summary totals
      { level: 'ad_group', entityId: 'adgrp_ddd', date: '2026-06-10', impressions: 64, clicks: 1, spendMicros: 570_000, conversions: 1 },
      // zero-denominator edge: no clicks
      { level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-08', impressions: 100, clicks: 0, spendMicros: 0, conversions: 0 },
    ]
    for (const row of rows) {
      db.insert(adsInsightsDaily).values({ id: crypto.randomUUID(), projectId, syncRunId: null, ...row }).run()
    }
  }

  return {
    app, db, tmpDir, configConnections, syncRequests, operatorCalls, readerCalls,
    seedProject, seedConnection, seedSnapshots, seedInsights,
  }
}

describe('ads routes', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(async () => {
    ctx = buildApp()
    await ctx.app.ready()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('POST /ads/connect verifies the key, stores the credential in config, and writes the row + audit', async () => {
    const projectId = ctx.seedProject()
    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-good' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.connected).toBe(true)
    expect(body.adAccountId).toBe('adacct_aaa')
    expect(body.currencyCode).toBe('USD')
    expect(body.reviewStatus).toBe('in_review')
    expect(body.integrityReviewStatus).toBe('approved')
    expect(body.integrityDecision).toBe('allowed')

    // credential landed in the config store, NOT the DB
    expect(ctx.configConnections.length).toBe(1)
    expect(ctx.configConnections[0]!.apiKey).toBe('sk-good')
    const row = ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).get()
    expect(row?.displayName).toBe('Acme Exteriors, Inc')
    expect(row?.reviewStatus).toBe('in_review')
    expect(row?.integrityReviewStatus).toBe('approved')
    expect(row?.integrityDecision).toBe('allowed')

    const audit = ctx.db.select().from(auditLog).all()
    expect(audit.some((entry) => entry.action === 'ads.connected')).toBe(true)
  })

  it('POST /ads/connect rejects an upstream-invalid key with a 400', async () => {
    ctx.seedProject()
    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'bad-key' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('rejected the key')
    expect(ctx.configConnections.length).toBe(0)
  })

  it('POST /ads/connect is idempotent: reconnecting updates instead of duplicating', async () => {
    const projectId = ctx.seedProject()
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-1' } })
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-2' } })

    expect(ctx.configConnections.length).toBe(1)
    expect(ctx.configConnections[0]!.apiKey).toBe('sk-2')
    const rows = ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).all()
    expect(rows.length).toBe(1)
  })

  it('GET /ads/status reports not-connected and connected states', async () => {
    const projectId = ctx.seedProject()
    let res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/status' })
    expect(JSON.parse(res.body).connected).toBe(false)

    ctx.seedConnection(projectId)
    res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/status' })
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.connected).toBe(true)
    expect(body.lastSyncedAt).toBe(NOW)
    expect(body.reviewStatus).toBe('in_review')
    expect(body.integrityReviewStatus).toBe('approved')
    expect(body.integrityDecision).toBe('allowed')
    // the seeded connection has conversion tracking configured
    expect(body.conversionTrackingConfigured).toBe(true)
  })

  it('serves the live account, geo, pixel, and conversion-event planning reads', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const account = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/account' })
    expect(account.statusCode).toBe(200)
    expect(JSON.parse(account.body)).toMatchObject({
      id: 'adacct_aaa',
      reviewStatus: 'in_review',
      integrityReviewStatus: 'approved',
      integrityDecision: 'allowed',
    })

    const geo = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/geo/search?q=San%20Francisco&limit=7',
    })
    expect(geo.statusCode).toBe(200)
    expect(JSON.parse(geo.body)).toMatchObject({
      count: 1,
      query: 'San Francisco',
      results: [{ id: '1014221', canonicalName: 'San Francisco, California, United States' }],
    })

    const pixels = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/conversions/pixels' })
    expect(pixels.statusCode).toBe(200)
    expect(JSON.parse(pixels.body)).toEqual({
      pixels: [{ id: 'pixel_aaa', clientType: 'web', name: 'Canonry audit pixel', pixelId: 'px_aaa' }],
    })

    const eventSettings = await ctx.app.inject({
      method: 'GET',
      url: '/projects/acme/ads/conversions/event-settings',
    })
    expect(eventSettings.statusCode).toBe(200)
    expect(JSON.parse(eventSettings.body)).toEqual({
      eventSettings: [{
        id: 'cevent_1111',
        name: 'Audit booked',
        eventType: 'custom',
        customEventName: 'audit_booked',
        attributionWindowDays: 30,
        adAccountId: 'adacct_aaa',
        sourceIds: ['pixel_aaa'],
        sources: [{ id: 'pixel_aaa', name: 'Canonry audit pixel' }],
        archived: false,
        version: 1,
      }],
    })

    expect(ctx.readerCalls).toEqual([
      { method: 'getAccount', apiKey: 'sk-test' },
      { method: 'searchGeo', apiKey: 'sk-test', input: { q: 'San Francisco', limit: 7 } },
      { method: 'listConversionPixels', apiKey: 'sk-test' },
      { method: 'listConversionEventSettings', apiKey: 'sk-test' },
    ])
  })

  it('fails planning reads closed when the project has no ads credential', async () => {
    ctx.seedProject()

    for (const url of [
      '/projects/acme/ads/account',
      '/projects/acme/ads/geo/search?q=San%20Francisco',
      '/projects/acme/ads/conversions/pixels',
      '/projects/acme/ads/conversions/event-settings',
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('No OpenAI Ads API key configured for this project')
    }
    expect(ctx.readerCalls).toEqual([])
  })

  it.each([
    { status: 401, code: 'invalid_api_key' },
    { status: 404, code: 'not_found' },
    { status: 429, code: 'rate_limit_exceeded' },
    { status: 503, code: 'provider_unavailable' },
  ])('maps an upstream $status planning-read failure to a sanitized provider error', async ({ status, code }) => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ readerError: Object.assign(new Error('secret-bearing provider failure'), { status, code }) })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const response = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/account' })

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'PROVIDER_ERROR',
        message: 'OpenAI Ads API account read failed',
        details: { upstreamStatus: status, upstreamCode: code },
      },
    })
    expect(response.body).not.toContain('secret-bearing')
  })

  it('maps malformed or otherwise unclassified planning-read failures to a provider error', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ readerError: new Error('invalid JSON containing sk-secret') })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const response = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/conversions/pixels' })

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'PROVIDER_ERROR',
        message: 'OpenAI Ads API conversion pixel list read failed',
        details: {},
      },
    })
    expect(response.body).not.toContain('sk-secret')
  })

  it('resolves every planning read credential from the requested project', async () => {
    const acmeId = ctx.seedProject('acme')
    const betaId = ctx.seedProject('beta')
    ctx.seedConnection(acmeId, 'acme', 'sk-acme')
    ctx.seedConnection(betaId, 'beta', 'sk-beta')

    const acme = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/account' })
    const beta = await ctx.app.inject({ method: 'GET', url: '/projects/beta/ads/account' })

    expect(acme.statusCode).toBe(200)
    expect(beta.statusCode).toBe(200)
    expect(ctx.readerCalls).toEqual([
      { method: 'getAccount', apiKey: 'sk-acme' },
      { method: 'getAccount', apiKey: 'sk-beta' },
    ])
  })

  it('strips caller status, creates campaigns paused, and replays without a second upstream call', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    const payload = {
      operationKey: 'weekend:campaign:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
      status: 'active',
    }

    const first = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload,
    })
    expect(first.statusCode).toBe(200)
    const firstBody = JSON.parse(first.body) as { operation: Record<string, unknown>; replayed: boolean }
    expect(firstBody.replayed).toBe(false)
    expect(firstBody.operation.state).toBe('succeeded')
    expect(firstBody.operation.entityId).toBe('cmpn_new')
    expect(ctx.operatorCalls).toEqual([
      {
        method: 'createCampaign',
        input: {
          name: 'AEO Audit Lead Generation',
          lifetimeSpendLimitMicros: 25_000_000,
          locationIds: ['1000232'],
          biddingType: 'impressions',
        },
      },
    ])

    const replay = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body).replayed).toBe(true)
    expect(ctx.operatorCalls).toHaveLength(1)

    const conflict = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload: { ...payload, name: 'Different campaign' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(ctx.operatorCalls).toHaveLength(1)

    const rows = ctx.db.select().from(adsOperations).where(eq(adsOperations.projectId, projectId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'succeeded', entityId: 'cmpn_new' })
  })

  it('forwards click bidding and conversion settings when creating a paused campaign', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns',
      payload: {
        operationKey: 'weekend:campaign:clicks',
        name: 'AEO Audit Click Leads',
        lifetimeSpendLimitMicros: 25_000_000,
        locationIds: ['1000232'],
        biddingType: 'clicks',
        conversionEventSettingIds: ['cevent_audit_booked'],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(ctx.operatorCalls).toEqual([
      {
        method: 'createCampaign',
        input: {
          name: 'AEO Audit Click Leads',
          lifetimeSpendLimitMicros: 25_000_000,
          locationIds: ['1000232'],
          biddingType: 'clicks',
          conversionEventSettingIds: ['cevent_audit_booked'],
        },
      },
    ])
  })

  it('emergency-pauses a create when the provider does not return the required paused state', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ mutationStatus: 'active' })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload: {
        operationKey: 'weekend:campaign:emergency-pause',
        name: 'AEO Audit Lead Generation',
        lifetimeSpendLimitMicros: 25_000_000,
        locationIds: ['3000001'],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(ctx.operatorCalls.map((entry) => entry.method)).toEqual([
      'createCampaign',
      'pauseCampaign',
    ])
    expect(JSON.parse(res.body)).toMatchObject({
      operation: { state: 'succeeded', entityId: 'cmpn_new' },
    })
  })

  it('records an unknown receipt with the entity id when emergency pause is not confirmed', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ mutationStatus: 'active', pauseStatus: 'active' })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload: {
        operationKey: 'weekend:campaign:pause-unconfirmed',
        name: 'AEO Audit Lead Generation',
        lifetimeSpendLimitMicros: 25_000_000,
        locationIds: ['3000001'],
      },
    })
    expect(res.statusCode).toBe(502)
    const receipt = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'weekend:campaign:pause-unconfirmed')).get()
    expect(receipt).toMatchObject({
      state: 'unknown',
      entityId: 'cmpn_new',
      errorCode: 'ADS_PAUSED_POSTCONDITION_FAILED',
    })
  })

  it('preserves the created entity id when emergency pause throws', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ mutationStatus: 'active', pauseShouldFail: true })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns', payload: {
        operationKey: 'weekend:campaign:pause-threw',
        name: 'AEO Audit Lead Generation',
        lifetimeSpendLimitMicros: 25_000_000,
        locationIds: ['3000001'],
      },
    })
    expect(res.statusCode).toBe(502)
    expect(ctx.operatorCalls.map((entry) => entry.method)).toEqual([
      'createCampaign',
      'pauseCampaign',
    ])
    const receipt = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'weekend:campaign:pause-threw')).get()
    expect(receipt).toMatchObject({
      state: 'unknown',
      entityId: 'cmpn_new',
      errorCode: 'upstream_error',
    })
  })

  it('strips caller status, creates paused ad groups and ads, then can pause each entity', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const group = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/ad-groups', payload: {
        operationKey: 'weekend:group:1',
        campaignId: 'cmpn_new',
        name: 'AEO audit discovery',
        contextHints: ['how do I improve visibility in ChatGPT'],
        maxBidMicros: 60_000,
        status: 'active',
      },
    })
    expect(group.statusCode).toBe(200)
    expect(ctx.operatorCalls.slice(0, 2)).toEqual([
      { method: 'getCampaign', input: undefined },
      {
        method: 'createAdGroup',
        input: {
          campaignId: 'cmpn_new',
          name: 'AEO audit discovery',
          contextHints: ['how do I improve visibility in ChatGPT'],
          maxBidMicros: 60_000,
          billingEventType: 'impression',
        },
      },
    ])

    const ad = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/ads', payload: {
        operationKey: 'weekend:ad:1',
        adGroupId: 'adgrp_new',
        name: 'Free AEO audit card',
        creative: {
          title: 'See How AI Reads Your Site',
          body: 'Run a free AEO audit and get your top fixes.',
          targetUrl: 'https://canonry.ai/audit?utm_source=chatgpt&utm_medium=paid',
          fileId: 'file_new',
        },
        status: 'active',
      },
    })
    expect(ad.statusCode).toBe(200)
    expect(ctx.operatorCalls[2]).toEqual({
      method: 'createAd',
      input: {
        adGroupId: 'adgrp_new',
        name: 'Free AEO audit card',
        creative: {
          title: 'See How AI Reads Your Site',
          body: 'Run a free AEO audit and get your top fixes.',
          targetUrl: 'https://canonry.ai/audit?utm_source=chatgpt&utm_medium=paid',
          fileId: 'file_new',
        },
      },
    })

    for (const [url, method, key] of [
      ['/projects/acme/ads/campaigns/cmpn_new/pause', 'pauseCampaign', 'pause:campaign:1'],
      ['/projects/acme/ads/ad-groups/adgrp_new/pause', 'pauseAdGroup', 'pause:group:1'],
      ['/projects/acme/ads/ads/ad_new/pause', 'pauseAd', 'pause:ad:1'],
    ] as const) {
      const res = await ctx.app.inject({ method: 'POST', url, payload: { operationKey: key } })
      expect(res.statusCode).toBe(200)
      expect(ctx.operatorCalls.some((entry) => entry.method === method)).toBe(true)
    }
  })

  it('rejects an ad-group billing event that does not match the live parent campaign before create', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({
      currentCampaignBiddingType: 'clicks',
      currentCampaignConversionEventSettingIds: ['cevent_audit_booked'],
    })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload: {
        operationKey: 'weekend:group:billing-mismatch',
        campaignId: 'cmpn_clicks',
        name: 'AEO audit click demand',
        contextHints: ['book an AEO audit'],
        maxBidMicros: 60_000,
      },
    })

    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.body).toContain('must match the parent campaign bidding type')
    expect(ctx.operatorCalls).toEqual([{ method: 'getCampaign', input: undefined }])
    const receipt = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'weekend:group:billing-mismatch')).get()
    expect(receipt).toBeUndefined()

    const matching = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload: {
        operationKey: 'weekend:group:billing-click',
        campaignId: 'cmpn_clicks',
        name: 'AEO audit click demand',
        contextHints: ['book an AEO audit'],
        maxBidMicros: 60_000,
        billingEventType: 'click',
      },
    })

    expect(matching.statusCode).toBe(200)
    expect(ctx.operatorCalls.slice(-2)).toEqual([
      { method: 'getCampaign', input: undefined },
      {
        method: 'createAdGroup',
        input: {
          campaignId: 'cmpn_clicks',
          name: 'AEO audit click demand',
          contextHints: ['book an AEO audit'],
          maxBidMicros: 60_000,
          billingEventType: 'click',
        },
      },
    ])
  })

  it('keeps an ad-group operation key retryable when the campaign preflight read fails', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ getCampaignFailures: 1 })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    const payload = {
      operationKey: 'weekend:group:preflight-retry',
      campaignId: 'cmpn_new',
      name: 'AEO audit discovery',
      contextHints: ['book an AEO audit'],
      maxBidMicros: 60_000,
    }

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload,
    })

    expect(first.statusCode).toBe(502)
    expect(first.body).not.toContain('sk-test')
    expect(ctx.operatorCalls).toEqual([{ method: 'getCampaign', input: undefined }])
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, payload.operationKey)).get()).toBeUndefined()

    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload,
    })

    expect(retry.statusCode).toBe(200)
    expect(ctx.operatorCalls.slice(1)).toEqual([
      { method: 'getCampaign', input: undefined },
      {
        method: 'createAdGroup',
        input: {
          campaignId: 'cmpn_new',
          name: 'AEO audit discovery',
          contextHints: ['book an AEO audit'],
          maxBidMicros: 60_000,
          billingEventType: 'impression',
        },
      },
    ])
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, payload.operationKey)).get()).toMatchObject({
      state: 'succeeded',
      entityId: 'adgrp_new',
    })

    const callsAfterSuccess = ctx.operatorCalls.length
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true })
    expect(ctx.operatorCalls).toHaveLength(callsAfterSuccess)
  })

  it('treats a null campaign bidding type as impressions and still rejects click billing', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ currentCampaignBiddingType: null })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    const base = {
      campaignId: 'cmpn_legacy',
      name: 'Legacy impressions campaign',
      contextHints: ['learn about AEO audits'],
      maxBidMicros: 60_000,
    }

    const impressions = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload: { ...base, operationKey: 'weekend:group:null-impressions' },
    })
    expect(impressions.statusCode).toBe(200)
    expect(ctx.operatorCalls.slice(-1)).toEqual([{
      method: 'createAdGroup',
      input: { ...base, billingEventType: 'impression' },
    }])

    const clicks = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups',
      payload: {
        ...base,
        operationKey: 'weekend:group:null-clicks',
        billingEventType: 'click',
      },
    })
    expect(clicks.statusCode).toBe(400)
    expect(clicks.body).toContain('must match the parent campaign bidding type')
    expect(ctx.operatorCalls.slice(-1)).toEqual([{ method: 'getCampaign', input: undefined }])
  })

  it('fails a stale update closed before calling the upstream update', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ currentUpdatedAt: 456 })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns/cmpn_new', payload: {
        operationKey: 'weekend:update:1',
        expectedUpdatedAt: 123,
        lifetimeSpendLimitMicros: 30_000_000,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('changed since it was reviewed')
    expect(ctx.operatorCalls.map((entry) => entry.method)).toEqual(['getCampaign'])
    const receipt = ctx.db.select().from(adsOperations).where(eq(adsOperations.operationKey, 'weekend:update:1')).get()
    expect(receipt?.state).toBe('failed')
  })

  it('requires an upstream entity to be paused before updating it', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ currentStatus: 'active' })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/ad-groups/adgrp_live', payload: {
        operationKey: 'weekend:update:active',
        expectedUpdatedAt: 123,
        maxBidMicros: 50_000,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Pause the upstream ad entity before updating it')
    expect(ctx.operatorCalls.map((entry) => entry.method)).toEqual(['getAdGroup'])
    const receipt = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'weekend:update:active')).get()
    expect(receipt).toMatchObject({ state: 'failed', errorCode: 'VALIDATION_ERROR' })
  })

  it('updates a paused entity only after the optimistic concurrency check passes', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const res = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/ads/ad_paused', payload: {
        operationKey: 'weekend:update:paused',
        expectedUpdatedAt: 123,
        name: 'AEO audit card v2',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(ctx.operatorCalls).toEqual([
      { method: 'getAd', input: undefined },
      { method: 'updateAd', input: { name: 'AEO audit card v2' } },
    ])
  })

  it('preserves the live ad-group billing event when updating its max bid', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ currentAdGroupBillingEventType: 'click' })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/ad-groups/adgrp_clicks',
      payload: {
        operationKey: 'weekend:update:click-bid',
        expectedUpdatedAt: 123,
        maxBidMicros: 75_000,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(ctx.operatorCalls).toEqual([
      { method: 'getAdGroup', input: undefined },
      {
        method: 'updateAdGroup',
        input: { maxBidMicros: 75_000, billingEventType: 'click' },
      },
    ])
  })

  it('rejects clearing campaign geo targeting and forwards a valid non-empty update', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    for (const [operationKey, locationIds] of [
      ['weekend:update:geo:null', null],
      ['weekend:update:geo:empty', []],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'POST', url: '/projects/acme/ads/campaigns/cmpn_new', payload: {
          operationKey,
          expectedUpdatedAt: 123,
          locationIds,
        },
      })
      expect(res.statusCode).toBe(400)
    }
    expect(ctx.operatorCalls).toEqual([])

    const valid = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/campaigns/cmpn_new', payload: {
        operationKey: 'weekend:update:geo:valid',
        expectedUpdatedAt: 123,
        locationIds: ['3000001'],
      },
    })
    expect(valid.statusCode).toBe(200)
    expect(ctx.operatorCalls).toEqual([
      { method: 'getCampaign', input: undefined },
      { method: 'updateCampaign', input: { locationIds: ['3000001'] } },
    ])
  })

  it('marks an ambiguous upstream outcome unknown and never retries it blindly', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ operatorShouldFail: true })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    const payload = {
      operationKey: 'weekend:unknown:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
    }

    const first = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/campaigns', payload })
    expect(first.statusCode).toBe(502)
    expect(first.body).toContain('unknown')
    expect(ctx.operatorCalls).toHaveLength(1)

    const replay = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/campaigns', payload })
    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true, operation: { state: 'unknown' } })
    expect(ctx.operatorCalls).toHaveLength(1)

    const read = await ctx.app.inject({
      method: 'GET', url: '/projects/acme/ads/operations/weekend%3Aunknown%3A1',
    })
    expect(read.statusCode).toBe(200)
    expect(JSON.parse(read.body).operation.errorMessage).toBe('OpenAI Ads API outcome could not be confirmed')
    expect(read.body).not.toContain('sk-test')
    expect(read.body).not.toContain('secret.example')
  })

  it('requires the ads.write scope for every lifecycle mutation', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ scopes: ['read'] })
    await ctx.app.ready()
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    const payload = {
      operationKey: 'weekend:scope:1',
      name: 'AEO Audit Lead Generation',
      lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
    }
    const denied = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/campaigns', payload })
    expect(denied.statusCode).toBe(403)
    expect(ctx.operatorCalls).toHaveLength(0)
    const deniedSync = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(deniedSync.statusCode).toBe(403)
    const deniedConnect = await ctx.app.inject({
      method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-good' },
    })
    expect(deniedConnect.statusCode).toBe(403)

    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildApp({ scopes: ['ads.write'] })
    await ctx.app.ready()
    const allowedProjectId = ctx.seedProject()
    ctx.seedConnection(allowedProjectId)
    const allowed = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/campaigns', payload })
    expect(allowed.statusCode).toBe(200)
  })

  it('POST /ads/sync requires a connection, creates the run row, and fires the host callback', async () => {
    const projectId = ctx.seedProject()
    let res = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(res.statusCode).toBe(400)

    ctx.seedConnection(projectId)
    res = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { runId: string; status: string }
    expect(body.status).toBe('queued')

    const run = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
    expect(run?.kind).toBe('ads-sync')
    expect(run?.trigger).toBe('manual')
    expect(ctx.syncRequests).toEqual([{ runId: body.runId, projectId }])
  })

  it('POST /ads/sync is idempotent: a second call while one is in flight returns the existing run', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)

    const first = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    const firstBody = JSON.parse(first.body) as { runId: string; status: string }

    // The first run is still queued/running; a second trigger must not stack.
    const second = await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/sync' })
    expect(second.statusCode).toBe(200)
    const secondBody = JSON.parse(second.body) as { runId: string; status: string }
    expect(secondBody.runId).toBe(firstBody.runId)

    const adsRuns = ctx.db.select().from(runs).where(eq(runs.projectId, projectId)).all()
      .filter((r) => r.kind === 'ads-sync')
    expect(adsRuns.length).toBe(1)
    // the host callback fired only for the first trigger
    expect(ctx.syncRequests).toEqual([{ runId: firstBody.runId, projectId }])
  })

  it('GET /ads/campaigns nests ad groups and ads, mapping creative target_url → targetUrl', async () => {
    const projectId = ctx.seedProject()
    ctx.seedSnapshots(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/campaigns' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { campaigns: Array<Record<string, unknown>> }
    expect(body.campaigns.length).toBe(1)
    const campaign = body.campaigns[0]!
    expect(campaign.biddingType).toBe('clicks')
    expect(campaign.dailySpendLimitMicros).toBe(150_000_000)
    expect(campaign.conversionEventSettingIds).toEqual(['cevent_1111'])
    expect(campaign.upstreamUpdatedAt).toBe(123)
    expect(campaign.locationIds).toEqual(['3000001'])
    expect(campaign.adGroups.length).toBe(1)
    expect(campaign.adGroups[0].billingEventType).toBe('click')
    expect(campaign.adGroups[0].upstreamUpdatedAt).toBe(124)
    expect(campaign.adGroups[0].contextHints).toEqual(['how much does a new deck cost', 'measure my yard'])
    expect(campaign.adGroups[0].ads[0].creative.targetUrl).toBe('https://lp.example/x')
    expect(campaign.adGroups[0].ads[0].creative.fileId).toBe('file_eee')
    expect(campaign.adGroups[0].ads[0].upstreamUpdatedAt).toBe(125)

    ctx.db.update(adsCampaigns).set({ biddingType: 'future_provider_value' })
      .where(eq(adsCampaigns.id, 'cmpn_bbb')).run()
    ctx.db.update(adsAdGroups).set({ billingEventType: 'future_provider_value' })
      .where(eq(adsAdGroups.id, 'adgrp_ddd')).run()
    const drifted = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/campaigns' })
    const driftedCampaign = (JSON.parse(drifted.body) as {
      campaigns: Array<{ biddingType: string | null; adGroups: Array<{ billingEventType: string | null }> }>
    }).campaigns[0]!
    expect(driftedCampaign.biddingType).toBeNull()
    expect(driftedCampaign.adGroups[0]?.billingEventType).toBeNull()
  })

  it('GET /ads/insights derives ctr and cpcMicros exactly, with nulls for zero denominators', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedInsights(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/insights?level=campaign' })
    const body = JSON.parse(res.body) as { rows: Array<Record<string, unknown>> }
    expect(body.rows.length).toBe(3)
    // ordered by date ascending
    expect(body.rows.map((r) => r.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10'])

    const june10 = body.rows.find((r) => r.date === '2026-06-10')!
    // $39.28 / 23 clicks = 1_707_826 micros; 23/1736 ctr
    expect(june10.cpcMicros).toBe(1_707_826)
    expect(june10.ctr).toBeCloseTo(23 / 1736, 8)
    expect(june10.conversions).toBe(2)

    const june08 = body.rows.find((r) => r.date === '2026-06-08')!
    expect(june08.ctr).toBe(0)
    expect(june08.cpcMicros).toBeNull()

    // currency travels with the rollup so the CLI can render the right symbol
    expect((JSON.parse(res.body) as { currencyCode?: string }).currencyCode).toBe('USD')
  })

  it('GET /ads/insights rejects invalid and unsupported levels and filters by entity', async () => {
    const projectId = ctx.seedProject()
    ctx.seedInsights(projectId)

    const bad = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/insights?level=nonsense' })
    expect(bad.statusCode).toBe(400)

    // account/ad levels are not produced by the sync — rejected, not silently empty
    for (const level of ['account', 'ad']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/projects/acme/ads/insights?level=${level}` })
      expect(res.statusCode).toBe(400)
    }

    const filtered = await ctx.app.inject({
      method: 'GET', url: '/projects/acme/ads/insights?level=ad_group&entityId=adgrp_ddd',
    })
    const body = JSON.parse(filtered.body) as { rows: Array<Record<string, unknown>> }
    expect(body.rows.length).toBe(1)
    expect(body.rows[0]!.spendMicros).toBe(570_000)
  })

  it('GET /ads/summary sums CAMPAIGN-level rollups only (no double counting) with window bounds', async () => {
    const projectId = ctx.seedProject()
    ctx.seedConnection(projectId)
    ctx.seedSnapshots(projectId)
    ctx.seedInsights(projectId)

    const res = await ctx.app.inject({ method: 'GET', url: '/projects/acme/ads/summary' })
    const body = JSON.parse(res.body) as {
      connected: boolean
      campaignCount: number
      adGroupCount: number
      adCount: number
      totals: { impressions: number; clicks: number; spendMicros: number; conversions: number; ctr: number | null; cpcMicros: number | null }
      window: { from: string | null; to: string | null }
    }
    expect(body.connected).toBe(true)
    expect(body.campaignCount).toBe(1)
    expect(body.adGroupCount).toBe(1)
    expect(body.adCount).toBe(1)
    // campaign rows only: 3326+1736+100 impressions, 40+23+0 clicks — the
    // ad_group row (64 impressions) is a subdivision and must be excluded
    expect(body.totals.impressions).toBe(5162)
    expect(body.totals.clicks).toBe(63)
    expect(body.totals.spendMicros).toBe(129_730_000)
    // conversions sum campaign rows only: 4+2+0 — the ad_group row's 1 is excluded
    expect(body.totals.conversions).toBe(6)
    expect(body.totals.ctr).toBeCloseTo(63 / 5162, 8)
    expect(body.totals.cpcMicros).toBe(Math.round(129_730_000 / 63))
    expect(body.window).toEqual({ from: '2026-06-08', to: '2026-06-10' })
  })

  it('DELETE /ads/connection removes the row + credential and is idempotent', async () => {
    const projectId = ctx.seedProject()
    await ctx.app.inject({ method: 'POST', url: '/projects/acme/ads/connect', payload: { apiKey: 'sk-good' } })

    let res = await ctx.app.inject({ method: 'DELETE', url: '/projects/acme/ads/connection' })
    expect(JSON.parse(res.body).disconnected).toBe(true)
    expect(ctx.configConnections.length).toBe(0)
    expect(ctx.db.select().from(adsConnections).where(eq(adsConnections.projectId, projectId)).all().length).toBe(0)

    res = await ctx.app.inject({ method: 'DELETE', url: '/projects/acme/ads/connection' })
    expect(JSON.parse(res.body).disconnected).toBe(false)
  })

  it('404s for an unknown project', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/projects/nope/ads/status' })
    expect(res.statusCode).toBe(404)
  })
})
