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
    url: '/api/v1/projects/harbor-iq',
    payload: {
      displayName: 'HarborIQ',
      canonicalDomain: 'harbor-iq.test',
      ownedDomains: ['harboriq.test'],
      aliases: ['Harbor IQ'],
      country: 'US',
      language: 'en',
      measurement: {
        marketingHosts: ['offers.example.net'],
        brandTerms: ['Harbor Intelligence'],
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
  ctx.credentials.set('harbor-iq', {
    projectName: 'harbor-iq',
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
    source?: string
    medium?: string
  },
) {
  ctx.db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GA_ANCHOR, input.daysAgo),
    channelGroup: input.channelGroup,
    source: input.source ?? (input.channelGroup === 'Direct' ? '(direct)' : 'google'),
    medium: input.medium ?? (input.channelGroup === 'Paid Search' ? 'cpc' : 'organic'),
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
    source?: string
    medium?: string
  },
) {
  const attributionScope = input.attributionScope ?? 'landing-page'
  ctx.db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: daysBefore(GA_ANCHOR, input.daysAgo),
    eventName: 'generate_lead',
    channelGroup: input.channelGroup,
    source: input.source ?? 'google',
    medium: input.medium ?? (input.channelGroup === 'Paid Search' ? 'cpc' : 'organic'),
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
      hostName: 'www.harbor-iq.test',
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
      hostName: 'harbor-iq.vercel.app',
      landingPage: '/preview',
      sessions: 100,
    })
    insertAcquisition(ctx, {
      daysAgo: 35,
      channelGroup: 'Organic Search',
      hostName: 'harboriq.test',
      landingPage: '/blog/guide',
      sessions: 30,
    })
    insertAcquisition(ctx, {
      daysAgo: 65,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.test',
      landingPage: '/blog/guide',
      sessions: 10,
    })
    insertAcquisition(ctx, {
      daysAgo: 95,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.test',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=90d',
    })

    expect(response.statusCode).toBe(200)
    const body = gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
    expect(body).toMatchObject({
      window: '90d',
      bucketDays: 30,
      filters: {
        hostScope: 'marketing',
        marketingHosts: ['harbor-iq.test', 'harboriq.test', 'offers.example.net'],
        pathPrefix: null,
        brandTerms: ['HarborIQ', 'Harbor IQ', 'Harbor Intelligence'],
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
      expect.objectContaining({ hostName: 'harbor-iq.vercel.app' }),
    ]))
  })

  it('supports all-host analysis and a boundary-safe normalized path prefix', async () => {
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.vercel.app',
      landingPage: '/blog/article?utm_source=test',
      sessions: 12,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'www.harbor-iq.test',
      landingPage: '/blogger',
      sessions: 30,
    })
    insertAcquisition(ctx, {
      daysAgo: 1,
      channelGroup: 'Paid Search',
      hostName: 'www.harbor-iq.test',
      landingPage: '/blog',
      sessions: 4,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&hostScope=all&pathPrefix=%2Fblog',
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
        hostName: 'harbor-iq.vercel.app',
        landingPage: '/blog/article',
      }),
      expect.objectContaining({
        hostName: 'www.harbor-iq.test',
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
      hostName: 'www.harbor-iq.test',
      landingPage: '/blog/article',
      sessions: 10,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'www.harbor-iq.test',
      landingPage: '/blog/article',
      eventCount: 3,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: 'harbor-iq.vercel.app',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fblog',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fblog',
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
      hostName: 'harbor-iq.test',
      landingPage: '/guide',
      sessions: 4,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.test',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d',
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
      hostName: 'harbor-iq.test',
      landingPage: '/guide',
      sessions: 4,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Display',
      hostName: 'harbor-iq.vercel.app',
      landingPage: '/preview',
      sessions: 100,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d',
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

  it('uses the raw landing path for scoped anchors when legacy normalized paths are null', async () => {
    ctx.db.insert(gaAcquisitionDaily).values([
      {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        date: daysBefore(GA_ANCHOR, 35),
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'www.harbor-iq.test',
        landingPage: '/guides/legacy?utm_source=google',
        landingPageNormalized: null,
        sessions: 4,
        syncedAt: NOW,
        createdAt: NOW,
      },
      {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        date: GA_ANCHOR,
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'www.harbor-iq.test',
        landingPage: '/quote',
        landingPageNormalized: '/quote',
        sessions: 100,
        syncedAt: NOW,
        createdAt: NOW,
      },
    ]).run()

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fguides',
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      acquisition: {
        periods: [{
          endDate: daysBefore(GA_ANCHOR, 35),
          sessions: 4,
        }],
        pages: [
          expect.objectContaining({ landingPage: '/guides/legacy' }),
        ],
      },
    })
  })

  it('applies host and path filters before choosing the landing-page lead anchor', async () => {
    insertLead(ctx, {
      daysAgo: 30,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.test',
      landingPage: '/guides/organic',
      eventCount: 3,
    })
    insertLead(ctx, {
      daysAgo: 0,
      channelGroup: 'Paid Search',
      hostName: 'harbor-iq.test',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&pathPrefix=%2Fguides',
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
      hostName: 'harbor-iq.test',
      landingPage: '/',
      sessions: 2,
    })
    insertAcquisition(ctx, {
      daysAgo: 0,
      channelGroup: 'Organic Search',
      hostName: 'harbor-iq.test',
      landingPage: '/pricing',
      sessions: 5,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d&pathPrefix=%2F',
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

  describe('leads by AI engine', () => {
    const MARKETING = 'www.harbor-iq.test'
    const PREVIEW = 'harbor-iq.vercel.app'

    function markLeadsSynced(
      scope: 'landing-page' | 'channel',
      status: { acquisition?: 'ready' | 'error'; leads?: 'ready' | 'error' } = {},
    ) {
      const values = {
        acquisitionStatus: status.acquisition ?? 'ready',
        acquisitionSyncedAt: NOW,
        leadStatus: status.leads ?? 'ready',
        leadSyncedAt: NOW,
        leadAttributionScope: scope,
        updatedAt: NOW,
      }
      ctx.db.insert(gaMeasurementSyncStates).values({ projectId: ctx.projectId, ...values }).onConflictDoUpdate({
        target: gaMeasurementSyncStates.projectId,
        set: values,
      }).run()
    }

    function seedAiSessions() {
      // Latest cohort (days 0..29 ago) unless noted. Sources are stored the way
      // GA4 returns sessionSource: referrer hosts, utm tags, mixed case.
      const rows: Array<{ daysAgo: number; hostName: string; landingPage: string; source: string; sessions: number; channelGroup?: string }> = [
        { daysAgo: 0, hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', sessions: 40 },
        { daysAgo: 1, hostName: MARKETING, landingPage: '/pricing?utm_source=ChatGPT.com', source: 'ChatGPT.com', sessions: 10 },
        { daysAgo: 2, hostName: MARKETING, landingPage: '/pricing', source: 'perplexity', sessions: 20 },
        { daysAgo: 3, hostName: MARKETING, landingPage: '/blog/post', source: 'perplexity.ai', sessions: 30 },
        { daysAgo: 4, hostName: MARKETING, landingPage: '/pricing', source: 'copilot.microsoft.com', sessions: 5 },
        { daysAgo: 0, hostName: PREVIEW, landingPage: '/pricing', source: 'chatgpt.com', sessions: 500 },
        { daysAgo: 0, hostName: MARKETING, landingPage: '/pricing', source: 'google', sessions: 100, channelGroup: 'Organic Search' },
        // Every day with a stored lead row has stored sessions too, as a complete
        // sync gives; the day-5 Gemini lead's own engine still has none.
        { daysAgo: 5, hostName: MARKETING, landingPage: '/pricing', source: 'google', sessions: 60, channelGroup: 'Organic Search' },
        // Previous cohort (days 30..59 ago).
        { daysAgo: 40, hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', sessions: 25 },
      ]
      for (const row of rows) {
        insertAcquisition(ctx, { channelGroup: 'Referral', ...row })
      }
    }

    function seedAiLeads() {
      const rows: Array<{ daysAgo: number; hostName: string; landingPage: string; source: string; eventCount: number; channelGroup?: string }> = [
        { daysAgo: 0, hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 3 },
        { daysAgo: 1, hostName: MARKETING, landingPage: '/pricing?utm_source=ChatGPT.com', source: 'ChatGPT.com', eventCount: 2 },
        { daysAgo: 2, hostName: MARKETING, landingPage: '/pricing', source: 'perplexity', eventCount: 1 },
        { daysAgo: 3, hostName: MARKETING, landingPage: '/blog/post', source: 'perplexity.ai', eventCount: 1 },
        // A lead with no matching acquisition session: a count, but no rate.
        { daysAgo: 5, hostName: MARKETING, landingPage: '/pricing', source: 'gemini.google.com', eventCount: 2 },
        { daysAgo: 0, hostName: PREVIEW, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 9 },
        { daysAgo: 0, hostName: MARKETING, landingPage: '/pricing', source: 'google', eventCount: 7, channelGroup: 'Organic Search' },
        { daysAgo: 40, hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 1 },
      ]
      for (const row of rows) {
        insertLead(ctx, { channelGroup: 'Referral', ...row })
      }
    }

    async function analysis(query: string) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/projects/harbor-iq/ga/measurement-analysis?${query}`,
      })
      expect(response.statusCode).toBe(200)
      return gaMeasurementAnalysisDtoSchema.parse(JSON.parse(response.body))
    }

    const previous = { label: 'previous', startDate: daysBefore(GA_ANCHOR, 59), endDate: daysBefore(GA_ANCHOR, 30) }
    const latest = { label: 'latest', startDate: daysBefore(GA_ANCHOR, 29), endDate: GA_ANCHOR }
    type Bucket = { label: string; startDate: string; endDate: string }
    const empty = (bucket: Bucket) => ({ ...bucket, eventCount: 0, sessions: 0, leadRate: null })
    const noUnattributed = (buckets: Bucket[]) => ({ sources: [], periods: buckets.map(empty) })

    it('counts lead events and same-source sessions per engine in the channel cohorts, with a lead rate', async () => {
      seedAiSessions()
      seedAiLeads()
      markLeadsSynced('landing-page')

      const body = await analysis('window=60d')
      const { aiEngines } = body.leads

      expect(aiEngines.leadRateAvailable).toBe(true)
      expect(aiEngines.leadRateUnavailableReason).toBeNull()
      expect(aiEngines.organic.engines).toEqual([
        {
          engine: 'chatgpt',
          label: 'ChatGPT',
          // Both spellings fold into one engine; the preview host is filtered out.
          sources: ['ChatGPT.com', 'chatgpt.com'],
          periods: [
            { ...previous, eventCount: 1, sessions: 25, leadRate: 0.04 },
            { ...latest, eventCount: 5, sessions: 50, leadRate: 0.1 },
          ],
        },
        {
          engine: 'perplexity',
          label: 'Perplexity',
          sources: ['perplexity', 'perplexity.ai'],
          periods: [
            { ...previous, eventCount: 0, sessions: 0, leadRate: null },
            { ...latest, eventCount: 2, sessions: 50, leadRate: 0.04 },
          ],
        },
        {
          // Ties Perplexity on lead events; ranks below it on sessions.
          engine: 'gemini',
          label: 'Gemini',
          sources: ['gemini.google.com'],
          periods: [
            { ...previous, eventCount: 0, sessions: 0, leadRate: null },
            { ...latest, eventCount: 2, sessions: 0, leadRate: null },
          ],
        },
        {
          // Sessions but no lead events is a measured 0% rate, not a missing one.
          engine: 'copilot',
          label: 'Copilot',
          sources: ['copilot.microsoft.com'],
          periods: [
            { ...previous, eventCount: 0, sessions: 0, leadRate: null },
            { ...latest, eventCount: 0, sessions: 5, leadRate: 0 },
          ],
        },
      ])
      expect(aiEngines.organic.unattributed).toEqual(noUnattributed([previous, latest]))
      // 9 / 105 at wire precision.
      expect(aiEngines.organic.periods).toEqual([
        { ...previous, eventCount: 1, sessions: 25, leadRate: 0.04 },
        { ...latest, eventCount: 9, sessions: 105, leadRate: 0.08571429 },
      ])
      // No paid evidence on any row: the paid block is all zero.
      expect(aiEngines.paid).toEqual({
        periods: [empty(previous), empty(latest)],
        engines: [],
        unattributed: noUnattributed([previous, latest]),
      })

      // The engine rows add up to the all-engine total, and that total is every
      // lead in the window minus the non-AI source (google, 7 latest events).
      for (const [index, total] of aiEngines.organic.periods.entries()) {
        const engineSum = aiEngines.organic.engines.reduce((sum, row) => sum + row.periods[index]!.eventCount, 0)
        expect(engineSum).toBe(total.eventCount)
      }
      expect(body.leads.periods.map(period => period.eventCount)).toEqual([1, 16])
    })

    it('keeps tagged ChatGPT ad clicks out of the organic ChatGPT row and rates them on their own', async () => {
      seedAiSessions()
      seedAiLeads()
      // The shape GA4 gives a tagged ChatGPT ad click: source chatgpt, medium cpc, Paid Other.
      insertAcquisition(ctx, {
        daysAgo: 0,
        channelGroup: 'Paid Other',
        hostName: MARKETING,
        landingPage: '/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=spring',
        source: 'chatgpt',
        medium: 'cpc',
        sessions: 200,
      })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Paid Other',
        hostName: MARKETING,
        landingPage: '/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=spring',
        source: 'chatgpt',
        medium: 'cpc',
        eventCount: 30,
      })
      markLeadsSynced('landing-page')

      const { aiEngines } = (await analysis('window=30d')).leads

      // Organic ChatGPT is unchanged by the 200 paid sessions and 30 paid leads.
      expect(aiEngines.organic.engines[0]).toEqual({
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['ChatGPT.com', 'chatgpt.com'],
        periods: [{ ...latest, eventCount: 5, sessions: 50, leadRate: 0.1 }],
      })
      expect(aiEngines.organic.periods).toEqual([{ ...latest, eventCount: 9, sessions: 105, leadRate: 0.08571429 }])
      expect(aiEngines.paid).toEqual({
        periods: [{ ...latest, eventCount: 30, sessions: 200, leadRate: 0.15 }],
        engines: [{
          engine: 'chatgpt',
          label: 'ChatGPT',
          sources: ['chatgpt'],
          periods: [{ ...latest, eventCount: 30, sessions: 200, leadRate: 0.15 }],
        }],
        unattributed: noUnattributed([latest]),
      })
    })

    it('counts GA4 AI Assistant channel rows that match no engine as unattributed AI traffic', async () => {
      seedAiSessions()
      seedAiLeads()
      insertAcquisition(ctx, {
        daysAgo: 0,
        channelGroup: 'AI Assistant',
        hostName: MARKETING,
        landingPage: '/pricing',
        source: 'assistant.example.com',
        medium: 'ai-assistant',
        sessions: 20,
      })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'AI Assistant',
        hostName: MARKETING,
        landingPage: '/pricing',
        source: 'assistant.example.com',
        medium: 'ai-assistant',
        eventCount: 4,
      })
      // An unknown source outside the AI channel is not AI traffic.
      insertAcquisition(ctx, {
        daysAgo: 0,
        channelGroup: 'Referral',
        hostName: MARKETING,
        landingPage: '/pricing',
        source: 'news.example.com',
        sessions: 70,
      })
      markLeadsSynced('landing-page')

      const body = await analysis('window=30d')
      const { organic } = body.leads.aiEngines

      expect(organic.engines.map(row => row.engine)).toEqual(['chatgpt', 'perplexity', 'gemini', 'copilot'])
      expect(organic.unattributed).toEqual({
        sources: ['assistant.example.com'],
        periods: [{ ...latest, eventCount: 4, sessions: 20, leadRate: 0.2 }],
      })
      // The total includes the unattributed rows, so it never reads below GA4's AI channel.
      expect(organic.periods).toEqual([{ ...latest, eventCount: 13, sessions: 125, leadRate: 0.104 }])
      const aiChannel = body.leads.channels.find(row => row.channelGroup === 'AI Assistant')
      expect(organic.periods[0]!.eventCount).toBeGreaterThanOrEqual(aiChannel!.periods[0]!.eventCount)
    })

    it('applies pathPrefix and hostScope to both the lead events and the sessions', async () => {
      seedAiSessions()
      seedAiLeads()
      markLeadsSynced('landing-page')

      const blog = await analysis('window=30d&pathPrefix=%2Fblog')
      // The cohort anchors on the newest row inside the path, as the channel breakdown does.
      const blogLatest = { label: 'latest', startDate: daysBefore(GA_ANCHOR, 32), endDate: daysBefore(GA_ANCHOR, 3) }
      expect(blog.leads.aiEngines.leadRateAvailable).toBe(true)
      expect(blog.leads.aiEngines.organic).toEqual({
        periods: [{ ...blogLatest, eventCount: 1, sessions: 30, leadRate: 0.03333333 }],
        engines: [{
          engine: 'perplexity',
          label: 'Perplexity',
          sources: ['perplexity.ai'],
          periods: [{ ...blogLatest, eventCount: 1, sessions: 30, leadRate: 0.03333333 }],
        }],
        unattributed: noUnattributed([blogLatest]),
      })

      // Every host: the preview host's 500 sessions and 9 lead events join ChatGPT.
      const allHosts = await analysis('window=30d&hostScope=all')
      expect(allHosts.leads.aiEngines.organic.engines[0]).toEqual({
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['ChatGPT.com', 'chatgpt.com'],
        periods: [{ ...latest, eventCount: 14, sessions: 550, leadRate: 0.02545455 }],
      })
    })

    it('keeps channel-scoped AI lead counts but withholds the rate while host or path filters narrow sessions', async () => {
      seedAiSessions()
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Referral',
        hostName: '(not available)',
        landingPage: '(not available)',
        source: 'chatgpt.com',
        eventCount: 4,
        attributionScope: 'channel',
      })
      markLeadsSynced('channel')

      const marketing = await analysis('window=30d')
      expect(marketing.leads.attributionScope).toBe('channel')
      expect(marketing.leads.aiEngines.leadRateAvailable).toBe(false)
      expect(marketing.leads.aiEngines.leadRateUnavailableReason).toBe('channel-leads-unfiltered')
      expect(marketing.leads.aiEngines.organic.engines[0]).toEqual({
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['ChatGPT.com', 'chatgpt.com'],
        periods: [{ ...latest, eventCount: 4, sessions: 50, leadRate: null }],
      })
      expect(marketing.leads.aiEngines.organic.periods).toEqual([
        { ...latest, eventCount: 4, sessions: 105, leadRate: null },
      ])

      // No narrowing filter: channel-level leads and all-host sessions share a scope.
      const allHosts = await analysis('window=30d&hostScope=all&pathPrefix=%2F')
      expect(allHosts.leads.aiEngines.leadRateAvailable).toBe(true)
      expect(allHosts.leads.aiEngines.leadRateUnavailableReason).toBeNull()
      expect(allHosts.leads.aiEngines.organic.engines[0]?.periods).toEqual([
        { ...latest, eventCount: 4, sessions: 550, leadRate: 0.00727273 },
      ])
    })

    it('withholds the rate when lead events run past the last stored acquisition date', async () => {
      // Acquisition stopped landing 17 days ago while leads kept syncing.
      insertAcquisition(ctx, { daysAgo: 17, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', sessions: 40 })
      insertLead(ctx, { daysAgo: 17, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 2 })
      insertLead(ctx, { daysAgo: 0, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 3 })
      markLeadsSynced('landing-page')

      const { aiEngines } = (await analysis('window=30d')).leads

      expect(aiEngines.leadRateAvailable).toBe(false)
      expect(aiEngines.leadRateUnavailableReason).toBe('sessions-behind-leads')
      // Counts stay; the rate that would read 5 / 40 is withheld.
      expect(aiEngines.organic.engines[0]?.periods).toEqual([
        { ...latest, eventCount: 5, sessions: 40, leadRate: null },
      ])
      expect(aiEngines.organic.periods).toEqual([
        { ...latest, eventCount: 5, sessions: 40, leadRate: null },
      ])
    })

    it('withholds the rate when a day inside the window has lead events but no stored sessions', async () => {
      insertAcquisition(ctx, { daysAgo: 0, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', sessions: 40 })
      insertAcquisition(ctx, { daysAgo: 20, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', sessions: 30 })
      insertLead(ctx, { daysAgo: 0, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 3 })
      // Acquisition skipped day 10 while leads kept syncing; the latest dates still match.
      insertLead(ctx, { daysAgo: 10, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', eventCount: 2 })
      markLeadsSynced('landing-page')

      const gap = (await analysis('window=30d')).leads.aiEngines
      expect(gap.leadRateAvailable).toBe(false)
      expect(gap.leadRateUnavailableReason).toBe('sessions-missing-on-lead-days')
      // Counts stay; the rate that would read 5 / 70 is withheld.
      expect(gap.organic.periods).toEqual([{ ...latest, eventCount: 5, sessions: 70, leadRate: null }])

      // Any stored session that day closes the gap, even one the filters leave
      // out (another host, a non-AI source): coverage reads the unfiltered rows.
      insertAcquisition(ctx, { daysAgo: 10, channelGroup: 'Organic Search', hostName: PREVIEW, landingPage: '/pricing', source: 'google', sessions: 15 })
      const covered = (await analysis('window=30d')).leads.aiEngines
      expect(covered.leadRateAvailable).toBe(true)
      expect(covered.leadRateUnavailableReason).toBeNull()
      expect(covered.organic.periods).toEqual([{ ...latest, eventCount: 5, sessions: 70, leadRate: 0.07142857 }])
    })

    it('classifies sessions without their landing page when leads are channel-scoped, and withholds the rate when only the landing page said paid', async () => {
      // GA4 has no paid medium or channel for these clicks; only utm_campaign on the landing page says paid.
      insertAcquisition(ctx, {
        daysAgo: 0,
        channelGroup: 'Unassigned',
        hostName: MARKETING,
        landingPage: '/pricing?utm_source=chatgpt&utm_campaign=spring_ads',
        source: 'chatgpt',
        medium: '(not set)',
        sessions: 200,
      })
      insertAcquisition(ctx, { daysAgo: 0, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', medium: 'referral', sessions: 100 })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Unassigned',
        hostName: '(not available)',
        landingPage: '(not available)',
        source: 'chatgpt',
        medium: '(not set)',
        eventCount: 30,
        attributionScope: 'channel',
      })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Referral',
        hostName: '(not available)',
        landingPage: '(not available)',
        source: 'chatgpt.com',
        medium: 'referral',
        eventCount: 2,
        attributionScope: 'channel',
      })
      markLeadsSynced('channel')

      const { aiEngines } = (await analysis('window=30d&hostScope=all')).leads

      // The 30 lead events and the 200 sessions they came from read the same
      // evidence, so they share a class: 32 / 300 organic, never 32 / 100
      // organic beside 0 / 200 paid.
      const chatgpt = {
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['chatgpt', 'chatgpt.com'],
        periods: [{ ...latest, eventCount: 32, sessions: 300, leadRate: null }],
      }
      expect(aiEngines.organic).toEqual({
        periods: [{ ...latest, eventCount: 32, sessions: 300, leadRate: null }],
        engines: [chatgpt],
        unattributed: noUnattributed([latest]),
      })
      expect(aiEngines.paid).toEqual({
        periods: [empty(latest)],
        engines: [],
        unattributed: noUnattributed([latest]),
      })
      // Dropping the landing page moved paid clicks into organic, so no rate is honest.
      expect(aiEngines.leadRateAvailable).toBe(false)
      expect(aiEngines.leadRateUnavailableReason).toBe('paid-split-needs-landing-page')
    })

    it('keeps the rate for channel-scoped leads when the paid evidence does not depend on the landing page', async () => {
      // Tagged with a paid medium: GA4 reports cpc / Paid Other with or without the landing page.
      insertAcquisition(ctx, {
        daysAgo: 0,
        channelGroup: 'Paid Other',
        hostName: MARKETING,
        landingPage: '/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=spring_ads',
        source: 'chatgpt',
        medium: 'cpc',
        sessions: 200,
      })
      insertAcquisition(ctx, { daysAgo: 0, channelGroup: 'Referral', hostName: MARKETING, landingPage: '/pricing', source: 'chatgpt.com', medium: 'referral', sessions: 100 })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Paid Other',
        hostName: '(not available)',
        landingPage: '(not available)',
        source: 'chatgpt',
        medium: 'cpc',
        eventCount: 30,
        attributionScope: 'channel',
      })
      insertLead(ctx, {
        daysAgo: 0,
        channelGroup: 'Referral',
        hostName: '(not available)',
        landingPage: '(not available)',
        source: 'chatgpt.com',
        medium: 'referral',
        eventCount: 2,
        attributionScope: 'channel',
      })
      markLeadsSynced('channel')

      const { aiEngines } = (await analysis('window=30d&hostScope=all')).leads

      expect(aiEngines.leadRateAvailable).toBe(true)
      expect(aiEngines.leadRateUnavailableReason).toBeNull()
      expect(aiEngines.organic.engines).toEqual([{
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['chatgpt.com'],
        periods: [{ ...latest, eventCount: 2, sessions: 100, leadRate: 0.02 }],
      }])
      expect(aiEngines.paid.engines).toEqual([{
        engine: 'chatgpt',
        label: 'ChatGPT',
        sources: ['chatgpt'],
        periods: [{ ...latest, eventCount: 30, sessions: 200, leadRate: 0.15 }],
      }])
      expect(aiEngines.organic.periods).toEqual([{ ...latest, eventCount: 2, sessions: 100, leadRate: 0.02 }])
      expect(aiEngines.paid.periods).toEqual([{ ...latest, eventCount: 30, sessions: 200, leadRate: 0.15 }])
    })

    it('withholds the rate while the latest acquisition or lead sync is in error', async () => {
      seedAiSessions()
      seedAiLeads()
      markLeadsSynced('landing-page', { leads: 'error' })

      const leadError = (await analysis('window=30d')).leads.aiEngines
      expect(leadError.leadRateAvailable).toBe(false)
      expect(leadError.leadRateUnavailableReason).toBe('sync-not-ready')
      expect(leadError.organic.engines[0]?.periods).toEqual([
        { ...latest, eventCount: 5, sessions: 50, leadRate: null },
      ])

      markLeadsSynced('landing-page', { acquisition: 'error' })
      const acquisitionError = (await analysis('window=30d')).leads.aiEngines
      expect(acquisitionError.leadRateUnavailableReason).toBe('sync-not-ready')
      expect(acquisitionError.organic.periods.every(period => period.leadRate === null)).toBe(true)
    })

    it('leaves the block empty when no lead sync has run, even with AI sessions', async () => {
      seedAiSessions()

      const body = await analysis('window=30d')
      expect(body.leads.status).toBe('never-synced')
      expect(body.leads.aiEngines).toEqual({
        leadRateAvailable: false,
        leadRateUnavailableReason: 'no-data',
        organic: { periods: [], engines: [], unattributed: { sources: [], periods: [] } },
        paid: { periods: [], engines: [], unattributed: { sources: [], periods: [] } },
      })
    })
  })

  it('classifies reported GSC queries conservatively and exposes the anonymized residual', async () => {
    insertGscPropertyTotal(ctx, { daysAgo: 0, clicks: 20, impressions: 300 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'harbor iq platform', clicks: 8, impressions: 80 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'harbor-iq.test pricing', clicks: 2, impressions: 20 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'solar sales software', clicks: 5, impressions: 90 })
    insertGscQuery(ctx, { daysAgo: 0, query: 'harboring software buyers', clicks: 1, impressions: 10 })
    insertGscPropertyTotal(ctx, { daysAgo: 35, clicks: 12, impressions: 180 })
    insertGscQuery(ctx, { daysAgo: 35, query: 'harbor iq', clicks: 4, impressions: 40 })
    insertGscQuery(ctx, { daysAgo: 35, query: 'solar proposal tools', clicks: 5, impressions: 80 })
    insertGscPage(ctx, {
      daysAgo: 0,
      query: 'solar sales software',
      page: 'https://www.harbor-iq.test/blog/ai-marketing',
      clicks: 3,
      impressions: 120,
    })
    insertGscPage(ctx, {
      daysAgo: 0,
      query: 'preview',
      page: 'https://harbor-iq.vercel.app/blog/preview',
      clicks: 10,
      impressions: 500,
    })

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=60d&pathPrefix=%2Fblog',
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
      expect.objectContaining({ query: 'harbor iq platform', classification: 'branded' }),
      expect.objectContaining({ query: 'harbor-iq.test pricing', classification: 'branded' }),
      expect.objectContaining({ query: 'harboring software buyers', classification: 'non-branded' }),
      expect.objectContaining({ query: 'solar sales software', classification: 'non-branded' }),
    ]))
    expect(body.searchDemand.pages).toEqual([
      expect.objectContaining({
        hostName: 'www.harbor-iq.test',
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
      hostName: 'harbor-iq.test',
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
      url: '/api/v1/projects/harbor-iq/ga/measurement-analysis?window=30d',
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
        url: `/api/v1/projects/harbor-iq/ga/measurement-analysis?${query}`,
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
