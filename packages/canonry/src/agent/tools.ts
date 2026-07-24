import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type {
  AdsCampaignListResponse,
  AdsInsightsResponse,
  ProjectOverviewDto,
} from '@ainyc/canonry-contracts'
import type { ApiClient } from '../client.js'
import {
  CanonryMcpToolNames,
  canonryMcpTools,
  type CanonryMcpToolName,
} from '../mcp/tool-registry.js'
import { buildMcpAgentTools, truncateToolResult } from './mcp-to-agent-tool.js'

/**
 * Context Aero tools close over so the LLM can never target a different
 * project. The MCP-to-agent adapter strips `project` from each tool's
 * visible schema and injects `projectName` at call time.
 */
export interface ToolContext {
  client: ApiClient
  projectName: string
}

export const AeroToolScopes = Object.freeze({
  all: 'all',
  readOnly: 'read-only',
} as const)

export const AERO_TOOL_SCOPES = [
  AeroToolScopes.all,
  AeroToolScopes.readOnly,
] as const
export type AeroToolScope = typeof AERO_TOOL_SCOPES[number]

export const AeroToolProfiles = Object.freeze({
  default: 'default',
  adsOperator: 'ads-operator',
} as const)

export const AERO_TOOL_PROFILES = [
  AeroToolProfiles.default,
  AeroToolProfiles.adsOperator,
] as const
export type AeroToolProfile = typeof AERO_TOOL_PROFILES[number]

export function isAeroToolProfile(value: string | undefined): value is AeroToolProfile {
  return value !== undefined && (AERO_TOOL_PROFILES as readonly string[]).includes(value)
}

export const AeroAgentToolNames = Object.freeze({
  adsOperatorContext: 'canonry_ads_operator_context',
} as const)
export type AeroAgentToolName = typeof AeroAgentToolNames[keyof typeof AeroAgentToolNames]

export const AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME: AeroAgentToolName = AeroAgentToolNames.adsOperatorContext

export const AERO_ADS_OPERATOR_MCP_TOOL_NAMES: ReadonlySet<CanonryMcpToolName> = new Set([
  CanonryMcpToolNames.canonry_project_get,
  CanonryMcpToolNames.canonry_project_overview,
  CanonryMcpToolNames.canonry_search,
  CanonryMcpToolNames.canonry_doctor,
  CanonryMcpToolNames.canonry_analytics_metrics,
  CanonryMcpToolNames.canonry_analytics_sources,
  CanonryMcpToolNames.canonry_runs_list,
  CanonryMcpToolNames.canonry_runs_latest,
  CanonryMcpToolNames.canonry_run_get,
  CanonryMcpToolNames.canonry_insights_list,
  CanonryMcpToolNames.canonry_insight_get,
  CanonryMcpToolNames.canonry_health_latest,
  CanonryMcpToolNames.canonry_queries_list,
  CanonryMcpToolNames.canonry_competitors_list,
  CanonryMcpToolNames.canonry_schedule_get,
  CanonryMcpToolNames.canonry_memory_list,
  CanonryMcpToolNames.canonry_memory_set,
  CanonryMcpToolNames.canonry_memory_forget,
  CanonryMcpToolNames.canonry_run_trigger,
  CanonryMcpToolNames.canonry_ads_status,
  CanonryMcpToolNames.canonry_ads_account,
  CanonryMcpToolNames.canonry_ads_geo_search,
  CanonryMcpToolNames.canonry_ads_conversion_pixels,
  CanonryMcpToolNames.canonry_ads_conversion_event_settings,
  CanonryMcpToolNames.canonry_ads_campaigns,
  CanonryMcpToolNames.canonry_ads_insights,
  CanonryMcpToolNames.canonry_ads_summary,
  CanonryMcpToolNames.canonry_ads_delivery_diagnostics,
  CanonryMcpToolNames.canonry_ads_operations_unresolved,
  CanonryMcpToolNames.canonry_ads_operation_get,
  CanonryMcpToolNames.canonry_ads_operation_reconcile,
  CanonryMcpToolNames.canonry_ads_operation_resume_activation,
  CanonryMcpToolNames.canonry_ads_image_upload,
  CanonryMcpToolNames.canonry_ads_campaign_create,
  CanonryMcpToolNames.canonry_ads_campaign_update,
  CanonryMcpToolNames.canonry_ads_campaign_pause,
  CanonryMcpToolNames.canonry_ads_campaign_activate_tree,
  CanonryMcpToolNames.canonry_ads_ad_group_create,
  CanonryMcpToolNames.canonry_ads_ad_group_update,
  CanonryMcpToolNames.canonry_ads_ad_group_pause,
  CanonryMcpToolNames.canonry_ads_ad_create,
  CanonryMcpToolNames.canonry_ads_ad_update,
  CanonryMcpToolNames.canonry_ads_ad_pause,
  CanonryMcpToolNames.canonry_ads_sync,
])

