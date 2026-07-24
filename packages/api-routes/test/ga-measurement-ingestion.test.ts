import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  RunStatuses,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  migrate,
  runs,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { Ga4CredentialRecord, Ga4CredentialStore } from '../src/ga.js'

function dateDaysAgo(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function measurementRange(days: number) {
  return {
    startDate: dateDaysAgo(days),
    endDate: dateDaysAgo(0),
  }
}

function buildApp(leadEventNames: string[] = ['generate_lead', 'book_demo']) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-measurement-ingestion-'))
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
  return { app, db, credentials, tmpDir, leadEventNames }
}

type Context = ReturnType<typeof buildApp> & { projectId: string }

async function seedProject(ctx: ReturnType<typeof buildApp>): Promise<string> {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/projects/measurement-ingestion',
    payload: {
      displayName: 'Measurement Ingestion',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      measurement: {
        marketingHosts: ['offers.example.com'],
        brandTerms: ['Example'],
        leadEventNames: ctx.leadEventNames,
      },
    },
  })
  expect(response.statusCode).toBe(201)
  const projectId = (JSON.parse(response.body) as { id: string }).id
  const now = new Date().toISOString()
  ctx.credentials.set('measurement-ingestion', {
    projectName: 'measurement-ingestion',
    propertyId: '123456',
    clientEmail: 'measurement@test.iam.gserviceaccount.com',
    privateKey: 'fake-key',
    createdAt: now,
    updatedAt: now,
  })
  return projectId
}

async function mockLegacyGa() {
  const ga = await import('@ainyc/canonry-integration-google-analytics')
  vi.spyOn(ga, 'getAccessToken').mockResolvedValue('fake-token')
  vi.spyOn(ga, 'fetchAggregateSummary').mockResolvedValue({
    periodStart: dateDaysAgo(29),
    periodEnd: dateDaysAgo(0),
    totalSessions: 10,
    totalOrganicSessions: 4,
    totalUsers: 8,
  })
  vi.spyOn(ga, 'fetchWindowSummary').mockImplementation(async (_token, _property, windowKey) => ({
    windowKey,
    periodStart: dateDaysAgo(windowKey === '7d' ? 6 : windowKey === '30d' ? 29 : 89),
    periodEnd: dateDaysAgo(0),
    totalSessions: 10,
    totalOrganicSessions: 4,
    totalDirectSessions: 2,
    totalUsers: 8,
  }))
  vi.spyOn(ga, 'fetchDailyTotals').mockResolvedValue([
    { date: dateDaysAgo(1), sessions: 10, users: 8 },
  ])
  vi.spyOn(ga, 'fetchTrafficByLandingPage').mockResolvedValue([
    {
      date: dateDaysAgo(1),
      landingPage: '/',
      sessions: 10,
      organicSessions: 4,
      directSessions: 2,
      users: 8,
    },
  ])
  vi.spyOn(ga, 'fetchAiReferrals').mockResolvedValue([])
  vi.spyOn(ga, 'fetchSocialReferrals').mockResolvedValue([])
  return ga
}

