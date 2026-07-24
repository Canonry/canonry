import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  createClient,
  crawlerEventsHourly,
  gaAcquisitionDaily,
  gaAiReferrals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gaTrafficSnapshots,
  gscDailyTotals,
  gscQueryDailyTotals,
  gscSearchData,
  migrate,
  projects,
  runs,
  trafficSources,
} from '@ainyc/canonry-db'
import {
  organicEvidenceDtoSchema,
  type GaMeasurementAnalysisDto,
  type OrganicEvidenceDto,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-07-23T12:00:00.000Z'
const GA_ANCHOR = '2026-07-22'
const GSC_ANCHOR = '2026-07-20'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-organic-native-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

type Context = ReturnType<typeof buildApp> & {
  projectId: string
  runId: string
}

type NativeOrganicEvidence = OrganicEvidenceDto & {
  measurement: GaMeasurementAnalysisDto
}

function seedProject(base: ReturnType<typeof buildApp>, name = 'demand-iq') {
  const projectId = crypto.randomUUID()
  base.db.insert(projects).values({
    id: projectId,
    name,
    displayName: name === 'demand-iq' ? 'DemandIQ' : 'Legacy Only',
    canonicalDomain: name === 'demand-iq' ? 'demand-iq.com' : 'legacy.example',
    ownedDomains: name === 'demand-iq' ? ['demandiq.com'] : [],
    aliases: name === 'demand-iq' ? ['Demand IQ'] : [],
    country: 'US',
    language: 'en',
    measurement: {
      marketingHosts: name === 'demand-iq' ? ['offers.example.net'] : [],
      brandTerms: name === 'demand-iq' ? ['Demand Intelligence'] : [],
      leadEventNames: ['generate_lead'],
    },
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  const runId = crypto.randomUUID()
  base.db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'gsc-sync',
    status: 'completed',
    trigger: 'manual',
    createdAt: NOW,
    finishedAt: NOW,
  }).run()

  return { projectId, runId }
}

function insertAcquisition(
  ctx: Context,
  input: {
    date: string
    channelGroup: string
    hostName: string
    landingPage: string
    landingPageNormalized?: string | null
    sessions: number
  },
) {
  ctx.db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: input.date,
    channelGroup: input.channelGroup,
    source: input.channelGroup === 'Direct' ? '(direct)' : 'google',
    medium: input.channelGroup === 'Paid Search' ? 'cpc' : 'organic',
    hostName: input.hostName,
    landingPage: input.landingPage,
    landingPageNormalized: input.landingPageNormalized === undefined
      ? input.landingPage.split('?')[0]!
      : input.landingPageNormalized,
    sessions: input.sessions,
    syncedAt: NOW,
    createdAt: NOW,
  }).run()
}

function insertLead(
  ctx: Context,
  input: {
    date: string
    channelGroup: string
    eventCount: number
  },
) {
  ctx.db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: input.date,
    eventName: 'generate_lead',
    channelGroup: input.channelGroup,
    source: 'google',
    medium: input.channelGroup === 'Paid Search' ? 'cpc' : 'organic',
    hostName: 'demand-iq.com',
    landingPage: '/quote',
    landingPageNormalized: '/quote',
    attributionScope: 'landing-page',
    eventCount: input.eventCount,
    syncedAt: NOW,
    createdAt: NOW,
  }).run()
}

function insertGscProperty(
  ctx: Context,
  input: { date: string; clicks: number; impressions: number },
) {
  ctx.db.insert(gscDailyTotals).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: input.date,
    clicks: input.clicks,
    impressions: input.impressions,
    position: '5',
    createdAt: NOW,
  }).run()
}

function insertGscQuery(
  ctx: Context,
  input: { date: string; query: string; clicks: number; impressions: number },
) {
  ctx.db.insert(gscQueryDailyTotals).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: input.date,
    query: input.query,
    clicks: input.clicks,
    impressions: input.impressions,
    position: '5',
    syncedAt: NOW,
    syncRunId: ctx.runId,
    createdAt: NOW,
  }).run()
}