interface ToolBuildOptions {
  scope?: AeroToolScope
  profile?: AeroToolProfile
}

interface ContextSection<T> {
  status: 'ok' | 'error'
  data?: T
  error?: string
}

interface AdsOperatorContextParams {
  /** Lookback window for paid rollup rows. Default 30d. */
  windowDays?: number
  /** Max campaign snapshots to include. Default 8. */
  campaignLimit?: number
  /** Max paid rollup rows to include per level. Default 40. */
  insightRowLimit?: number
}

function toolResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: truncateToolResult(details) }],
    details,
  }
}

async function readSection<T>(fn: () => Promise<T>): Promise<ContextSection<T>> {
  try {
    return { status: 'ok', data: await fn() }
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function isoDateDaysAgo(days: number): string {
  const d = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function compactOverview(overview: Partial<ProjectOverviewDto>) {
  return {
    project: overview.project,
    contextLabel: overview.contextLabel,
    dateRangeLabel: overview.dateRangeLabel,
    latestRun: overview.latestRun,
    health: overview.health,
    scores: overview.scores,
    queryCounts: overview.queryCounts,
    providers: overview.providers,
    citationMovement: overview.citationMovement,
    mentionMovement: overview.mentionMovement,
    movementComparison: overview.movementComparison,
    topInsights: overview.topInsights?.slice(0, 5) ?? [],
    attentionItems: overview.attentionItems?.slice(0, 8) ?? [],
    competitors: overview.competitors?.slice(0, 12) ?? [],
  }
}

function compactCampaigns(response: AdsCampaignListResponse, limit: number) {
  return {
    campaignCount: response.campaigns.length,
    campaigns: response.campaigns.slice(0, limit).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      biddingType: campaign.biddingType,
      dailySpendLimitMicros: campaign.dailySpendLimitMicros,
      lifetimeSpendLimitMicros: campaign.lifetimeSpendLimitMicros,
      adGroupCount: campaign.adGroups.length,
      adGroups: campaign.adGroups.slice(0, 8).map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        status: group.status,
        billingEventType: group.billingEventType,
        maxBidMicros: group.maxBidMicros,
        contextHintCount: group.contextHints.length,
        contextHints: group.contextHints.slice(0, 3),
        adCount: group.ads.length,
        ads: group.ads.slice(0, 4).map((ad) => ({
          id: ad.id,
          name: ad.name,
          status: ad.status,
          reviewStatus: ad.reviewStatus,
          upstreamUpdatedAt: ad.upstreamUpdatedAt,
          syncedAt: ad.syncedAt,
          creative: ad.creative
            ? {
                type: ad.creative.type,
                title: ad.creative.title,
                body: ad.creative.body,
                targetUrl: ad.creative.targetUrl,
                fileId: ad.creative.fileId,
              }
            : ad.creative,
        })),
        upstreamUpdatedAt: group.upstreamUpdatedAt,
        syncedAt: group.syncedAt,
      })),
      description: campaign.description,
      startTime: campaign.startTime,
      endTime: campaign.endTime,
      locationIds: campaign.locationIds ?? [],
      upstreamUpdatedAt: campaign.upstreamUpdatedAt,
      syncedAt: campaign.syncedAt,
    })),
  }
}

function compactInsights(response: AdsInsightsResponse, rowLimit: number) {
  return {
    currencyCode: response.currencyCode,
    rowCount: response.rows.length,
    rows: response.rows.slice(-rowLimit),
  }
}