describe('GA measurement ingestion', () => {
  let ctx: Context

  beforeEach(async () => {
    const base = buildApp()
    await base.app.ready()
    const projectId = await seedProject(base)
    ctx = { ...base, projectId }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('backfills 90 days on first sync, ingests every host, and records independent ready states', async () => {
    const ga = await mockLegacyGa()
    const acquisitionSpy = vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
      ...measurementRange(90), rows: [
      {
        date: dateDaysAgo(2),
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'offers.example.com',
        landingPage: '/quote?utm_campaign=summer',
        sessions: 6,
      },
      {
        date: dateDaysAgo(1),
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'docs.example.net',
        landingPage: '/guides/solar',
        sessions: 4,
      },
    ] })
    const leadsSpy = vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({
      ...measurementRange(90),
      attributionScope: 'landing-page',
      rows: [{
        date: dateDaysAgo(1),
        eventName: 'book_demo',
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'offers.example.com',
        landingPage: '/demo?utm_source=google',
        eventCount: 2,
      }],
    })

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })

    expect(response.statusCode).toBe(200)
    expect(acquisitionSpy).toHaveBeenCalledWith('fake-token', '123456', 90)
    expect(leadsSpy).toHaveBeenCalledWith(
      'fake-token',
      '123456',
      ['generate_lead', 'book_demo'],
      90,
    )
    expect(JSON.parse(response.body)).toMatchObject({
      synced: true,
      measurement: {
        acquisition: { days: 90, status: 'ready', rowCount: 2 },
        leads: { days: 90, status: 'ready', rowCount: 1, attributionScope: 'landing-page' },
      },
    })

    const acquisition = ctx.db.select().from(gaAcquisitionDaily)
      .where(eq(gaAcquisitionDaily.projectId, ctx.projectId)).all()
      .sort((a, b) => a.hostName.localeCompare(b.hostName))
    expect(acquisition.map(row => row.hostName)).toEqual([
      'docs.example.net',
      'offers.example.com',
    ])
    expect(acquisition.find(row => row.hostName === 'offers.example.com')).toMatchObject({
      channelGroup: 'Paid Search',
      landingPageNormalized: '/quote',
      sessions: 6,
    })

    expect(ctx.db.select().from(gaLeadEventsDaily)
      .where(eq(gaLeadEventsDaily.projectId, ctx.projectId)).get()).toMatchObject({
      eventName: 'book_demo',
      landingPageNormalized: '/demo',
      attributionScope: 'landing-page',
      eventCount: 2,
    })
    expect(ctx.db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, ctx.projectId)).get()).toMatchObject({
      acquisitionStatus: 'ready',
      acquisitionError: null,
      leadStatus: 'ready',
      leadError: null,
      leadAttributionScope: 'landing-page',
    })
  })

  it('uses the requested window after first success and treats an empty report as resolved zero', async () => {
    const ga = await mockLegacyGa()
    const acquisitionSpy = vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
      ...measurementRange(30), rows: [],
    })
    const leadsSpy = vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({
      ...measurementRange(30),
      attributionScope: 'landing-page',
      rows: [],
    })
    const now = new Date().toISOString()
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: now,
      leadStatus: 'ready',
      leadSyncedAt: now,
      leadAttributionScope: 'landing-page',
      updatedAt: now,
    }).run()
    ctx.db.insert(gaAcquisitionDaily).values([
      {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        date: dateDaysAgo(5),
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'example.com',
        landingPage: '/stale',
        sessions: 9,
        syncedAt: now,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        date: dateDaysAgo(60),
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'example.com',
        landingPage: '/outside-window',
        sessions: 3,
        syncedAt: now,
        createdAt: now,
      },
    ]).run()
    ctx.db.insert(gaLeadEventsDaily).values({
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      date: dateDaysAgo(5),
      eventName: 'generate_lead',
      channelGroup: 'Organic Search',
      source: 'google',
      medium: 'organic',
      hostName: 'example.com',
      landingPage: '/stale-lead',
      attributionScope: 'landing-page',
      eventCount: 1,
      syncedAt: now,
      createdAt: now,
    }).run()

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })

    expect(response.statusCode).toBe(200)
    expect(acquisitionSpy).toHaveBeenCalledWith('fake-token', '123456', 30)
    expect(leadsSpy).toHaveBeenCalledWith(
      'fake-token',
      '123456',
      ['generate_lead', 'book_demo'],
      30,
    )
    expect(JSON.parse(response.body)).toMatchObject({
      measurement: {
        acquisition: { days: 30, status: 'ready', rowCount: 0 },
        leads: { days: 30, status: 'ready', rowCount: 0, attributionScope: 'landing-page' },
      },
    })
    expect(ctx.db.select().from(gaAcquisitionDaily)
      .where(eq(gaAcquisitionDaily.projectId, ctx.projectId)).all()).toMatchObject([
      { landingPage: '/outside-window', sessions: 3 },
    ])
    expect(ctx.db.select().from(gaLeadEventsDaily)
      .where(eq(gaLeadEventsDaily.projectId, ctx.projectId)).all()).toEqual([])
    expect(ctx.db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, ctx.projectId)).get()).toMatchObject({
      acquisitionStatus: 'ready',
      acquisitionError: null,
      leadStatus: 'ready',
      leadError: null,
    })
  })

  it('preserves last-good acquisition data on component failure while successful lead and legacy syncs commit', async () => {
    const ga = await mockLegacyGa()
    vi.spyOn(ga, 'fetchAcquisitionByChannel').mockRejectedValue(new Error('acquisition quota exhausted'))
    vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({
      ...measurementRange(30),
      attributionScope: 'channel',
      rows: [{
        date: dateDaysAgo(1),
        eventName: 'generate_lead',
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: '(not available)',
        landingPage: '(not available)',
        eventCount: 2,
      }],
    })
    const lastGood = '2026-07-01T00:00:00.000Z'
    const now = new Date().toISOString()
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: lastGood,
      leadStatus: 'ready',
      leadSyncedAt: lastGood,
      leadAttributionScope: 'landing-page',
      updatedAt: now,
    }).run()
    ctx.db.insert(gaAcquisitionDaily).values({
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      date: dateDaysAgo(5),
      channelGroup: 'Organic Search',
      source: 'google',
      medium: 'organic',
      hostName: 'example.com',
      landingPage: '/last-good',
      sessions: 12,
      syncedAt: lastGood,
      createdAt: lastGood,
    }).run()

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      synced: true,
      measurement: {
        acquisition: { days: 30, status: 'error', rowCount: 0, error: 'acquisition quota exhausted' },
        leads: { days: 30, status: 'ready', rowCount: 1, attributionScope: 'channel' },
      },
    })
    expect(ctx.db.select().from(gaAcquisitionDaily)
      .where(eq(gaAcquisitionDaily.projectId, ctx.projectId)).all()).toMatchObject([
      { landingPage: '/last-good', sessions: 12 },
    ])
    expect(ctx.db.select().from(gaLeadEventsDaily)
      .where(eq(gaLeadEventsDaily.projectId, ctx.projectId)).get()).toMatchObject({
      attributionScope: 'channel',
      hostName: '(not available)',
      landingPage: '(not available)',
      landingPageNormalized: null,
      eventCount: 2,
    })
    expect(ctx.db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, ctx.projectId)).get()).toMatchObject({
      acquisitionStatus: 'error',
      acquisitionError: 'acquisition quota exhausted',
      acquisitionSyncedAt: lastGood,
      leadStatus: 'ready',
      leadError: null,
      leadAttributionScope: 'channel',
    })
    expect(ctx.db.select().from(runs).orderBy(runs.createdAt).all().at(-1)).toMatchObject({
      status: RunStatuses.completed,
    })
  })

  it('backfills each measurement component independently until that component succeeds', async () => {
    const ga = await mockLegacyGa()
    const acquisitionSpy = vi.spyOn(ga, 'fetchAcquisitionByChannel')
      .mockRejectedValueOnce(new Error('temporary acquisition failure'))
      .mockResolvedValueOnce({ ...measurementRange(90), rows: [] })
    const leadsSpy = vi.spyOn(ga, 'fetchLeadEvents')
      .mockResolvedValueOnce({
        ...measurementRange(90),
        attributionScope: 'landing-page',
        rows: [],
      })
      .mockResolvedValueOnce({
        ...measurementRange(30),
        attributionScope: 'landing-page',
        rows: [],
      })

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })
    expect(first.statusCode).toBe(200)

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })
    expect(second.statusCode).toBe(200)
    expect(acquisitionSpy.mock.calls.map(call => call[2])).toEqual([90, 90])
    expect(leadsSpy.mock.calls.map(call => call[3])).toEqual([90, 30])
    expect(JSON.parse(second.body)).toMatchObject({
      measurement: {
        acquisition: { days: 90, status: 'ready' },
        leads: { days: 30, status: 'ready' },
      },
    })
  })

  it('deletes only the exact date range returned by the GA4 acquisition report', async () => {
    const ga = await mockLegacyGa()
    vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
      startDate: dateDaysAgo(10),
      endDate: dateDaysAgo(3),
      rows: [],
    })
    vi.spyOn(ga, 'fetchLeadEvents').mockResolvedValue({
      ...measurementRange(30),
      attributionScope: 'landing-page',
      rows: [],
    })
    const now = new Date().toISOString()
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: now,
      leadStatus: 'ready',
      leadSyncedAt: now,
      leadAttributionScope: 'landing-page',
      updatedAt: now,
    }).run()
    for (const daysAgo of [11, 5, 2]) {
      ctx.db.insert(gaAcquisitionDaily).values({
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        date: dateDaysAgo(daysAgo),
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'example.com',
        landingPage: `/existing-${daysAgo}`,
        sessions: daysAgo,
        syncedAt: now,
        createdAt: now,
      }).run()
    }

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })
    expect(response.statusCode).toBe(200)
    expect(ctx.db.select().from(gaAcquisitionDaily)
      .where(eq(gaAcquisitionDaily.projectId, ctx.projectId)).all()
      .map(row => row.landingPage)
      .sort()).toEqual(['/existing-11', '/existing-2'])
  })

  it('clears stale lead evidence and resets lead sync state when lead events are disabled', async () => {
    const ga = await mockLegacyGa()
    vi.spyOn(ga, 'fetchAcquisitionByChannel').mockResolvedValue({
      ...measurementRange(30), rows: [],
    })
    const leadsSpy = vi.spyOn(ga, 'fetchLeadEvents')
    const now = new Date().toISOString()
    ctx.db.insert(gaLeadEventsDaily).values({
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      date: dateDaysAgo(2),
      eventName: 'generate_lead',
      channelGroup: 'Organic Search',
      source: 'google',
      medium: 'organic',
      hostName: 'example.com',
      landingPage: '/old-lead',
      attributionScope: 'landing-page',
      eventCount: 4,
      syncedAt: now,
      createdAt: now,
    }).run()
    ctx.db.insert(gaMeasurementSyncStates).values({
      projectId: ctx.projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: now,
      leadStatus: 'ready',
      leadSyncedAt: now,
      leadAttributionScope: 'landing-page',
      updatedAt: now,
    }).run()
    const update = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/measurement-ingestion',
      payload: {
        displayName: 'Measurement Ingestion',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        measurement: {
          marketingHosts: ['offers.example.com'],
          brandTerms: ['Example'],
          leadEventNames: [],
        },
      },
    })
    expect(update.statusCode).toBe(200)

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects/measurement-ingestion/ga/sync',
      payload: { days: 30 },
    })
    expect(response.statusCode).toBe(200)
    expect(leadsSpy).not.toHaveBeenCalled()
    expect(JSON.parse(response.body)).toMatchObject({
      measurement: {
        leads: { days: 0, status: 'not-configured', rowCount: 0 },
      },
    })
    expect(ctx.db.select().from(gaLeadEventsDaily)
      .where(eq(gaLeadEventsDaily.projectId, ctx.projectId)).all()).toEqual([])
    expect(ctx.db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, ctx.projectId)).get()).toMatchObject({
      leadStatus: 'never-synced',
      leadError: null,
      leadSyncedAt: null,
      leadAttributionScope: null,
    })
  })
})
