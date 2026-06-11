import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq, and, asc, gte, lte } from 'drizzle-orm'
import {
  adsConnectRequestSchema,
  adsInsightLevelSchema,
  adsCtr,
  adsCpcMicros,
  validationError,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import type {
  AdsAdDto,
  AdsAdGroupDto,
  AdsCampaignDto,
  AdsCampaignListResponse,
  AdsConnectionStatusDto,
  AdsCreativeDto,
  AdsDisconnectResponse,
  AdsInsightLevel,
  AdsInsightRowDto,
  AdsInsightsResponse,
  AdsSummaryDto,
  AdsSyncResponse,
} from '@ainyc/canonry-contracts'
import { adsConnections, adsCampaigns, adsAdGroups, adsAds, adsInsightsDaily, runs } from '@ainyc/canonry-db'
import { resolveProject, writeAuditLog, auditFromRequest } from './helpers.js'

export interface AdsConnectionConfigEntryLike {
  projectName: string
  apiKey: string
  adAccountId?: string | null
  createdAt: string
  updatedAt: string
}

/** Wraps the openaiAds block of ~/.canonry/config.yaml (the key never touches the DB). */
export interface AdsCredentialStore {
  getConnection(projectName: string): AdsConnectionConfigEntryLike | undefined
  upsertConnection(entry: AdsConnectionConfigEntryLike): unknown
  removeConnection(projectName: string): boolean
}

export interface VerifiedAdsAccount {
  id: string
  name: string
  status: string
  currencyCode: string | null
  timezone: string | null
}

export interface AdsRoutesOptions {
  adsCredentialStore?: AdsCredentialStore
  /** Validates an SDK key against the upstream ad account (host wires this to the integration client). */
  verifyAdsAccount?: (apiKey: string) => Promise<VerifiedAdsAccount>
  /** Fired after a manual sync run row is created; host runs the ads-sync worker. */
  onAdsSyncRequested?: (runId: string, projectId: string) => void
}

type ConnectionRow = typeof adsConnections.$inferSelect

function statusDto(row: ConnectionRow | undefined): AdsConnectionStatusDto {
  if (!row) return { connected: false }
  return {
    connected: true,
    adAccountId: row.adAccountId,
    displayName: row.displayName,
    currencyCode: row.currencyCode,
    timezone: row.timezone,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
  }
}

function creativeDto(raw: unknown): AdsCreativeDto | null {
  if (raw == null || typeof raw !== 'object') return null
  const c = raw as { type?: unknown; title?: unknown; body?: unknown; target_url?: unknown }
  return {
    type: typeof c.type === 'string' ? c.type : null,
    title: typeof c.title === 'string' ? c.title : null,
    body: typeof c.body === 'string' ? c.body : null,
    targetUrl: typeof c.target_url === 'string' ? c.target_url : null,
  }
}

export async function adsRoutes(app: FastifyInstance, opts: AdsRoutesOptions): Promise<void> {
  app.post<{ Params: { name: string }; Body: { apiKey?: string } }>(
    '/projects/:name/ads/connect',
    async (request) => {
      const project = resolveProject(app.db, request.params.name)
      const parsed = adsConnectRequestSchema.safeParse(request.body ?? {})
      if (!parsed.success) throw validationError('"apiKey" is required')
      if (!opts.adsCredentialStore || !opts.verifyAdsAccount) {
        throw validationError('Ads credential storage is not configured for this deployment')
      }

      // Validate the key against the upstream ad account BEFORE any write —
      // a key that cannot read its own account would only fail later, at
      // sync time, with a worse error.
      let account: VerifiedAdsAccount
      try {
        account = await opts.verifyAdsAccount(parsed.data.apiKey)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw validationError(`OpenAI Ads API rejected the key: ${message}`)
      }

      const now = new Date().toISOString()
      const existingCfg = opts.adsCredentialStore.getConnection(project.name)
      opts.adsCredentialStore.upsertConnection({
        projectName: project.name,
        apiKey: parsed.data.apiKey,
        adAccountId: account.id,
        createdAt: existingCfg?.createdAt ?? now,
        updatedAt: now,
      })

      const existingRow = app.db.select().from(adsConnections)
        .where(eq(adsConnections.projectId, project.id)).get()
      app.db.transaction((tx) => {
        if (existingRow) {
          tx.update(adsConnections).set({
            adAccountId: account.id,
            displayName: account.name,
            currencyCode: account.currencyCode,
            timezone: account.timezone,
            status: account.status,
            updatedAt: now,
          }).where(eq(adsConnections.id, existingRow.id)).run()
        } else {
          tx.insert(adsConnections).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            adAccountId: account.id,
            displayName: account.name,
            currencyCode: account.currencyCode,
            timezone: account.timezone,
            status: account.status,
            createdAt: now,
            updatedAt: now,
          }).run()
        }
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'ads.connected',
          entityType: 'ads-connection',
          entityId: account.id,
        }))
      })

      const row = app.db.select().from(adsConnections)
        .where(eq(adsConnections.projectId, project.id)).get()
      return statusDto(row)
    },
  )

  app.delete<{ Params: { name: string } }>('/projects/:name/ads/connection', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()

    if (row) {
      app.db.transaction((tx) => {
        tx.delete(adsConnections).where(eq(adsConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'ads.disconnected',
          entityType: 'ads-connection',
          entityId: row.adAccountId,
        }))
      })
    }
    const removedFromConfig = opts.adsCredentialStore?.removeConnection(project.name) ?? false

    const response: AdsDisconnectResponse = { disconnected: Boolean(row) || removedFromConfig }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    return statusDto(row)
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/sync', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    if (!row) {
      throw validationError('No ads connection for this project. Run "canonry ads connect" first.')
    }

    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['ads-sync'],
      status: RunStatuses.queued,
      trigger: RunTriggers.manual,
      createdAt: new Date().toISOString(),
    }).run()

    opts.onAdsSyncRequested?.(runId, project.id)

    const response: AdsSyncResponse = { runId, status: RunStatuses.queued }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/campaigns', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const campaignRows = app.db.select().from(adsCampaigns)
      .where(eq(adsCampaigns.projectId, project.id)).all()
    const groupRows = app.db.select().from(adsAdGroups)
      .where(eq(adsAdGroups.projectId, project.id)).all()
    const adRows = app.db.select().from(adsAds)
      .where(eq(adsAds.projectId, project.id)).all()

    const adsByGroup = new Map<string, AdsAdDto[]>()
    for (const ad of adRows) {
      const dto: AdsAdDto = {
        id: ad.id,
        adGroupId: ad.adGroupId,
        name: ad.name,
        status: ad.status,
        reviewStatus: ad.reviewStatus,
        creative: creativeDto(ad.creative),
      }
      const list = adsByGroup.get(ad.adGroupId) ?? []
      list.push(dto)
      adsByGroup.set(ad.adGroupId, list)
    }

    const groupsByCampaign = new Map<string, AdsAdGroupDto[]>()
    for (const group of groupRows) {
      const dto: AdsAdGroupDto = {
        id: group.id,
        campaignId: group.campaignId,
        name: group.name,
        status: group.status,
        billingEventType: group.billingEventType,
        maxBidMicros: group.maxBidMicros,
        contextHints: group.contextHints,
        ads: adsByGroup.get(group.id) ?? [],
      }
      const list = groupsByCampaign.get(group.campaignId) ?? []
      list.push(dto)
      groupsByCampaign.set(group.campaignId, list)
    }

    const campaigns: AdsCampaignDto[] = campaignRows.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      biddingType: campaign.biddingType,
      dailySpendLimitMicros: campaign.dailySpendLimitMicros,
      lifetimeSpendLimitMicros: campaign.lifetimeSpendLimitMicros,
      adGroups: groupsByCampaign.get(campaign.id) ?? [],
    }))

    const response: AdsCampaignListResponse = { campaigns }
    return response
  })

  app.get<{
    Params: { name: string }
    Querystring: { level?: string; entityId?: string; from?: string; to?: string }
  }>('/projects/:name/ads/insights', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { level, entityId, from, to } = request.query

    let parsedLevel: AdsInsightLevel | undefined
    if (level !== undefined) {
      const result = adsInsightLevelSchema.safeParse(level)
      if (!result.success) {
        throw validationError('"level" must be one of: account, campaign, ad_group, ad')
      }
      parsedLevel = result.data
    }

    const conditions = [eq(adsInsightsDaily.projectId, project.id)]
    if (parsedLevel) conditions.push(eq(adsInsightsDaily.level, parsedLevel))
    if (entityId) conditions.push(eq(adsInsightsDaily.entityId, entityId))
    if (from) conditions.push(gte(adsInsightsDaily.date, from))
    if (to) conditions.push(lte(adsInsightsDaily.date, to))

    const rows = app.db.select().from(adsInsightsDaily)
      .where(and(...conditions))
      .orderBy(asc(adsInsightsDaily.date))
      .all()

    const dtoRows: AdsInsightRowDto[] = rows.map((row) => ({
      level: row.level as AdsInsightLevel,
      entityId: row.entityId,
      date: row.date,
      impressions: row.impressions,
      clicks: row.clicks,
      spendMicros: row.spendMicros,
      ctr: adsCtr(row.clicks, row.impressions),
      cpcMicros: adsCpcMicros(row.spendMicros, row.clicks),
    }))

    const response: AdsInsightsResponse = { rows: dtoRows }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/summary', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()

    const campaignCount = app.db.select().from(adsCampaigns)
      .where(eq(adsCampaigns.projectId, project.id)).all().length
    const adGroupCount = app.db.select().from(adsAdGroups)
      .where(eq(adsAdGroups.projectId, project.id)).all().length
    const adCount = app.db.select().from(adsAds)
      .where(eq(adsAds.projectId, project.id)).all().length

    // Totals use CAMPAIGN-level rollups only — summing across levels would
    // double-count (ad-group rows are subdivisions of campaign rows).
    const campaignInsights = app.db.select().from(adsInsightsDaily)
      .where(and(
        eq(adsInsightsDaily.projectId, project.id),
        eq(adsInsightsDaily.level, 'campaign'),
      ))
      .all()

    let impressions = 0
    let clicks = 0
    let spendMicros = 0
    let fromDate: string | null = null
    let toDate: string | null = null
    for (const insight of campaignInsights) {
      impressions += insight.impressions
      clicks += insight.clicks
      spendMicros += insight.spendMicros
      if (fromDate === null || insight.date < fromDate) fromDate = insight.date
      if (toDate === null || insight.date > toDate) toDate = insight.date
    }

    const response: AdsSummaryDto = {
      connected: Boolean(row),
      displayName: row?.displayName ?? null,
      currencyCode: row?.currencyCode ?? null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      campaignCount,
      adGroupCount,
      adCount,
      window: { from: fromDate, to: toDate },
      totals: {
        impressions,
        clicks,
        spendMicros,
        ctr: adsCtr(clicks, impressions),
        cpcMicros: adsCpcMicros(spendMicros, clicks),
      },
    }
    return response
  })
}
