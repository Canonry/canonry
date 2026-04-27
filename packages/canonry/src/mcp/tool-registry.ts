import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  competitorBatchRequestSchema,
  keywordBatchRequestSchema,
  notificationCreateRequestSchema,
  notificationEventSchema,
  runTriggerRequestSchema,
  scheduleUpsertRequestSchema,
  type NotificationEvent,
} from '@ainyc/canonry-contracts'
import { z } from 'zod'
import type { ApiClient } from '../client.js'
import {
  analyticsWindowSchema,
  compactStringParams,
  emptyInputSchema,
  insightIdSchema,
  projectInputSchema,
  projectNameSchema,
  runIdSchema,
  toJsonSchema,
  uniqueStrings,
} from './schema.js'

export type McpToolAccess = 'read' | 'write'

export interface CanonryMcpTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  title: string
  description: string
  access: McpToolAccess
  inputSchema: TSchema
  inputJsonSchema: unknown
  annotations: ToolAnnotations
  openApiOperations: string[]
  handler: (client: ApiClient, input: z.infer<TSchema>) => Promise<unknown>
}

const readAnnotations = (openWorldHint?: boolean): ToolAnnotations => ({
  readOnlyHint: true,
  ...(openWorldHint ? { openWorldHint } : {}),
})

const writeAnnotations = (opts: { idempotentHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean }): ToolAnnotations => ({
  readOnlyHint: false,
  idempotentHint: opts.idempotentHint,
  destructiveHint: Boolean(opts.destructiveHint),
  ...(opts.openWorldHint ? { openWorldHint: opts.openWorldHint } : {}),
})

function defineTool<TSchema extends z.ZodTypeAny>(
  tool: Omit<CanonryMcpTool<TSchema>, 'inputJsonSchema'>,
): CanonryMcpTool<TSchema> {
  return {
    ...tool,
    inputJsonSchema: toJsonSchema(tool.inputSchema, tool.name),
  }
}

const runTriggerInputSchema = z.object({
  project: projectNameSchema,
  request: runTriggerRequestSchema.optional(),
})

const runsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
})

const runGetInputSchema = z.object({
  runId: runIdSchema,
})

const timelineInputSchema = z.object({
  project: projectNameSchema,
  location: z.string().optional().describe('Location label. Use an empty string for locationless results.'),
})

const snapshotsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
  location: z.string().optional().describe('Location label. Use an empty string for locationless results.'),
})

const snapshotsDiffInputSchema = z.object({
  project: projectNameSchema,
  run1: runIdSchema,
  run2: runIdSchema,
})

const insightsListInputSchema = z.object({
  project: projectNameSchema,
  dismissed: z.boolean().optional(),
  runId: runIdSchema.optional(),
})

const insightInputSchema = z.object({
  project: projectNameSchema,
  insightId: insightIdSchema,
})

const healthHistoryInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(100).optional(),
})

const gscPerformanceInputSchema = z.object({
  project: projectNameSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  query: z.string().optional(),
  page: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  window: analyticsWindowSchema.optional(),
})

const gscInspectionsInputSchema = z.object({
  project: projectNameSchema,
  url: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
})

const gscCoverageHistoryInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional(),
})

const gaWindowInputSchema = z.object({
  project: projectNameSchema,
  window: analyticsWindowSchema.optional(),
})

const gaTrafficInputSchema = gaWindowInputSchema.extend({
  limit: z.number().int().positive().max(500).optional(),
})

const keywordsInputSchema = z.object({
  project: projectNameSchema,
  request: keywordBatchRequestSchema,
})

const competitorsAddInputSchema = z.object({
  project: projectNameSchema,
  request: competitorBatchRequestSchema,
})

const scheduleSetInputSchema = z.object({
  project: projectNameSchema,
  schedule: scheduleUpsertRequestSchema,
})

const agentWebhookAttachInputSchema = z.object({
  project: projectNameSchema,
  url: z.string().url(),
})

const AGENT_WEBHOOK_EVENTS = [
  notificationEventSchema.enum['run.completed'],
  notificationEventSchema.enum['insight.critical'],
  notificationEventSchema.enum['insight.high'],
  notificationEventSchema.enum['citation.gained'],
] satisfies NotificationEvent[]