function insertGscPage(
  ctx: Context,
  input: { date: string; page: string; clicks: number; impressions: number },
) {
  ctx.db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    syncRunId: ctx.runId,
    date: input.date,
    query: 'solar sales software',
    page: input.page,
    clicks: input.clicks,
    impressions: input.impressions,
    ctr: input.impressions > 0 ? String(input.clicks / input.impressions) : '0',
    position: '8',
    createdAt: NOW,
  }).run()
}

function seedNativeMeasurement(ctx: Context) {
  insertAcquisition(ctx, {
    date: '2026-05-20',
    channelGroup: 'Organic Search',
    hostName: 'demand-iq.com',
    landingPage: '/blog/baseline',
    sessions: 10,
  })
  insertAcquisition(ctx, {
    date: '2026-01-01',
    channelGroup: 'Organic Search',
    hostName: 'demand-iq.com',
    landingPage: '/blog/ancient',
    sessions: 500,
  })
  insertAcquisition(ctx, {
    date: '2026-06-17',
    channelGroup: 'Organic Search',
    hostName: 'demandiq.com',
    landingPage: '/blog/old',
    sessions: 35,
  })
  insertAcquisition(ctx, {
    date: GA_ANCHOR,
    channelGroup: 'Organic Search',
    hostName: 'demand-iq.com',
    landingPage: '/blog/new',
    sessions: 16,
  })
  insertAcquisition(ctx, {
    date: GA_ANCHOR,
    channelGroup: 'Paid Search',
    hostName: 'demand-iq.com',
    landingPage: '/quote',
    sessions: 50,
  })
  insertAcquisition(ctx, {
    date: GA_ANCHOR,
    channelGroup: 'Paid Search',
    hostName: 'demand-iq.com',
    landingPage: '/blog/new',
    sessions: 9,
  })
  insertAcquisition(ctx, {
    date: GA_ANCHOR,
    channelGroup: 'Display',
    hostName: 'demand-iq.vercel.app',
    landingPage: '/preview',
    sessions: 999,
  })

  insertLead(ctx, {
    date: '2026-05-20',
    channelGroup: 'Organic Search',
    eventCount: 2,
  })
  insertLead(ctx, {
    date: '2026-06-17',
    channelGroup: 'Organic Search',
    eventCount: 4,
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

  // This intentionally conflicts with the native acquisition rows. The
  // reconciliation workflow must never mix the legacy synthetic GA snapshot
  // with native default-channel-group data once native ingestion is ready.
  ctx.db.insert(gaTrafficSnapshots).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    date: GSC_ANCHOR,
    landingPage: '/blog/legacy-decoy',
    landingPageNormalized: '/blog/legacy-decoy',
    sessions: 9_999,
    organicSessions: 9_999,
    users: 9_999,
    syncedAt: NOW,
  }).run()

  for (const row of [
    { date: '2026-05-20', clicks: 5, impressions: 400 },
    { date: '2026-06-20', clicks: 10, impressions: 500 },
    { date: GSC_ANCHOR, clicks: 211, impressions: 1_720 },
  ]) {
    insertGscProperty(ctx, row)
  }
  for (const row of [
    { date: '2026-05-20', query: 'demand iq', clicks: 3, impressions: 100 },
    { date: '2026-05-20', query: 'solar estimate software', clicks: 1, impressions: 200 },
    { date: '2026-06-20', query: 'demand iq platform', clicks: 6, impressions: 120 },
    { date: '2026-06-20', query: 'solar proposal tool', clicks: 4, impressions: 193 },
    { date: GSC_ANCHOR, query: 'demand-iq.com pricing', clicks: 8, impressions: 150 },
    { date: GSC_ANCHOR, query: 'solar sales software', clicks: 2, impressions: 350 },
    { date: GSC_ANCHOR, query: 'demand intelligence', clicks: 1, impressions: 20 },
  ]) {
    insertGscQuery(ctx, row)
  }
  // More than the public query-detail limit proves the compatibility totals
  // come from the full classified period aggregates, not the top-N rows.
  for (let index = 0; index < 100; index += 1) {
    insertGscQuery(ctx, {
      date: GSC_ANCHOR,
      query: `nonbrand long tail ${index}`,
      clicks: 2,
      impressions: 10,
    })
  }
  for (const row of [
    {
      date: '2026-05-20',
      page: 'https://demand-iq.com/blog/baseline',
      clicks: 2,
      impressions: 384,
    },
    {
      date: '2026-06-20',
      page: 'https://www.demand-iq.com/blog/old',
      clicks: 4,
      impressions: 313,
    },
    {
      date: GSC_ANCHOR,
      page: 'https://demand-iq.com/blog/new',
      clicks: 0,
      impressions: 495,
    },
    {
      date: GSC_ANCHOR,
      page: 'https://demand-iq.vercel.app/blog/preview',
      clicks: 100,
      impressions: 500,
    },
  ]) {
    insertGscPage(ctx, row)
  }
}