function buildAdsOperatorContextTool(ctx: ToolContext): AgentTool {
  return {
    name: AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME,
    label: 'Get ads operator context',
    description:
      'One-call Aero context pack for ads operations. Reads the project overview, stored ads delivery diagnostics, ads connection, paid summary, bounded campaign snapshots, recent paid rollups, ads doctor checks, and recent Aero memory. Use before diagnosing ChatGPT ads performance or planning the next operator action.',
    parameters: Type.Object({
      windowDays: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 90,
        description: 'Lookback window for paid rollup rows. Default 30 days.',
      })),
      campaignLimit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 25,
        description: 'Max campaign snapshots to include. Default 8.',
      })),
      insightRowLimit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Max paid rollup rows to include per level. Default 40.',
      })),
    }) as TSchema,
    execute: async (_toolCallId, rawParams): Promise<AgentToolResult<unknown>> => {
      const params = rawParams as AdsOperatorContextParams
      const windowDays = clampInteger(params.windowDays, 30, 1, 90)
      const campaignLimit = clampInteger(params.campaignLimit, 8, 1, 25)
      const insightRowLimit = clampInteger(params.insightRowLimit, 40, 1, 100)
      const from = isoDateDaysAgo(windowDays)
      const to = todayIsoDate()

      const [
        overview,
        adsStatus,
        deliveryDiagnostics,
        adsSummary,
        campaigns,
        campaignInsights,
        adGroupInsights,
        doctor,
        memory,
      ] = await Promise.all([
        readSection(() => ctx.client.getProjectOverview(ctx.projectName)),
        readSection(() => ctx.client.getAdsStatus(ctx.projectName)),
        readSection(() => ctx.client.getAdsDeliveryDiagnostics(ctx.projectName)),
        readSection(() => ctx.client.getAdsSummary(ctx.projectName)),
        readSection(async () => compactCampaigns(await ctx.client.getAdsCampaigns(ctx.projectName), campaignLimit)),
        readSection(async () =>
          compactInsights(
            await ctx.client.getAdsInsights(ctx.projectName, { level: 'campaign', from, to }),
            insightRowLimit,
          ),
        ),
        readSection(async () =>
          compactInsights(
            await ctx.client.getAdsInsights(ctx.projectName, { level: 'ad_group', from, to }),
            insightRowLimit,
          ),
        ),
        readSection(() => ctx.client.runDoctor({ project: ctx.projectName, checkIds: ['ads.*'] })),
        readSection(async () => {
          const result = await ctx.client.listAgentMemory(ctx.projectName)
          return { entries: result.entries.slice(0, 10) }
        }),
      ])

      return toolResult({
        project: ctx.projectName,
        generatedAt: new Date().toISOString(),
        window: { days: windowDays, from, to },
        overview: overview.status === 'ok' && overview.data
          ? { status: 'ok' as const, data: compactOverview(overview.data) }
          : overview,
        ads: {
          status: adsStatus,
          deliveryDiagnostics,
          summary: adsSummary,
          campaigns,
          insights: {
            campaign: campaignInsights,
            adGroup: adGroupInsights,
          },
        },
        doctor,
        memory,
      })
    },
  } as AgentTool
}

/**
 * Read-only Aero tools — every read tool from the MCP registry, with the
 * Aero-excluded set filtered out. Adding a new read tool to
 * `mcp/tool-registry.ts` automatically exposes it here.
 */
export function buildReadTools(ctx: ToolContext): AgentTool[] {
  return buildMcpAgentTools(canonryMcpTools, ctx, { readOnly: true })
}

/**
 * Full tool set — every read + write tool from the MCP registry, minus the
 * Aero-excluded set (e.g., `canonry_agent_clear`, which would erase the
 * operator's context mid-turn). New MCP tools flow into Aero automatically.
 */
export function buildAllTools(ctx: ToolContext): AgentTool[] {
  return buildMcpAgentTools(canonryMcpTools, ctx)
}

export function buildAdsOperatorTools(
  ctx: ToolContext,
  opts: Pick<ToolBuildOptions, 'scope'> = {},
): AgentTool[] {
  const mcpTools = buildMcpAgentTools(canonryMcpTools, ctx, {
    readOnly: opts.scope === AeroToolScopes.readOnly,
    includeNames: AERO_ADS_OPERATOR_MCP_TOOL_NAMES,
  })
  return [buildAdsOperatorContextTool(ctx), ...mcpTools]
}

export function buildAeroStateTools(ctx: ToolContext, opts: ToolBuildOptions = {}): AgentTool[] {
  const scope = opts.scope ?? AeroToolScopes.all
  const profile = opts.profile ?? AeroToolProfiles.default
  if (profile === AeroToolProfiles.adsOperator) {
    return buildAdsOperatorTools(ctx, { scope })
  }
  return scope === AeroToolScopes.readOnly ? buildReadTools(ctx) : buildAllTools(ctx)
}