export const canonryMcpTools = [
  defineTool({
    name: 'canonry_projects_list',
    title: 'List Canonry projects',
    description: 'List all Canonry projects available through the configured API.',
    access: 'read',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects'],
    handler: (client) => client.listProjects(),
  }),
  defineTool({
    name: 'canonry_project_get',
    title: 'Get project',
    description: 'Get a Canonry project by name.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}'],
    handler: (client, input) => client.getProject(input.project),
  }),
  defineTool({
    name: 'canonry_project_export',
    title: 'Export project config',
    description: 'Export a Canonry project in config-as-code format.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/export'],
    handler: (client, input) => client.getExport(input.project),
  }),
  defineTool({
    name: 'canonry_project_history',
    title: 'Get project history',
    description: 'Get audit history for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/history'],
    handler: (client, input) => client.getHistory(input.project),
  }),
  defineTool({
    name: 'canonry_runs_list',
    title: 'List project runs',
    description: 'List runs for a Canonry project.',
    access: 'read',
    inputSchema: runsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/runs'],
    handler: (client, input) => client.listRuns(input.project, input.limit),
  }),
  defineTool({
    name: 'canonry_runs_latest',
    title: 'Get latest project run',
    description: 'Get the latest run and total run count for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/runs/latest'],
    handler: (client, input) => client.getLatestRun(input.project),
  }),
  defineTool({
    name: 'canonry_run_get',
    title: 'Get run',
    description: 'Get a Canonry run with its snapshots.',
    access: 'read',
    inputSchema: runGetInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/runs/{id}'],
    handler: (client, input) => client.getRun(input.runId),
  }),
  defineTool({
    name: 'canonry_timeline_get',
    title: 'Get project timeline',
    description: 'Get per-keyword citation history for a Canonry project.',
    access: 'read',
    inputSchema: timelineInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/timeline'],
    handler: (client, input) => client.getTimeline(input.project, input.location),
  }),
  defineTool({
    name: 'canonry_snapshots_list',
    title: 'List query snapshots',
    description: 'List paginated query snapshots for a Canonry project.',
    access: 'read',
    inputSchema: snapshotsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/snapshots'],
    handler: (client, input) => client.getSnapshots(input.project, {
      limit: input.limit,
      offset: input.offset,
      location: input.location,
    }),
  }),
  defineTool({
    name: 'canonry_snapshots_diff',
    title: 'Diff snapshots',
    description: 'Compare query snapshot states between two Canonry runs.',
    access: 'read',
    inputSchema: snapshotsDiffInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/snapshots/diff'],
    handler: (client, input) => client.getSnapshotDiff(input.project, input.run1, input.run2),
  }),
  defineTool({
    name: 'canonry_insights_list',
    title: 'List insights',
    description: 'List intelligence insights for a Canonry project.',
    access: 'read',
    inputSchema: insightsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/insights'],
    handler: (client, input) => client.getInsights(input.project, { dismissed: input.dismissed, runId: input.runId }),
  }),
  defineTool({
    name: 'canonry_insight_get',
    title: 'Get insight',
    description: 'Get one intelligence insight for a Canonry project.',
    access: 'read',
    inputSchema: insightInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/insights/{id}'],
    handler: (client, input) => client.getInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_health_latest',
    title: 'Get latest health',
    description: 'Get the latest health snapshot for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/health/latest'],
    handler: (client, input) => client.getHealth(input.project),
  }),
  defineTool({
    name: 'canonry_health_history',
    title: 'Get health history',
    description: 'Get health snapshot history for a Canonry project.',
    access: 'read',
    inputSchema: healthHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/health/history'],
    handler: (client, input) => client.getHealthHistory(input.project, input.limit),
  }),
  defineTool({
    name: 'canonry_keywords_list',
    title: 'List keywords',
    description: 'List tracked keywords for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/keywords'],
    handler: (client, input) => client.listKeywords(input.project),
  }),
  defineTool({
    name: 'canonry_competitors_list',
    title: 'List competitors',
    description: 'List tracked competitors for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/competitors'],
    handler: (client, input) => client.listCompetitors(input.project),
  }),
  defineTool({
    name: 'canonry_schedule_get',
    title: 'Get schedule',
    description: 'Get the scheduled run configuration for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.getSchedule(input.project),
  }),
  defineTool({
    name: 'canonry_settings_get',
    title: 'Get settings',
    description: 'Get Canonry API settings and configured provider status.',
    access: 'read',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/settings'],
    handler: (client) => client.getSettings(),
  }),
  defineTool({
    name: 'canonry_google_connections_list',
    title: 'List Google connections',
    description: 'List configured Google connections for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/connections'],
    handler: (client, input) => client.googleConnections(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_performance',
    title: 'Get GSC performance',
    description: 'Get stored Google Search Console performance rows for a Canonry project.',
    access: 'read',
    inputSchema: gscPerformanceInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/performance'],
    handler: (client, input) => client.gscPerformance(input.project, compactStringParams(input, ['startDate', 'endDate', 'query', 'page', 'limit', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_inspections',
    title: 'List GSC inspections',
    description: 'List stored URL inspection rows for a Canonry project.',
    access: 'read',
    inputSchema: gscInspectionsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/inspections'],
    handler: (client, input) => client.gscInspections(input.project, compactStringParams(input, ['url', 'limit'])),
  }),
  defineTool({
    name: 'canonry_gsc_deindexed',
    title: 'List deindexed GSC URLs',
    description: 'List URLs that appear to have become deindexed in Google Search Console data.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/deindexed'],
    handler: (client, input) => client.gscDeindexed(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_coverage',
    title: 'Get GSC coverage',
    description: 'Get Google Search Console coverage summary for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/coverage'],
    handler: (client, input) => client.gscCoverage(input.project),
  }),
  defineTool({
    name: 'canonry_gsc_coverage_history',
    title: 'Get GSC coverage history',
    description: 'Get Google Search Console coverage history snapshots for a Canonry project.',
    access: 'read',
    inputSchema: gscCoverageHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/coverage/history'],
    handler: (client, input) => client.gscCoverageHistory(input.project, { limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_gsc_sitemaps',
    title: 'Get GSC sitemaps',
    description: 'Get sitemap data from Google Search Console for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/sitemaps'],
    handler: (client, input) => client.gscSitemaps(input.project),
  }),
  defineTool({
    name: 'canonry_ga_status',
    title: 'Get GA status',
    description: 'Get Google Analytics connection status for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/status'],
    handler: (client, input) => client.gaStatus(input.project),
  }),
  defineTool({
    name: 'canonry_ga_traffic',
    title: 'Get GA traffic',
    description: 'Get Google Analytics traffic summary for a Canonry project.',
    access: 'read',
    inputSchema: gaTrafficInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/traffic'],
    handler: (client, input) => client.gaTraffic(input.project, compactStringParams(input, ['limit', 'window'])),
  }),
  defineTool({
    name: 'canonry_ga_coverage',
    title: 'Get GA coverage',
    description: 'Get Google Analytics page coverage for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/coverage'],
    handler: (client, input) => client.gaCoverage(input.project),
  }),
  defineTool({
    name: 'canonry_ga_ai_referral_history',
    title: 'Get GA AI referral history',
    description: 'Get AI referral sessions per day grouped by source.',
    access: 'read',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/ai-referral-history'],
    handler: (client, input) => client.gaAiReferralHistory(input.project, compactStringParams(input, ['window'])),
  }),
  defineTool({
    name: 'canonry_ga_social_referral_history',
    title: 'Get GA social referral history',
    description: 'Get social referral sessions per day grouped by source.',
    access: 'read',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/social-referral-history'],
    handler: (client, input) => client.gaSocialReferralHistory(input.project, compactStringParams(input, ['window'])),
  }),
  defineTool({
    name: 'canonry_ga_social_referral_trend',
    title: 'Get GA social referral trend',
    description: 'Get social referral trend with biggest mover for a Canonry project.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/social-referral-trend'],
    handler: (client, input) => client.gaSocialReferralTrend(input.project),
  }),
  defineTool({
    name: 'canonry_ga_attribution_trend',
    title: 'Get GA attribution trend',
    description: 'Get per-channel attribution trends for organic, AI, social, and total sessions.',
    access: 'read',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/attribution-trend'],
    handler: (client, input) => client.gaAttributionTrend(input.project),
  }),
  defineTool({
    name: 'canonry_ga_session_history',
    title: 'Get GA session history',
    description: 'Get total sessions per day for a Canonry project.',
    access: 'read',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/session-history'],
    handler: (client, input) => client.gaSessionHistory(input.project, compactStringParams(input, ['window'])),
  }),
  defineTool({
    name: 'canonry_run_trigger',
    title: 'Trigger run',
    description: 'Trigger an answer-visibility run for a Canonry project.',
    access: 'write',
    inputSchema: runTriggerInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/runs'],
    handler: (client, input) => client.triggerRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_run_cancel',
    title: 'Cancel run',
    description: 'Cancel a queued or running Canonry run.',
    access: 'write',
    inputSchema: runGetInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/runs/{id}/cancel'],
    handler: (client, input) => client.cancelRun(input.runId),
  }),
  defineTool({
    name: 'canonry_keywords_add',
    title: 'Add keywords',
    description: 'Append tracked keywords to a Canonry project; existing keywords are skipped by the API.',
    access: 'write',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.appendKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_keywords_remove',
    title: 'Remove keywords',
    description: 'Remove tracked keywords from a Canonry project.',
    access: 'write',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.deleteKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_competitors_add',
    title: 'Add competitors',
    description: 'Add tracked competitor domains to a Canonry project.',
    access: 'write',
    inputSchema: competitorsAddInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['GET /api/v1/projects/{name}/competitors', 'PUT /api/v1/projects/{name}/competitors'],
    handler: async (client, input) => {
      const existing = await client.listCompetitors(input.project)
      const merged = uniqueStrings([...existing.map(c => c.domain), ...input.request.competitors])
      await client.putCompetitors(input.project, merged)
    },
  }),
  defineTool({
    name: 'canonry_schedule_set',
    title: 'Set schedule',
    description: 'Create or replace the scheduled run configuration for a Canonry project.',
    access: 'write',
    inputSchema: scheduleSetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.putSchedule(input.project, input.schedule),
  }),
  defineTool({
    name: 'canonry_schedule_delete',
    title: 'Delete schedule',
    description: 'Delete the scheduled run configuration for a Canonry project.',
    access: 'write',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/schedule'],
    handler: async (client, input) => {
      await client.deleteSchedule(input.project)
    },
  }),
  defineTool({
    name: 'canonry_insight_dismiss',
    title: 'Dismiss insight',
    description: 'Dismiss an intelligence insight for a Canonry project.',
    access: 'write',
    inputSchema: insightInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/insights/{id}/dismiss'],
    handler: (client, input) => client.dismissInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_agent_webhook_attach',
    title: 'Attach agent webhook',
    description: 'Attach an external agent webhook to project run and insight events.',
    access: 'write',
    inputSchema: agentWebhookAttachInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['GET /api/v1/projects/{name}/notifications', 'POST /api/v1/projects/{name}/notifications'],
    handler: async (client, input) => {
      const existing = await client.listNotifications(input.project)
      const agentNotification = existing.find(notification => notification.source === 'agent')
      if (agentNotification) {
        return { status: 'already-attached', project: input.project, notificationId: agentNotification.id }
      }
      const request = notificationCreateRequestSchema.parse({
        channel: 'webhook',
        url: input.url,
        events: AGENT_WEBHOOK_EVENTS,
        source: 'agent',
      })
      const notification = await client.createNotification(input.project, request)
      return { status: 'attached', project: input.project, notificationId: notification.id }
    },
  }),
  defineTool({
    name: 'canonry_agent_webhook_detach',
    title: 'Detach agent webhook',
    description: 'Detach the external agent webhook for a Canonry project.',
    access: 'write',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['GET /api/v1/projects/{name}/notifications', 'DELETE /api/v1/projects/{name}/notifications/{id}'],
    handler: async (client, input) => {
      const existing = await client.listNotifications(input.project)
      const agentNotification = existing.find(notification => notification.source === 'agent')
      if (!agentNotification) {
        return { status: 'not-attached', project: input.project }
      }
      await client.deleteNotification(input.project, agentNotification.id)
      return { status: 'detached', project: input.project }
    },
  }),
] as const

export const CANONRY_MCP_TOOL_COUNT = canonryMcpTools.length
export const CANONRY_MCP_READ_TOOL_COUNT = canonryMcpTools.filter(tool => tool.access === 'read').length
