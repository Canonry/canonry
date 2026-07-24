import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient,
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gscDailyTotals,
  gscQueryDailyTotals,
  gscSearchData,
  migrate,
  runs,
} from '@ainyc/canonry-db'
import { gaMeasurementAnalysisDtoSchema, RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'

const GA_ANCHOR = '2026-07-22'
const GSC_ANCHOR = '2026-07-20'
const NOW = '2026-07-23T12:00:00.000Z'

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-measurement-analysis-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const credentials = new Map<string, Ga4CredentialRecord>()
  const ga4CredentialStore: Ga4CredentialStore = {
    getConnection: projectName => credentials.get(projectName),
    upsertConnection: connection => {
      credentials.set(connection.projectName, connection)
      return connection
    },
    deleteConnection: projectName => credentials.delete(projectName),
  }
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ga4CredentialStore })
  return { app, db, credentials, tmpDir }
}

type Context = ReturnType<typeof buildApp> & {
  projectId: string
  runId: string
}

async function seedProject(ctx: ReturnType<typeof buildApp>): Promise<Pick<Context, 'projectId' | 'runId'>> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/projects/demand-iq',
    payload: {
      displayName: 'DemandIQ',
      canonicalDomain: 'demand-iq.com',
      ownedDomains: ['demandiq.com'],
      aliases: ['Demand IQ'],
      country: 'US',
      language: 'en',
      measurement: {
        marketingHosts: ['offers.example.net'],
        brandTerms: ['Demand Intelligence'],
        leadEventNames: ['generate_lead', 'book_demo'],
      },
    },
  })
  expect(response.statusCode).toBe(201)
  const projectId = (JSON.parse(response.body) as { id: string }).id
  const runId = crypto.randomUUID()
  ctx.db.insert(runs).values({
    id: runId,
    projectId,
    kind: RunKinds.gscSync,
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    createdAt: NOW,
  }).run()
  ctx.credentials.set('demand-iq', {
    projectName: 'demand-iq',
    propertyId: '123456',
    clientEmail: 'measurement@test.iam.gserviceaccount.com',
    privateKey: 'fake-key',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return { projectId, runId }
}

function insertAcquisition(
  ctx: Context,
  input: {
    daysAgo: number
    channelGroup: string
    hostName: string
    landingPage: string
    sessions: number
  },
) {
  ctx.db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GA_ANCHOR, input.daysAgo),
    channelGroup: input.channelGroup,
    source: input.channelGroup === 'Direct' ? '(direct)' : 'google',
    medium: input.channelGroup === 'Paid Search' ? 'cpc' : 'organic',
    hostName: input.hostName,
    landingPage: input.landingPage,
    landingPageNormalized: input.landingPage.split('?')[0]!,
    sessions: input.sessions,
    syncedAt: NOW,
    createdAt: NOW,
  }).run()
}

function insertLead(
  ctx: Context,
  input: {
    daysAgo: number
    channelGroup: string
    hostName: string
    landingPage: string
    eventCount: number
    attributionScope?: 'landing-page' | 'channel'
  },
) {
  const attributionScope = input.attributionScope ?? 'landing-page'
  ctx.db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GA_ANCHOR, input.daysAgo),
    eventName: 'generate_lead',
    channelGroup: input.channelGroup,
    source: 'google',
    medium: input.channelGroup === 'Paid Search' ? 'cpc' : 'organic',
    hostName: input.hostName,
    landingPage: input.landingPage,
    landingPageNormalized: attributionScope === 'landing-page'
      ? input.landingPage.split('?')[0]!
      : null,
    attributionScope,
    eventCount: input.eventCount,
    syncedAt: NOW,
    createdAt: NOW,
  }).run()
}

function insertGscQuery(
  ctx: Context,
  input: { daysAgo: number; query: string; clicks: number; impressions: number },
) {
  ctx.db.insert(gscQueryDailyTotals).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GSC_ANCHOR, input.daysAgo),
    query: input.query,
    clicks: input.clicks,
    impressions: input.impressions,
    position: '4',
    syncedAt: NOW,
    syncRunId: ctx.runId,
    createdAt: NOW,
  }).run()
}

function insertGscPropertyTotal(
  ctx: Context,
  input: { daysAgo: number; clicks: number; impressions: number },
) {
  ctx.db.insert(gscDailyTotals).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GSC_ANCHOR, input.daysAgo),
    clicks: input.clicks,
    impressions: input.impressions,
    position: '5',
    createdAt: NOW,
  }).run()
}