function seedServerAiEvidence(ctx: Context) {
  const sourceId = crypto.randomUUID()
  ctx.db.insert(trafficSources).values({
    id: sourceId,
    projectId: ctx.projectId,
    sourceType: 'cloud-run',
    displayName: 'Marketing website',
    status: 'connected',
    lastSyncedAt: NOW,
    lastCursor: null,
    lastError: null,
    lastEventIds: null,
    archivedAt: null,
    configJson: {},
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  ctx.db.insert(crawlerEventsHourly).values({
    projectId: ctx.projectId,
    sourceId,
    tsHour: '2026-07-20T12:00:00.000Z',
    botId: 'gptbot',
    operator: 'OpenAI',
    verificationStatus: 'verified',
    pathNormalized: '/blog/new',
    status: 200,
    hits: 7,
    sampledUserAgent: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  ctx.db.insert(aiUserFetchEventsHourly).values({
    projectId: ctx.projectId,
    sourceId,
    tsHour: '2026-07-20T13:00:00.000Z',
    botId: 'chatgpt-user',
    operator: 'OpenAI',
    verificationStatus: 'verified',
    pathNormalized: '/blog/new',
    status: 200,
    hits: 5,
    sampledUserAgent: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  ctx.db.insert(aiReferralEventsHourly).values({
    projectId: ctx.projectId,
    sourceId,
    tsHour: '2026-07-20T14:00:00.000Z',
    product: 'ChatGPT',
    operator: 'OpenAI',
    sourceDomain: 'chatgpt.com',
    evidenceType: 'utm',
    landingPathNormalized: '/blog/new',
    status: 200,
    sessionsOrHits: 3,
    paidSessionsOrHits: 0,
    organicSessionsOrHits: 3,
    usersEstimated: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return sourceId
}

async function getRawEvidence(
  ctx: Context,
  projectName = 'demand-iq',
): Promise<NativeOrganicEvidence> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectName}/organic-evidence?period=90`,
  })
  expect(response.statusCode).toBe(200)
  return JSON.parse(response.body) as NativeOrganicEvidence
}

interface CapturedStatement {
  sql: string
  params: unknown[]
}

function captureStatements(sqlite: import('better-sqlite3').Database): {
  captured: CapturedStatement[]
  stop: () => void
} {
  const captured: CapturedStatement[] = []
  const originalPrepare = sqlite.prepare.bind(sqlite)

  sqlite.prepare = ((source: string) => {
    const statement = originalPrepare(source)
    const proxy: unknown = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (property === 'all' || property === 'get' || property === 'iterate') {
            captured.push({ sql: source, params: args })
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          return result === target ? proxy : result
        }
      },
    })
    return proxy
  }) as typeof sqlite.prepare

  return {
    captured,
    stop: () => { sqlite.prepare = originalPrepare as typeof sqlite.prepare },
  }
}

describe('organic evidence native measurement reconciliation', () => {
  let ctx: Context

  beforeEach(async () => {
    const base = buildApp()
    const ids = seedProject(base)
    ctx = { ...base, ...ids }
    await ctx.app.ready()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('makes native measurement authoritative without synthesizing an Other channel', async () => {
    seedNativeMeasurement(ctx)

    const raw = await getRawEvidence(ctx)
    const body = organicEvidenceDtoSchema.parse(raw) as NativeOrganicEvidence

    // Parsing through the public contract must retain the agent-consumable
    // native payload, rather than treating it as an untyped route-only field.
    expect(body.measurement).toEqual(raw.measurement)
    expect(body).not.toHaveProperty('cohorts')
    expect(body).not.toHaveProperty('blog')
    expect(body.measurement.window).toBe('90d')
    expect(body.measurement.acquisition.channels.map(row => row.channelGroup)).toEqual([
      'Paid Search',
      'Organic Search',
    ])
    expect(body.measurement.acquisition.channels.map(row => row.channelGroup)).not.toContain('Other')
    expect(body.ga4).toMatchObject({
      organicSessions: 61,
    })
    expect(body.ga4).not.toHaveProperty('blogOrganicSessions')
    expect(body.ga4?.cohorts.map(row => row.organicSessions)).toEqual([10, 35, 16])
    expect(body.ga4?.cohorts.at(-1)?.endDate).toBe(GA_ANCHOR)
    expect(body.gsc?.cohorts.at(-1)?.endDate).toBe(GSC_ANCHOR)
    expect(body.sourceCoverage.ga4).toMatchObject({
      startDate: '2026-01-01',
      endDate: GA_ANCHOR,
      observedDays: 4,
    })
    expect(body.gsc).toMatchObject({
      namedBrand: { clicks: 18, impressions: 390 },
      namedNonBrand: { clicks: 207, impressions: 1_743 },
      suppressedOrUnreportedResidual: { clicks: 1, impressions: 487 },
    })
    expect(body.pages.map(row => row.path)).not.toContain('/blog/legacy-decoy')
    expect(body.pages.map(row => row.path)).not.toContain('/blog/preview')
    expect(body.pages.map(row => row.path)).not.toContain('/blog/ancient')
    expect(body.pages).toContainEqual(expect.objectContaining({
      path: '/blog/new',
      ga4OrganicSessions: 16,
    }))
    expect(body.measurement.leads.periods.map(row => row.eventCount)).toEqual([2, 4, 0])
    expect(body.limitations.map(row => row.code)).not.toContain('no-lead-attribution')
    expect(body.limitations).toContainEqual(expect.objectContaining({
      code: 'lead-attribution-not-causal',
    }))
    expect(body.limitations).toContainEqual(expect.objectContaining({
      code: 'source-specific-cohort-anchors',
    }))
  })

  it('turns visibility, traffic, lead, and paid-assisted clues into bounded findings', async () => {
    seedNativeMeasurement(ctx)
    ctx.db.delete(gscDailyTotals).run()
    insertGscProperty(ctx, { date: '2026-06-20', clicks: 10, impressions: 500 })
    insertGscProperty(ctx, { date: GSC_ANCHOR, clicks: 8, impressions: 700 })

    const body = await getRawEvidence(ctx)

    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'positive',
      title: 'Search visibility increased',
      detail: expect.stringContaining('700 in the latest cohort versus 500 prior'),
    }))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'caution',
      title: 'Search clicks have not followed visibility yet',
      detail: expect.stringContaining('8 Google clicks in the latest cohort versus 10 prior'),
    }))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'neutral',
      title: 'Lead trend is measured, not causal',
      detail: expect.stringMatching(/0 in the latest cohort versus 4 prior/i),
    }))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'neutral',
      title: 'Paid-assisted brand search remains plausible',
      detail: expect.stringMatching(/59 Paid Search sessions.*2026-06-23 to 2026-07-22.*9 branded clicks.*2026-06-21 to 2026-07-20.*not proof/i),
    }))
    expect(body.findings.find(row => row.title === 'Paid-assisted brand search remains plausible')?.detail)
      .not.toMatch(/coincide/i)
  })

  it.each([
    { label: 'unchanged at zero', priorImpressions: 0, latestImpressions: 0 },
    { label: 'declining', priorImpressions: 100, latestImpressions: 50 },
  ])('does not claim clicks lagged visibility when sitewide impressions are $label', async ({
    priorImpressions,
    latestImpressions,
  }) => {
    seedNativeMeasurement(ctx)
    ctx.db.delete(gscDailyTotals).run()
    if (priorImpressions > 0) {
      insertGscProperty(ctx, {
        date: '2026-06-20',
        clicks: 4,
        impressions: priorImpressions,
      })
    }
    if (latestImpressions > 0) {
      insertGscProperty(ctx, {
        date: GSC_ANCHOR,
        clicks: 0,
        impressions: latestImpressions,
      })
    }

    const body = await getRawEvidence(ctx)

    expect(body.findings.map(row => row.title)).not.toContain('Search visibility increased')
    expect(body.findings.map(row => row.title)).not.toContain(
      'Search clicks have not followed visibility yet',
    )
  })

  it('keeps unknown GA landings separate from the real homepage', async () => {
    seedNativeMeasurement(ctx)
    insertAcquisition(ctx, {
      date: GA_ANCHOR,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '/',
      landingPageNormalized: '/',
      sessions: 3,
    })
    insertAcquisition(ctx, {
      date: GA_ANCHOR,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '(not set)',
      landingPageNormalized: null,
      sessions: 5,
    })
    insertAcquisition(ctx, {
      date: GA_ANCHOR,
      channelGroup: 'Organic Search',
      hostName: 'demand-iq.com',
      landingPage: '',
      landingPageNormalized: '',
      sessions: 7,
    })

    const body = await getRawEvidence(ctx)

    expect(body.pages).toContainEqual(expect.objectContaining({
      path: '/',
      ga4OrganicSessions: 3,
    }))
    expect(body.pages).toContainEqual(expect.objectContaining({
      path: '(not set)',
      ga4OrganicSessions: 12,
    }))
    expect(body.measurement.acquisition.pages).toContainEqual(expect.objectContaining({
      landingPage: '/',
      periods: expect.arrayContaining([expect.objectContaining({ sessions: 3 })]),
    }))
    expect(body.measurement.acquisition.pages).toContainEqual(expect.objectContaining({
      landingPage: '(not set)',
      periods: expect.arrayContaining([expect.objectContaining({ sessions: 12 })]),
    }))
  })

  it('keeps server verification and referral classification tiers disjoint', async () => {
    seedNativeMeasurement(ctx)
    const sourceId = seedServerAiEvidence(ctx)
    for (const [verificationStatus, hits] of [
      ['claimed_unverified', 4],
      ['unknown_ai_like', 2],
    ] as const) {
      ctx.db.insert(crawlerEventsHourly).values({
        projectId: ctx.projectId,
        sourceId,
        tsHour: '2026-07-20T15:00:00.000Z',
        botId: `crawler-${verificationStatus}`,
        operator: 'Unknown',
        verificationStatus,
        pathNormalized: '/blog/new',
        status: 200,
        hits,
        sampledUserAgent: null,
        createdAt: NOW,
        updatedAt: NOW,
      }).run()
      ctx.db.insert(aiUserFetchEventsHourly).values({
        projectId: ctx.projectId,
        sourceId,
        tsHour: '2026-07-20T16:00:00.000Z',
        botId: `fetch-${verificationStatus}`,
        operator: 'Unknown',
        verificationStatus,
        pathNormalized: '/blog/new',
        status: 200,
        hits: hits + 1,
        sampledUserAgent: null,
        createdAt: NOW,
        updatedAt: NOW,
      }).run()
    }
    ctx.db.insert(aiReferralEventsHourly).values({
      projectId: ctx.projectId,
      sourceId,
      tsHour: '2026-07-20T17:00:00.000Z',
      product: 'AI surface',
      operator: 'Unknown',
      sourceDomain: 'ai.example',
      evidenceType: 'referer',
      landingPathNormalized: '/blog/new',
      status: 200,
      sessionsOrHits: 10,
      paidSessionsOrHits: 2,
      organicSessionsOrHits: 3,
      usersEstimated: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run()

    const body = await getRawEvidence(ctx)

    expect(body.server).toEqual({
      crawlerHits: { verified: 7, claimedUnverified: 4, unknownAiLike: 2 },
      userFetchHits: { verified: 5, claimedUnverified: 5, unknownAiLike: 3 },
      referralSessions: { total: 13, paid: 2, organic: 6, unknown: 5 },
    })
  })

  it('signals page-detail truncation in the machine-readable limitations', async () => {
    seedNativeMeasurement(ctx)
    for (let index = 0; index < 55; index += 1) {
      insertAcquisition(ctx, {
        date: GA_ANCHOR,
        channelGroup: 'Organic Search',
        hostName: 'demand-iq.com',
        landingPage: `/library/page-${index}`,
        sessions: 1,
      })
    }

    const body = await getRawEvidence(ctx)

    expect(body.pages).toHaveLength(50)
    expect(body.limitations).toContainEqual(expect.objectContaining({
      code: 'page-detail-truncated',
      detail: expect.stringMatching(/top 50 of \d+ matching pages/i),
    }))
  })

  it('preserves last-good data, component errors, attribution scope, and server AI evidence', async () => {
    seedNativeMeasurement(ctx)
    seedServerAiEvidence(ctx)
    ctx.db.update(gaMeasurementSyncStates).set({
      acquisitionStatus: 'error',
      acquisitionError: 'quota exhausted',
      leadAttributionScope: 'channel',
      updatedAt: NOW,
    }).run()

    const body = await getRawEvidence(ctx)

    expect(body.measurement).toMatchObject({
      acquisition: {
        status: 'error',
        error: 'quota exhausted',
        periods: expect.arrayContaining([expect.objectContaining({ sessions: 75 })]),
      },
      leads: {
        status: 'ready',
        attributionScope: 'channel',
        hostAndPathFiltersApplied: false,
      },
    })
    expect(body.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'acquisition-sync-error' }),
      expect.objectContaining({ code: 'lead-channel-scope' }),
    ]))
    expect(body.pages).toContainEqual(expect.objectContaining({
      path: '/blog/new',
      server: expect.objectContaining({
        crawlerHits: expect.objectContaining({ verified: 7 }),
        userFetchHits: expect.objectContaining({ verified: 5 }),
        referralSessions: { total: 3, paid: 0, organic: 3, unknown: 0 },
      }),
    }))
  })

  it('uses legacy GA only as an explicit fallback and never disguises missing leads', async () => {
    const legacy = seedProject(ctx, 'legacy-only')
    ctx.db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId: legacy.projectId,
      date: GSC_ANCHOR,
      landingPage: '/blog/legacy',
      landingPageNormalized: '/blog/legacy',
      sessions: 11,
      organicSessions: 11,
      users: 10,
      syncedAt: NOW,
    }).run()

    const body = await getRawEvidence(
      { ...ctx, projectId: legacy.projectId, runId: legacy.runId },
      'legacy-only',
    )

    expect(body.measurement.acquisition.status).toBe('never-synced')
    expect(body.ga4).toMatchObject({
      organicSessions: 11,
    })
    expect(body.ga4).not.toHaveProperty('blogOrganicSessions')
    expect(body.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'legacy-ga-fallback' }),
      expect.objectContaining({ code: 'lead-data-unavailable' }),
    ]))
  })

  it('does not revive legacy snapshots when a ready native acquisition sync has zero rows', async () => {
    seedNativeMeasurement(ctx)
    ctx.db.delete(gaAcquisitionDaily).run()
    ctx.db.delete(gaLeadEventsDaily).run()

    const body = await getRawEvidence(ctx)

    expect(body.measurement.acquisition.status).toBe('ready')
    expect(body.ga4).toBeNull()
    expect(body.pages.map(row => row.path)).not.toContain('/blog/legacy-decoy')
    expect(body.limitations.map(row => row.code)).not.toContain('legacy-ga-fallback')
  })

  it('keeps native GA coverage and source-specific cohorts visible without legacy snapshots', async () => {
    seedNativeMeasurement(ctx)
    ctx.db.delete(gaTrafficSnapshots).run()

    const body = await getRawEvidence(ctx)

    expect(body.coverage.ga4).toBe(true)
    expect(body.sourceCoverage.ga4).toMatchObject({
      startDate: '2026-01-01',
      endDate: GA_ANCHOR,
      observedDays: 4,
    })
    expect(body.ga4?.organicSessions).toBe(61)
    expect(body.ga4?.cohorts.map(row => row.organicSessions)).toEqual([10, 35, 16])
  })

  it('aligns GA AI referral totals with the native GA cohort window, not the GSC date', async () => {
    seedNativeMeasurement(ctx)
    ctx.db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      date: '2026-07-21',
      source: 'chatgpt.com',
      medium: 'referral',
      trafficClass: 'organic',
      sourceDimension: 'session',
      channelGroup: 'Referral',
      landingPage: '/answer-library/new-guide',
      landingPageNormalized: '/answer-library/new-guide',
      sessions: 5,
      users: 5,
      syncedAt: NOW,
    }).run()

    const body = await getRawEvidence(ctx)

    expect(body.gsc?.cohorts.at(-1)?.endDate).toBe(GSC_ANCHOR)
    expect(body.ga4?.cohorts.at(-1)?.endDate).toBe(GA_ANCHOR)
    expect(body.gaAiReferrals).toEqual({
      paidSessions: 0,
      organicSessions: 5,
    })
  })
  it('bounds every high-volume detail read while source coverage stays aggregate-only', async () => {
    seedNativeMeasurement(ctx)
    seedServerAiEvidence(ctx)

    const capture = captureStatements(ctx.db.$client)
    try {
      await getRawEvidence(ctx)
    } finally {
      capture.stop()
    }

    const highVolumeTables = [
      'gsc_daily_totals',
      'gsc_query_daily_totals',
      'gsc_search_data',
      'ga_traffic_snapshots',
      'ga_acquisition_daily',
      'ga_ai_referrals',
      'crawler_events_hourly',
      'ai_user_fetch_events_hourly',
      'ai_referral_events_hourly',
    ]

    for (const table of highVolumeTables) {
      const reads = capture.captured.filter(statement =>
        new RegExp(`\\bfrom\\s+"?${table}"?`, 'i').test(statement.sql))
      expect(reads.length, `expected ${table} to be read`).toBeGreaterThan(0)

      for (const statement of reads) {
        const sql = statement.sql.toLowerCase()
        const aggregateOnly = /\b(?:min|max|count)\s*\(/.test(sql)
        const dateColumn = table.endsWith('_hourly') ? 'ts_hour' : 'date'
        const lowerBound = new RegExp(`"${dateColumn}"\\s*>=\\s*\\?`).test(sql)
        const upperBound = new RegExp(`"${dateColumn}"\\s*<=\\s*\\?`).test(sql)

        expect(
          aggregateOnly || (lowerBound && upperBound),
          `unbounded detail read from ${table}: ${statement.sql}`,
        ).toBe(true)
      }
    }
  })
})