function insertGscPage(
  ctx: Context,
  input: {
    daysAgo: number
    query: string
    page: string
    clicks: number
    impressions: number
  },
) {
  ctx.db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    syncRunId: ctx.runId,
    date: daysBefore(GSC_ANCHOR, input.daysAgo),
    query: input.query,
    page: input.page,
    clicks: input.clicks,
    impressions: input.impressions,
    ctr: String(input.impressions > 0 ? input.clicks / input.impressions : 0),
    position: '4',
    createdAt: NOW,
  }).run()
}

describe('GET /projects/:name/ga/measurement-analysis', () => {
  let ctx: Context

  beforeEach(async () => {
    const base = buildApp()
    await base.app.ready()
    const seeded = await seedProject(base)
    ctx = { ...base, ...seeded }
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('returns three complete 30-day cohorts over 90d, preserves native channels, and defaults to marketing hosts', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: 'www.demand-iq.com',
      landingPage: '/quote?utm_campaign=summer',
      sessions: 40,
    })
    insertAcquisition(ctx, {
      daysAgo: 1,
      channelGroup: 'Organic Search',
      hostName: 'offers.example.net',
      landingPage: '/blog/guide',
      sessions: 5,
    })
    insertAcquisition(ctx, {
      daysAgo: 2,
      channelGroup: 'Display',
      hostName: 'demand-iq.vercel.app',
      landingPage: '/preview',
      sessions: 100,
    })
    insertAcquisition(ctx, {
      daysAgo: 35,
      channelGroup: 'Organic Search',
      hostName: 'demandiq.com',
      landingPage: '/blog/guide',
      sessions: 30,
    })
    insertAcquisition(ctx, {
      daysAgo: 65,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/blog/guide',
      sessions: 10,
    })
    insertAcquisition(ctx, {
      daysAgo: 95,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/outside-window',
      sessions: 999,
    })
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: NOW,
      leadStatus: 'never-synced',
      updatedAt: NOW,
    }).run()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=90d',
    })

    expect(response.statusCode).toBe(200)
    const body = gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
    expect(body).toMatchObject({
      window: '90d',
      bucketDays: 30,
      filters: {
        hostScope: 'marketing',
        marketingHosts: ['demand-iq.com', 'demandiq.com', 'offers.example.net'],
        pathPrefix: null,
        brandTerms: ['DemandIQ', 'Demand IQ', 'Demand Intelligence'],
        queryMixScope: 'property',
      },
      acquisition: {
        status: 'ready',
        error: null,
        syncedAt: NOW,
        periods: [
          {
            label: 'earliest',
            startDate: daysBefore(GA_ANCHOR, 89),
            endDate: daysBefore(GA_ANCHOR, 60),
            sessions: 10,
          },
          {
            label: 'middle',
            startDate: daysBefore(GA_ANCHOR, 59),
            endDate: daysBefore(GA_ANCHOR, 30),
            sessions: 30,
          },
          {
            label: 'latest',
            startDate: daysBefore(GA_ANCHOR, 29),
            endDate: GA_ANCHOR,
            sessions: 45,
          },
        ],
      },
    })
    expect(body.acquisition.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channelGroup: 'Paid Search',
        periods: expect.arrayContaining([
          expect.objectContaining({ label: 'latest', sessions: 40 }),
        ]),
      }),
      expect.objectContaining({
        channelGroup: 'Organic Search',
        periods: [
          expect.objectContaining({ label: 'earliest', sessions: 10 }),
          expect.objectContaining({ label: 'middle', sessions: 30 }),
          expect.objectContaining({ label: 'latest', sessions: 5 }),
        ],
      }),
    ]))
    expect(body.acquisition.channels.map(row => row.channelGroup)).not.toContain('Other')
    expect(body.acquisition.pages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ hostName: 'demand-iq.vercel.app' }),
    ]))
  })

  it('supports all-host analysis and a boundary-safe normalized path prefix', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.vercel.app',
      landingPage: '/blog/article?utm_source=test',
      sessions: 12,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'www.demand-iq.com',
      landingPage: '/blogger',
      sessions: 30,
    })
    insertAcquisition(ctx, {
      daysAgo: 1,
      channelGroup: 'Paid Search',
      hostName: 'www.demand-iq.com',
      landingPage: '/blog',
      sessions: 4,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d&hostScope=all&pathPrefix=%2Fblog',
    })

    expect(response.statusCode).toBe(200)
    const body = gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
    expect(body.filters).toMatchObject({
      hostScope: 'all',
      pathPrefix: '/blog',
    })
    expect(body.acquisition.periods).toEqual([
      expect.objectContaining({ label: 'latest', sessions: 16 }),
    ])
    expect(body.acquisition.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hostName: 'demand-iq.vercel.app',
        landingPage: '/blog/article',
      }),
      expect.objectContaining({
        hostName: 'www.demand-iq.com',
        landingPage: '/blog',
      }),
    ]))
    expect(body.acquisition.pages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ landingPage: '/blogger' }),
    ]))
  })

  it('applies host/path filters to landing-page leads but labels channel-only fallback as unfiltered', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'www.demand-iq.com',
      landingPage: '/blog/article',
      sessions: 10,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'www.demand-iq.com',
      landingPage: '/blog/article',
      eventCount: 3,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: 'demand-iq.vercel.app',
      landingPage: '/preview',
      eventCount: 9,
    })
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: NOW,
      leadStatus: 'ready',
      leadSyncedAt: NOW,
      leadAttributionScope: 'landing-page',
      updatedAt: NOW,
    }).run()

    const filtered = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fblog',
    })
    expect(filtered.statusCode).toBe(200)
    expect(JSON.parse(filtered.body)).toMatchObject({
      leads: {
        status: 'ready',
        attributionScope: 'landing-page',
        hostAndPathFiltersApplied: true,
        periods: [expect.objectContaining({ label: 'latest', eventCount: 3 })],
      },
    })

    ctx.db.delete(gaLeadEventsDaily).run()
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: '(not available)',
      landingPage: '(not available)',
      eventCount: 7,
      attributionScope: 'channel',
    })
    ctx.db.update(gaMeasurementSyncStates).set({
      leadAttributionScope: 'channel',
      updatedAt: NOW,
    }).run()

    const fallback = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fblog',
    })
    expect(fallback.statusCode).toBe(200)
    expect(JSON.parse(fallback.body)).toMatchObject({
      leads: {
        status: 'ready',
        attributionScope: 'channel',
        hostAndPathFiltersApplied: false,
        periods: [expect.objectContaining({ label: 'latest', eventCount: 7 })],
      },
    })
  })

  it('anchors GA cohorts to the newest included acquisition or lead row', async () => {
    insertAcquisition(ctx, {
      daysAgo: 10,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/guide',
      sessions: 4,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/guide',
      eventCount: 2,
    })
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: NOW,
      leadStatus: 'ready',
      leadSyncedAt: NOW,
      leadAttributionScope: 'landing-page',
      updatedAt: NOW,
    }).run()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      acquisition: {
        periods: [{
          endDate: GA_ANCHOR,
          sessions: 4,
        }],
      },
      leads: {
        periods: [{
          endDate: GA_ANCHOR,
          eventCount: 2,
        }],
      },
    })
  })

  it('does not let newer excluded hosts move the default marketing cohort window', async () => {
    insertAcquisition(ctx, {
      daysAgo: 35,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/guide',
      sessions: 4,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Display',
      hostName: 'demand-iq.vercel.app',
      landingPage: '/preview',
      sessions: 100,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      acquisition: {
        periods: [{
          endDate: daysBefore(GA_ANCHOR, 35),
          sessions: 4,
        }],
      },
    })
  })

  it('applies host and path filters before choosing the landing-page lead anchor', async () => {
    insertLead(ctx, {
      daysAgo: 30,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/guides/organic',
      eventCount: 3,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: 'demand-iq.com',
      landingPage: '/quote',
      eventCount: 9,
    })
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'never-synced',
      leadStatus: 'ready',
      leadSyncedAt: NOW,
      leadAttributionScope: 'landing-page',
      updatedAt: NOW,
    }).run()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fguides',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      leads: {
        hostAndPathFiltersApplied: true,
        periods: [{
          endDate: daysBefore(GA_ANCHOR, 30),
          eventCount: 3,
        }],
      },
    })
  })

  it('treats pathPrefix=/ as the whole site instead of homepage-only', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/',
      sessions: 2,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/pricing',
      sessions: 5,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d&pathPrefix=%2F',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      filters: { pathPrefix: '/' },
      acquisition: {
        periods: [{ sessions: 7 }],
        pages: expect.arrayContaining([
          expect.objectContaining({ landingPage: '/' }),
          expect.objectContaining({ landingPage: '/pricing' }),
        ]),
      },
    })
  })

  it('classifies reported GSC queries conservatively and exposes the anonymized residual', async () => {
    insertGscPropertyTotal(ctx, { daysAgo: 0, clicks: 20, impressions: 300 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'demand iq platform', clicks: 8, impressions: 80 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'demand-iq.com pricing', clicks: 2, impressions: 20 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'solar sales software', clicks: 5, impressions: 90 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'demanding software buyers', clicks: 1, impressions: 10 })
    insertGscPropertyTotal(ctx, { daysAgo: 35, clicks: 12, impressions: 180 })
    insertGscQuery(ctx, { daysAgo: 35, query: 'demand iq', clicks: 4, impressions: 40 })
    insertGscQuery(ctx, { daysAgo: 35, query: 'solar proposal tools', clicks: 5, impressions: 80 })
    insertGscPage(ctx, {
      daysAgo: 0,
      query: 'solar sales software',
      page: 'https://www.demand-iq.com/blog/ai-marketing',
      clicks: 3,
      impressions: 120,
    })
    insertGscPage(ctx, {
      daysAgo: 0,
      query: 'preview',
      page: 'https://demand-iq.vercel.app/blog/preview',
      clicks: 10,
      impressions: 500,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=60d&pathPrefix=%2Fblog',
    })

    expect(response.statusCode).toBe(200)
    const body = gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
    expect(body.searchDemand).toMatchObject({
      status: 'ready',
      latestDate: GSC_ANCHOR,
      periods: [
        {
          label: 'previous',
          startDate: daysBefore(GSC_ANCHOR, 59),
          endDate: daysBefore(GSC_ANCHOR, 30),
          propertyClicks: 12,
          propertyImpressions: 180,
          reportedQueryClicks: 9,
          reportedQueryImpressions: 120,
          brandedClicks: 4,
          brandedImpressions: 40,
          nonBrandedClicks: 5,
          nonBrandedImpressions: 80,
          unreportedClicks: 3,
          unreportedImpressions: 60,
        },
        {
          label: 'latest',
          startDate: daysBefore(GSC_ANCHOR, 29),
          endDate: GSC_ANCHOR,
          propertyClicks: 20,
          propertyImpressions: 300,
          reportedQueryClicks: 16,
          reportedQueryImpressions: 200,
          brandedClicks: 10,
          brandedImpressions: 100,
          nonBrandedClicks: 6,
          nonBrandedImpressions: 100,
          unreportedClicks: 4,
          unreportedImpressions: 100,
        },
      ],
    })
    expect(body.searchDemand.queries).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: 'demand iq platform', classification: 'branded' }),
      expect.objectContaining({ query: 'demand-iq.com pricing', classification: 'branded' }),
      expect.objectContaining({ query: 'demanding software buyers', classification: 'non-branded' }),
      expect.objectContaining({ query: 'solar sales software', classification: 'non-branded' }),
    ]))
    expect(body.searchDemand.pages).toEqual([
      expect.objectContaining({
        hostName: 'www.demand-iq.com',
        landingPage: '/blog/ai-marketing',
        periods: [
          expect.objectContaining({ label: 'previous', clicks: 0, impressions: 0 }),
          expect.objectContaining({ label: 'latest', clicks: 3, impressions: 120 }),
        ],
      }),
    ])
  })

  it('surfaces independent error states with last-good rows and validates public filters', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/',
      sessions: 4,
    })
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'error',
      acquisitionError: 'quota exhausted',
      acquisitionSyncedAt: NOW,
      leadStatus: 'never-synced',
      updatedAt: NOW,
    }).run()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/ga/measurement-analysis?window=30d',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      acquisition: {
        status: 'error',
        error: 'quota exhausted',
        syncedAt: NOW,
        periods: [expect.objectContaining({ sessions: 4 })],
      },
      leads: {
        status: 'never-synced',
        periods: [],
      },
      searchDemand: {
        status: 'unavailable',
        periods: [],
        queries: [],
        pages: [],
        latestDate: null,
      },
    })

    for (const query of ['window=45d', 'hostScope=canonical-only', 'limit=0', 'limit=101']) {
      const invalid = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/projects/demand-iq/ga/measurement-analysis?${query}`,
      })
      expect(invalid.statusCode).toBe(400)
    }
  })

  it('publishes the endpoint with its typed response schema in OpenAPI', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
    })
    expect(response.statusCode).toBe(200)
    const spec = JSON.parse(response.body) as { paths: Record<string, { get?: unknown }> }
    expect(spec.paths['/api/v1/projects/{name}/ga/measurement-analysis']?.get).toMatchObject({
      summary: expect.stringContaining('measurement'),
      responses: {
        200: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GA4MeasurementAnalysisDto' },
            },
          },
        },
      },
    })
  })
})
