import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
  AGENT_MEMORY_KEY_MAX_LENGTH,
  AGENT_MEMORY_VALUE_MAX_BYTES,
  competitorBatchRequestSchema,
  DISCOVERY_MAX_PROBES_CAP,
  discoveryBucketSchema,
  discoveryCompetitorTypeSchema,
  discoveryPromoteRequestSchema,
  discoveryRunRequestSchema,
  keywordBatchRequestSchema,
  keywordGenerateRequestSchema,
  queryGenerateRequestSchema,
  queryBatchRequestSchema,
  notificationCreateRequestSchema,
  notificationEventSchema,
  projectConfigSchema,
  projectUpsertRequestSchema,
  runTriggerRequestSchema,
  schedulableRunKindSchema,
  scheduleUpsertRequestSchema,
  trafficConnectCloudRunRequestSchema,
  trafficConnectWordpressRequestSchema,
  trafficConnectVercelRequestSchema,
  trafficEventKindSchema,
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
import type { CanonryMcpTier } from './toolkits.js'

export type McpToolAccess = 'read' | 'write'

export interface CanonryMcpTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  title: string
  description: string
  access: McpToolAccess
  tier: CanonryMcpTier
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

const gscPerformanceDailyInputSchema = z.object({
  project: projectNameSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
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

const queriesInputSchema = z.object({
  project: projectNameSchema,
  request: queryBatchRequestSchema,
})

const queryGenerateInputSchema = z.object({
  project: projectNameSchema,
  request: queryGenerateRequestSchema,
})

const gbpListLocationsInputSchema = z.object({
  project: projectNameSchema,
  selected: z.boolean().optional(),
})

const gbpDiscoverInputSchema = z.object({
  project: projectNameSchema,
  selectAllNew: z.boolean().optional().default(true),
})

const gbpLocationSelectionInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().min(1).regex(/^locations\//, 'locationName must be a Google resource name like "locations/12345"'),
  selected: z.boolean(),
})

const gbpSyncInputSchema = z.object({
  project: projectNameSchema,
  locationNames: z.array(z.string()).optional(),
  daysOfMetrics: z.number().int().positive().max(540).optional(),
  monthsOfKeywords: z.number().int().positive().max(18).optional(),
})

const gbpMetricsInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().optional(),
  metric: z.string().optional(),
})

const gbpLocationScopedInputSchema = z.object({
  project: projectNameSchema,
  locationName: z.string().optional(),
})

const keywordsInputSchema = z.object({
  project: projectNameSchema,
  request: keywordBatchRequestSchema,
})

const keywordGenerateInputSchema = z.object({
  project: projectNameSchema,
  request: keywordGenerateRequestSchema,
})

const competitorsInputSchema = z.object({
  project: projectNameSchema,
  request: competitorBatchRequestSchema,
})

const projectUpsertInputSchema = z.object({
  project: projectNameSchema,
  request: projectUpsertRequestSchema,
})

const applyConfigInputSchema = z.object({
  config: projectConfigSchema,
})

const scheduleSetInputSchema = z.object({
  project: projectNameSchema,
  schedule: scheduleUpsertRequestSchema,
})

const scheduleReadInputSchema = z.object({
  project: projectNameSchema,
  kind: schedulableRunKindSchema.optional().describe('Schedulable run kind. Defaults to "answer-visibility" if omitted.'),
})

const agentWebhookAttachInputSchema = z.object({
  project: projectNameSchema,
  url: z.string().url(),
})

const doctorInputSchema = z.object({
  project: projectNameSchema.optional().describe('Project name to scope project-level checks. Omit to run global checks (provider keys, config, etc.).'),
  checks: z.array(z.string().min(1)).optional().describe('Optional check IDs or wildcard prefixes (e.g. "google.auth.*", "config.providers"). Empty/omitted runs all matching checks for the chosen scope.'),
})

const contentTargetsInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(500).optional().describe('Max rows. Defaults to all. Use a small number (3-10) when summarizing for the user.'),
  includeInProgress: z.boolean().optional().describe('Include rows that already have an in-flight tracked action. Default false.'),
})

const backlinksDomainsInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(200).optional().describe('Max linking-domain rows. Default 50, max 200.'),
  release: z.string().optional().describe('Common Crawl release id (e.g., cc-main-2026-jan-feb-mar). Omit for the most recent release with data.'),
})

const memoryUpsertInputSchema = z.object({
  project: projectNameSchema,
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH).describe(`Stable identifier for the note (max ${AGENT_MEMORY_KEY_MAX_LENGTH} chars). Writing the same key overwrites the prior value.`),
  value: z.string().min(1).describe(`Plain-text note body (max ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes). Use for durable operator preferences, migration context, or non-obvious reasoning that should survive future sessions.`),
})

const memoryForgetInputSchema = z.object({
  project: projectNameSchema,
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX_LENGTH).describe('Exact key of the note to remove. No-op (status=missing) when no note exists for that key.'),
})

const trafficConnectCloudRunInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectCloudRunRequestSchema,
})

const trafficConnectWordpressInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectWordpressRequestSchema,
})

const trafficConnectVercelInputSchema = z.object({
  project: projectNameSchema,
  request: trafficConnectVercelRequestSchema,
})

const trafficSyncInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_connect_cloud_run or canonry_traffic_sources_list.'),
  sinceMinutes: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60)
    .optional()
    .describe('Lookback window in minutes. Defaults to the source\'s configured window (60 min) when omitted; clamped forward to lastSyncedAt to avoid double-counting.'),
})

const trafficBackfillInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_sources_list.'),
  days: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe('Lookback window in days. Default 30, capped server-side at the upstream log retention ceiling (Cloud Logging _Default = 30d).'),
})

const trafficResetInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID returned by canonry_traffic_sources_list.'),
  advanceToNow: z
    .literal(true)
    .describe('Must be `true`. Explicit gate against accidental resets. Advances lastSyncedAt to NOW and clears the source\'s error state.'),
})

const trafficEventsInputSchema = z.object({
  project: projectNameSchema,
  since: z.string().optional().describe('ISO 8601 lower bound. Defaults to 24h ago when omitted.'),
  until: z.string().optional().describe('ISO 8601 upper bound. Defaults to now when omitted.'),
  kind: z.union([trafficEventKindSchema, z.literal('all')]).optional().describe('Filter to "crawler" or "ai-referral"; "all" (default) returns both.'),
  sourceId: z.string().min(1).optional().describe('Restrict to a single traffic source ID.'),
  limit: z.number().int().positive().max(5000).optional().describe('Max combined rows. Defaults to 500, max 5000. Totals always reflect the full window.'),
})

const trafficSourceIdInputSchema = z.object({
  project: projectNameSchema,
  sourceId: z.string().min(1).describe('Traffic source ID.'),
})

const discoveryRunInputSchema = z.object({
  project: projectNameSchema,
  request: discoveryRunRequestSchema
    .extend({
      // Stronger descriptions for the LLM. The base Zod schema enforces the
      // upper bound; this just clarifies the meaning of each knob.
      icpDescription: z.string().min(1).optional().describe('Free-text ICP description. If omitted, the project must already have spec.icpDescription stored.'),
      dedupThreshold: z.number().min(0).max(1).optional().describe('Cosine similarity threshold for clustering seed candidates. Defaults to 0.85. Lower values dedupe more aggressively.'),
      maxProbes: z.number().int().positive().max(DISCOVERY_MAX_PROBES_CAP).optional().describe(`Max canonical queries to probe in this session. Default 100, hard cap ${DISCOVERY_MAX_PROBES_CAP}.`),
    })
    .optional(),
})

const discoverySessionsListInputSchema = z.object({
  project: projectNameSchema,
  limit: z.number().int().positive().max(200).optional().describe('Max sessions returned. Default 50.'),
})

const discoverySessionIdInputSchema = z.object({
  project: projectNameSchema,
  sessionId: z.string().min(1).describe('Discovery session ID returned by canonry_discover_run_start.'),
})

const discoveryPromoteInputSchema = z.object({
  project: projectNameSchema,
  sessionId: z.string().min(1).describe('Discovery session ID returned by canonry_discover_run_start.'),
  request: discoveryPromoteRequestSchema
    .extend({
      // Stronger descriptions for the LLM. The base Zod schema enforces the shape.
      buckets: z
        .array(discoveryBucketSchema)
        .min(1)
        .optional()
        .describe('Which probe buckets to adopt into the tracked basket. Omitted promotes cited + aspirational; include wasted-surface explicitly for off-ICP competitor gaps.'),
      includeCompetitors: z
        .boolean()
        .optional()
        .describe("Whether to also merge recurring discovered competitor domains into the project. Defaults to true."),
      competitorTypes: z
        .array(discoveryCompetitorTypeSchema)
        .min(1)
        .optional()
        .describe('Which classified competitor types to merge. Omitted promotes direct-competitor only; pass an explicit list to also adopt editorial-media channels or to recover legacy unknown entries. Ignored when includeCompetitors is false.'),
    })
    .optional(),
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
    tier: 'core',
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
    tier: 'core',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}'],
    handler: (client, input) => client.getProject(input.project),
  }),
  defineTool({
    name: 'canonry_project_delete_preview',
    title: 'Preview project delete impact',
    description: 'Returns the cascade impact of deleting a project — how many queries, competitors, runs, snapshots, and insights would be removed, plus how many audit_log rows would be detached (project_id set NULL). Read-only. Use this BEFORE invoking project delete on any project you didn\'t create yourself; the underlying delete is irreversible.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/delete-preview'],
    handler: (client, input) => client.previewProjectDelete(input.project),
  }),
  defineTool({
    name: 'canonry_project_overview',
    title: 'Get project overview (composite)',
    description: 'One-call summary for "how is project X doing?" — bundles project info, latest run, top undismissed insights, latest health snapshot, query cited rate, per-provider breakdown, gained/lost/emerging vs the previous run, the five score gauges (visibility, gap queries, index coverage, competitor pressure, run status), per-(provider, model) scores, configured competitors with pressure labels, an attention queue of critical/high insights, and a recent-runs sparkline. Filterable by location and time window. Prefer this over fanning out to separate tools.',
    access: 'read',
    tier: 'core',
    inputSchema: z.object({
      project: projectNameSchema,
      location: z.string().optional().describe('Filter to runs from this location label (e.g. "Boston, MA, US"). Omit for all locations.'),
      since: z.string().optional().describe('ISO 8601 datetime — only include runs at or after this time. Omit for full history.'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/overview'],
    handler: (client, input) => client.getProjectOverview(input.project, {
      location: input.location,
      since: input.since,
    }),
  }),
  defineTool({
    name: 'canonry_report',
    title: 'Get aggregated AEO report',
    description:
      'Returns the full canonical AEO report bundle for a project — executive summary, client summary, agency diagnostics, action plan, per-query × per-provider citation matrix, competitor landscape, AI citation sources, GSC/GA4 performance, social and AI referrals, indexing health, citations trend, prioritized insights, and recommended next steps. Same payload `canonry report <project>` consumes to render audience-specific HTML.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/report'],
    handler: (client, input) => client.getReport(input.project),
  }),
  defineTool({
    name: 'canonry_search',
    title: 'Search project (composite)',
    description: 'Search query snapshots and intelligence insights for the given text. Looks at snapshot answer text, cited domains, raw provider responses, and insight title/query/recommendation/cause. Returns ranked hits with snippets — use it instead of paginating snapshots when you need to find a competitor mention or term.',
    access: 'read',
    tier: 'core',
    inputSchema: z.object({
      project: projectNameSchema,
      q: z.string().min(2).describe('Search term, at least 2 characters.'),
      limit: z.number().int().positive().max(50).optional().describe('Max combined hits (1-50, default 25).'),
    }),
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/search'],
    handler: (client, input) => client.searchProject(input.project, { q: input.q, limit: input.limit }),
  }),
  defineTool({
    name: 'canonry_doctor',
    title: 'Run health checks',
    description:
      'Run canonry health checks. With `project`, runs project-scoped checks (Google/GA auth, redirect URI, scopes, property access). Without `project`, runs global checks (provider keys, etc.). Use `checks` to filter by exact ID or wildcard prefix (e.g. ["google.auth.*"]). Returns a structured DoctorReport with per-check status, code, summary, remediation, and details — use this to diagnose Google auth failures (401/403/redirect-mismatch/principal-mismatch) without parsing logs.',
    access: 'read',
    tier: 'core',
    inputSchema: doctorInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/doctor', 'GET /api/v1/projects/{name}/doctor'],
    handler: (client, input) => client.runDoctor({ project: input.project, checkIds: input.checks }),
  }),
  defineTool({
    name: 'canonry_project_export',
    title: 'Export project config',
    description: 'Export a Canonry project in config-as-code format.',
    access: 'read',
    tier: 'setup',
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
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/history'],
    handler: (client, input) => client.getHistory(input.project),
  }),
  defineTool({
    name: 'canonry_runs_list',
    title: 'List project runs',
    description: "List runs for a Canonry project. Includes both real runs (trigger='manual'/'scheduled'/'config-apply'/'backfill') AND probe runs (trigger='probe'). Probe runs are operator/agent test runs that don't influence dashboard, analytics, intelligence, or notifications — filter by `trigger !== 'probe'` if you only want runs that feed project metrics.",
    access: 'read',
    tier: 'monitoring',
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
    tier: 'monitoring',
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
    tier: 'monitoring',
    inputSchema: runGetInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/runs/{id}'],
    handler: (client, input) => client.getRun(input.runId),
  }),
  defineTool({
    name: 'canonry_timeline_get',
    title: 'Get project timeline',
    description: 'Get per-query citation history for a Canonry project.',
    access: 'read',
    tier: 'monitoring',
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
    tier: 'monitoring',
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
    tier: 'monitoring',
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
    tier: 'monitoring',
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
    tier: 'monitoring',
    inputSchema: insightInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/insights/{id}'],
    handler: (client, input) => client.getInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_health_latest',
    title: 'Get latest health',
    description: 'Get the latest health snapshot for a Canonry project. Always returns a snapshot once the project exists: real data carries `status: "ready"`; newly-created projects (or projects with only failed runs) carry `status: "no-data"` with `reason: "no-runs-yet"` and zeroed metrics.',
    access: 'read',
    tier: 'monitoring',
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
    tier: 'monitoring',
    inputSchema: healthHistoryInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/health/history'],
    handler: (client, input) => client.getHealthHistory(input.project, input.limit),
  }),
  defineTool({
    name: 'canonry_citations_visibility',
    title: 'Get citation visibility',
    description: 'Single-call AI citation surface for a Canonry project. Returns the project headline (cited by N of M engines), per-query engine coverage rows from the latest snapshot per (query × provider), and a competitor-gap list (queries where a configured competitor is cited but the project is not). Carries `status: "no-data"` with `reason: "no-queries"` or `"no-runs-yet"` when inputs are missing.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/citations/visibility'],
    handler: (client, input) => client.getCitationVisibility(input.project),
  }),
  defineTool({
    name: 'canonry_content_targets',
    title: 'Get content targets',
    description: 'Ranked, action-typed content opportunities. Each row is `{query, action ∈ create|expand|refresh|add-schema, ourBestPage?, winningCompetitor?, score, scoreBreakdown, drivers[], demandSource, actionConfidence}`. Use this to recommend which post the user should write or refresh next.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: contentTargetsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/targets'],
    handler: (client, input) => client.getContentTargets(input.project, {
      limit: input.limit,
      includeInProgress: input.includeInProgress,
    }),
  }),
  defineTool({
    name: 'canonry_content_sources',
    title: 'Get grounding sources',
    description: 'URL-level competitive grounding-source map. Per query, lists every URL the LLM cited (our domain vs competitors) with citation count and providers. Read this to understand which specific competitor URL is winning a query.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/sources'],
    handler: (client, input) => client.getContentSources(input.project),
  }),
  defineTool({
    name: 'canonry_content_gaps',
    title: 'Get content gaps',
    description: 'Queries where competitors are cited but our domain is not, ranked by miss rate. The blunt-instrument view of "what competitors are winning that we are not." Use canonry_content_targets for action-typed recommendations on the same data.',
    access: 'read',
    tier: 'monitoring',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/content/gaps'],
    handler: (client, input) => client.getContentGaps(input.project),
  }),
  defineTool({
    name: 'canonry_queries_list',
    title: 'List queries',
    description: 'List tracked queries for a Canonry project.',
    access: 'read',
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/queries'],
    handler: (client, input) => client.listQueries(input.project),
  }),
  defineTool({
    name: 'canonry_keywords_list',
    title: 'List keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_list. Returns tracked queries using the pre-queries keyword response shape.',
    access: 'read',
    tier: 'setup',
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
    tier: 'setup',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/competitors'],
    handler: (client, input) => client.listCompetitors(input.project),
  }),
  defineTool({
    name: 'canonry_schedule_get',
    title: 'Get schedule',
    description: 'Get the scheduled run configuration for a Canonry project. Pass `kind` to read a non-default schedule (e.g. "traffic-sync"); defaults to "answer-visibility".',
    access: 'read',
    tier: 'setup',
    inputSchema: scheduleReadInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.getSchedule(input.project, input.kind),
  }),
  defineTool({
    name: 'canonry_backlinks_latest_release',
    title: 'Discover latest Common Crawl release',
    description:
      'Probes Common Crawl to find the latest published hyperlinkgraph release. Returns the release id and file URLs/sizes ready to feed into a backlinks sync (or null if no candidate slug responded).',
    access: 'read',
    tier: 'setup',
    inputSchema: emptyInputSchema,
    annotations: readAnnotations(true),
    openApiOperations: ['GET /api/v1/backlinks/latest-release'],
    handler: (client) => client.backlinksLatestRelease(),
  }),
  defineTool({
    name: 'canonry_backlinks_domains',
    title: 'List backlink domains',
    description: 'Backlink summary and top linking domains from the most recent ready Common Crawl release for a project. Off-site authority signal that correlates with citation likelihood. Returns null summary when no release sync has completed for this workspace.',
    access: 'read',
    tier: 'setup',
    inputSchema: backlinksDomainsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/backlinks/domains'],
    handler: (client, input) => client.backlinksDomains(input.project, {
      limit: input.limit ?? 50,
      release: input.release,
    }),
  }),
  defineTool({
    name: 'canonry_settings_get',
    title: 'Get settings',
    description: 'Get Canonry API settings and configured provider status.',
    access: 'read',
    tier: 'core',
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
    tier: 'gsc',
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
    tier: 'gsc',
    inputSchema: gscPerformanceInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/performance'],
    handler: (client, input) => client.gscPerformance(input.project, compactStringParams(input, ['startDate', 'endDate', 'query', 'page', 'limit', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_performance_daily',
    title: 'Get GSC daily performance summary',
    description: 'Get GSC search performance aggregated by date with window totals (clicks, impressions, CTR). Use this for charts and headline metrics — never recompute by summing the paged canonry_gsc_performance rows, which only cover one page.',
    access: 'read',
    tier: 'gsc',
    inputSchema: gscPerformanceDailyInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/google/gsc/performance/daily'],
    handler: (client, input) => client.gscPerformanceDaily(input.project, compactStringParams(input, ['startDate', 'endDate', 'window'])),
  }),
  defineTool({
    name: 'canonry_gsc_inspections',
    title: 'List GSC inspections',
    description: 'List stored URL inspection rows for a Canonry project.',
    access: 'read',
    tier: 'gsc',
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
    tier: 'gsc',
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
    tier: 'gsc',
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
    tier: 'gsc',
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
    tier: 'gsc',
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
    tier: 'ga',
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
    tier: 'ga',
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
    tier: 'ga',
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
    tier: 'ga',
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
    tier: 'ga',
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
    tier: 'ga',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/social-referral-trend'],
    handler: (client, input) => client.gaSocialReferralTrend(input.project),
  }),
  defineTool({
    name: 'canonry_ga_attribution_trend',
    title: 'Get GA attribution trend',
    description: 'Get per-channel attribution trends for organic, AI, social, direct, and total sessions.',
    access: 'read',
    tier: 'ga',
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
    tier: 'ga',
    inputSchema: gaWindowInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/ga/session-history'],
    handler: (client, input) => client.gaSessionHistory(input.project, compactStringParams(input, ['window'])),
  }),
  // ----- Google Business Profile (Phase 1: auth + discovery) -----
  defineTool({
    name: 'canonry_gbp_locations',
    title: 'List Google Business Profile locations',
    description: 'List discovered Google Business Profile locations for a Canonry project, including their selection state.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpListLocationsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/locations'],
    handler: (client, input) => client.listGbpLocations(input.project, input.selected === undefined ? undefined : { selected: input.selected }),
  }),
  defineTool({
    name: 'canonry_gbp_locations_discover',
    title: 'Discover Google Business Profile locations',
    description: 'Re-discover Google Business Profile locations from Google and upsert them. New locations get the default selection state from `selectAllNew`; existing locations keep their selection.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpDiscoverInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/gbp/locations/discover'],
    handler: (client, input) => client.discoverGbpLocations(input.project, { selectAllNew: input.selectAllNew }),
  }),
  defineTool({
    name: 'canonry_gbp_location_select',
    title: 'Toggle GBP location selection',
    description: 'Mark a Google Business Profile location as selected or deselected for sync.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpLocationSelectionInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/gbp/locations/{locationName}/selection'],
    handler: (client, input) => client.setGbpLocationSelection(input.project, input.locationName, input.selected),
  }),
  defineTool({
    name: 'canonry_gbp_disconnect',
    title: 'Disconnect Google Business Profile',
    description: 'Remove the Google Business Profile OAuth connection and all discovered locations for a project.',
    access: 'write',
    tier: 'gbp',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/gbp/connection'],
    handler: (client, input) => client.disconnectGbp(input.project),
  }),
  // ----- Google Business Profile (Phase 2: performance sync) -----
  defineTool({
    name: 'canonry_gbp_sync',
    title: 'Sync Google Business Profile performance',
    description: 'Trigger a GBP performance sync (daily metrics + monthly keyword impressions) for the project\'s selected locations. Returns the run id; poll canonry_run_get for status.',
    access: 'write',
    tier: 'gbp',
    inputSchema: gbpSyncInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/gbp/sync'],
    handler: (client, input) => client.triggerGbpSync(input.project, {
      locationNames: input.locationNames,
      daysOfMetrics: input.daysOfMetrics,
      monthsOfKeywords: input.monthsOfKeywords,
    }),
  }),
  defineTool({
    name: 'canonry_gbp_metrics',
    title: 'Get GBP daily metrics',
    description: 'List stored Google Business Profile daily performance metrics (impressions, direction requests, website/call clicks) for a project.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpMetricsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/metrics'],
    handler: (client, input) => client.listGbpMetrics(input.project, compactStringParams(input, ['locationName', 'metric'])),
  }),
  defineTool({
    name: 'canonry_gbp_keywords',
    title: 'Get GBP keyword impressions',
    description: 'List stored Google Business Profile monthly search-keyword impressions for a project. Includes a thresholdedPct (share privacy-redacted by Google).',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/keywords'],
    handler: (client, input) => client.listGbpKeywords(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_place_actions',
    title: 'Get GBP place actions',
    description: 'List stored Google Business Profile place action links (booking / reservation / order CTAs) for a project.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/place-actions'],
    handler: (client, input) => client.listGbpPlaceActions(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_lodging',
    title: 'Get GBP lodging attributes',
    description: 'List the latest Google Business Profile lodging snapshot per location (hotel structured attributes). populatedGroupCount=0 means an empty profile — an AEO gap.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/lodging'],
    handler: (client, input) => client.listGbpLodging(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_gbp_summary',
    title: 'Get GBP local-AEO summary',
    description: 'Composite Google Business Profile summary for a project: performance totals + 7d deltas, keyword thresholded %, place-action CTA presence, and lodging coverage. All derived numbers computed server-side.',
    access: 'read',
    tier: 'gbp',
    inputSchema: gbpLocationScopedInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/gbp/summary'],
    handler: (client, input) => client.getGbpSummary(input.project, compactStringParams(input, ['locationName'])),
  }),
  defineTool({
    name: 'canonry_traffic_sources_list',
    title: 'List traffic sources',
    description: 'List server-side traffic sources for a Canonry project (Cloud Run, etc.). Returns non-archived sources with status, last sync timestamp, last error, and the stored config (gcpProjectId, serviceName, location, authMode). Pair with canonry_traffic_source_get for last-24h totals on a single source.',
    access: 'read',
    tier: 'traffic',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/sources'],
    handler: (client, input) => client.trafficListSources(input.project),
  }),
  defineTool({
    name: 'canonry_traffic_source_get',
    title: 'Get traffic source detail',
    description: 'Get one traffic source plus 24h totals (crawler hits, AI-referral sessions, raw event sample count) and the latest traffic-sync run summary. Use to confirm a source is healthy and observing traffic before drilling into events.',
    access: 'read',
    tier: 'traffic',
    inputSchema: trafficSourceIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/sources/{id}'],
    handler: (client, input) => client.trafficGetSource(input.project, input.sourceId),
  }),
  defineTool({
    name: 'canonry_traffic_status',
    title: 'Traffic status (all sources)',
    description: 'Single-call composite returning every non-archived traffic source plus its last-24h totals (crawler hits, AI-referral sessions, sample count) and latest source-scoped traffic-sync run. Same per-entry shape as canonry_traffic_source_get, but one call covers all sources — prefer this over a list+per-source fan-out.',
    access: 'read',
    tier: 'traffic',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/status'],
    handler: (client, input) => client.trafficStatus(input.project),
  }),
  defineTool({
    name: 'canonry_traffic_events',
    title: 'List traffic events',
    description: 'Read crawler and AI-referral hourly rollups from server-side traffic sources. Returns a discriminated list (kind="crawler" rows carry botId/operator/verificationStatus; kind="ai-referral" rows carry product/sourceDomain/evidenceType) plus totals over the full window even when limit truncates rows. Window defaults to last 24h.',
    access: 'read',
    tier: 'traffic',
    inputSchema: trafficEventsInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/traffic/events'],
    handler: (client, input) => {
      const params: { since?: string; until?: string; kind?: string; limit?: number; sourceId?: string } = {}
      if (input.since) params.since = input.since
      if (input.until) params.until = input.until
      if (input.kind) params.kind = input.kind
      if (input.sourceId) params.sourceId = input.sourceId
      if (input.limit !== undefined) params.limit = input.limit
      return client.trafficListEvents(input.project, params)
    },
  }),
  defineTool({
    name: 'canonry_traffic_connect_cloud_run',
    title: 'Connect Cloud Run traffic source',
    description: 'Connect a Google Cloud Run service as a server-side traffic source. v1 requires service-account JSON content (paste the file contents into `keyJson`); OAuth-mode is not yet supported. Reconnecting an existing source updates the credential and config in place. The private key is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectCloudRunInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/cloud-run'],
    handler: (client, input) => client.trafficConnectCloudRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_connect_wordpress',
    title: 'Connect WordPress traffic-logger source',
    description: 'Connect a WordPress site (running the canonry traffic-logger plugin) as a server-side traffic source. Probes the plugin endpoint with the supplied Application Password before persisting — a bad credential or unreachable host surfaces as a 502 error. Reconnecting updates the existing active WordPress source in place. The Application Password is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectWordpressInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/wordpress'],
    handler: (client, input) => client.trafficConnectWordpress(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_connect_vercel',
    title: 'Connect Vercel traffic source',
    description: 'Connect a Vercel project as a server-side traffic source. Pulls request logs from Vercel\'s internal request-logs endpoint — no in-app instrumentation needed. Probes the endpoint with the supplied API token before persisting — a bad token or wrong project / team id surfaces as a 502 error. Reconnecting updates the existing active Vercel source in place. The API token is stored in ~/.canonry/config.yaml (not the DB) and never echoed back.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficConnectVercelInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/connect/vercel'],
    handler: (client, input) => client.trafficConnectVercel(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_traffic_sync',
    title: 'Sync Cloud Run traffic source',
    description: 'Pull the most recent Cloud Logging entries for a Cloud Run traffic source, classify them as crawler / AI-referral / unknown, and upsert hourly rollups + raw samples. Returns totals, bucket counts, and the run id. The window auto-clamps forward to lastSyncedAt to avoid double-counting on back-to-back calls.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficSyncInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/sync'],
    handler: (client, input) => client.trafficSync(input.project, input.sourceId, input.sinceMinutes !== undefined ? { sinceMinutes: input.sinceMinutes } : undefined),
  }),
  defineTool({
    name: 'canonry_traffic_backfill',
    title: 'Backfill Cloud Run traffic source',
    description: 'Async one-shot reclassification of historical Cloud Run logs. Pulls the last `days` of request logs (capped at the 30d Cloud Logging retention ceiling), classifies them with current rules, and replaces the hourly rollup buckets + sample slice in the window. Returns immediately with `{ runId, status: "running" }`; poll canonry_run_get for completion. lastSyncedAt only advances forward — a backfill never undoes incremental sync progress that ran ahead of it.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficBackfillInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/backfill'],
    handler: (client, input) => client.trafficBackfill(input.project, input.sourceId, input.days !== undefined ? { days: input.days } : undefined),
  }),
  defineTool({
    name: 'canonry_traffic_reset',
    title: 'Advance traffic source lastSyncedAt to NOW',
    description: 'Operator recovery for a stuck traffic source. Advances `lastSyncedAt` to NOW, sets `status` back to `connected`, and clears `last_error`. Accepts any non-archived source: the `lastSyncedAt` advance determines the next sync window for time-windowed sources (Vercel, Cloud Run); cursor-based sources (WordPress) keep their `last_cursor` so the advance is informational. Common trigger: an idle Vercel/Cloud Run source whose `lastSyncedAt` aged past the upstream retention boundary and every sync now throws a retention error. Historical events in the gap are unrecoverable from the sync path; run canonry_traffic_backfill separately if any of them are needed. Archived sources are rejected — re-connect via the appropriate canonry_traffic_connect_* tool instead.',
    access: 'write',
    tier: 'traffic',
    inputSchema: trafficResetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/traffic/sources/{id}/reset'],
    handler: (client, input) => client.trafficReset(input.project, input.sourceId),
  }),
  defineTool({
    name: 'canonry_project_upsert',
    title: 'Create or replace project',
    description: 'Create or replace a Canonry project. PUT semantics — fields not in the request are reset to their defaults. Provide the full intended project shape.',
    access: 'write',
    tier: 'setup',
    inputSchema: projectUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}'],
    handler: (client, input) => client.putProject(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_apply_config',
    title: 'Apply project config',
    description: 'Apply one Canonry config-as-code project document. Replaces the project to match the config — fields omitted from the spec are reset to defaults. For multi-document YAML, call this tool once per project document.',
    access: 'write',
    tier: 'core',
    inputSchema: applyConfigInputSchema,
    // Declarative apply is safe to repeat, but it replaces configured child state.
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/apply'],
    handler: (client, input) => client.apply(input.config),
  }),
  defineTool({
    name: 'canonry_queries_generate',
    title: 'Generate query suggestions',
    description: 'Generate candidate queries using a configured provider. Returns suggestions only; use canonry_queries_add to persist them.',
    access: 'write',
    tier: 'setup',
    inputSchema: queryGenerateInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/queries/generate'],
    handler: (client, input) => client.generateQueries(input.project, input.request.provider, input.request.count),
  }),
  defineTool({
    name: 'canonry_keywords_generate',
    title: 'Generate keyword suggestions (legacy alias)',
    description: 'Legacy alias for canonry_queries_generate. Returns suggestions using the pre-queries keyword response shape.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordGenerateInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/keywords/generate'],
    handler: (client, input) => client.generateKeywords(input.project, input.request.provider, input.request.count),
  }),
  defineTool({
    name: 'canonry_queries_replace',
    title: 'Replace queries',
    description: 'Replace the tracked query set for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.putQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_queries_replace_preview',
    title: 'Preview query replace',
    description: 'Preview the impact of replacing a project\'s tracked query set: current vs proposed, added/removed/unchanged diff, and the count of snapshots that would detach (queryId → NULL; queryText preserved). Read-only.',
    access: 'read',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['POST /api/v1/projects/{name}/queries/replace-preview'],
    handler: (client, input) => client.previewReplaceQueries(input.project, uniqueStrings(input.request.queries)),
  }),
  defineTool({
    name: 'canonry_keywords_replace',
    title: 'Replace keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_replace. Replaces the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.putKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_run_trigger',
    title: 'Trigger run',
    description: "Trigger an answer-visibility run for a Canonry project. Pass request.queries[] to scope the sweep to a subset of the project's tracked queries; omit for a full sweep. For verification scenarios (testing whether a provider migration worked, reproducing a regression, sanity-checking after a code change), set request.trigger='probe' — probe runs write a snapshot you can inspect via canonry_runs_get but are EXCLUDED from dashboard, analytics, intelligence, report, and notifications. Use 'probe' whenever you are testing on your own initiative rather than producing data the user/dashboard will consume.",
    access: 'write',
    tier: 'core',
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
    tier: 'core',
    inputSchema: runGetInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['POST /api/v1/runs/{id}/cancel'],
    handler: (client, input) => client.cancelRun(input.runId),
  }),
  defineTool({
    name: 'canonry_queries_add',
    title: 'Add queries',
    description: 'Append tracked queries to a Canonry project; existing queries are skipped by the API.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.appendQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_keywords_add',
    title: 'Add keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_add. Appends to the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
    inputSchema: keywordsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/keywords'],
    handler: async (client, input) => {
      await client.appendKeywords(input.project, uniqueStrings(input.request.keywords))
    },
  }),
  defineTool({
    name: 'canonry_queries_remove',
    title: 'Remove queries',
    description: 'Remove tracked queries from a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: queriesInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/queries'],
    handler: async (client, input) => {
      await client.deleteQueries(input.project, uniqueStrings(input.request.queries))
    },
  }),
  defineTool({
    name: 'canonry_keywords_remove',
    title: 'Remove keywords (legacy alias)',
    description: 'Legacy alias for canonry_queries_remove. Removes from the same canonical tracked query set.',
    access: 'write',
    tier: 'setup',
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
    tier: 'setup',
    inputSchema: competitorsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/competitors'],
    handler: async (client, input) => {
      await client.appendCompetitors(input.project, uniqueStrings(input.request.competitors))
    },
  }),
  defineTool({
    name: 'canonry_competitors_remove',
    title: 'Remove competitors',
    description: 'Remove tracked competitor domains from a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: competitorsInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/competitors'],
    handler: async (client, input) => {
      await client.deleteCompetitors(input.project, uniqueStrings(input.request.competitors))
    },
  }),
  defineTool({
    name: 'canonry_schedule_set',
    title: 'Set schedule',
    description: 'Create or replace the scheduled run configuration for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: scheduleSetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/schedule'],
    handler: (client, input) => client.putSchedule(input.project, input.schedule),
  }),
  defineTool({
    name: 'canonry_schedule_delete',
    title: 'Delete schedule',
    description: 'Delete the scheduled run configuration for a Canonry project. Pass `kind` to delete a non-default schedule (e.g. "traffic-sync"); defaults to "answer-visibility".',
    access: 'write',
    tier: 'setup',
    inputSchema: scheduleReadInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/schedule'],
    handler: async (client, input) => {
      await client.deleteSchedule(input.project, input.kind)
    },
  }),
  defineTool({
    name: 'canonry_insight_dismiss',
    title: 'Dismiss insight',
    description: 'Dismiss an intelligence insight for a Canonry project.',
    access: 'write',
    tier: 'setup',
    inputSchema: insightInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/insights/{id}/dismiss'],
    handler: (client, input) => client.dismissInsight(input.project, input.insightId),
  }),
  defineTool({
    name: 'canonry_memory_list',
    title: 'List agent memory',
    description: 'Read project-scoped durable notes Aero has stored via canonry_memory_set (plus compaction summaries). Returns entries newest-first. The N most-recent entries are also injected into the system prompt at session start, so you usually do not need to call this — reach for it when you need older context or the full note value.',
    access: 'read',
    tier: 'agent',
    inputSchema: projectInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.listAgentMemory(input.project),
  }),
  defineTool({
    name: 'canonry_memory_set',
    title: 'Upsert agent memory',
    description: 'Persist a project-scoped durable note visible to every future Aero session for this project. Upsert — writing the same key replaces the prior value. Capped at 2 KB per note. Reserved key prefix "compaction:" is rejected.',
    access: 'write',
    tier: 'agent',
    inputSchema: memoryUpsertInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['PUT /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.setAgentMemory(input.project, { key: input.key, value: input.value }),
  }),
  defineTool({
    name: 'canonry_memory_forget',
    title: 'Delete agent memory',
    description: 'Delete a durable note by key. Returns status="missing" (non-error) when the key did not exist. Reserved key prefix "compaction:" cannot be forgotten directly — those notes are pruned automatically.',
    access: 'write',
    tier: 'agent',
    inputSchema: memoryForgetInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/agent/memory'],
    handler: (client, input) => client.forgetAgentMemory(input.project, input.key),
  }),
  defineTool({
    name: 'canonry_agent_clear',
    title: 'Clear agent transcript',
    description: 'Clear the rolling Aero conversation for a project — wipes the transcript, the in-memory pending follow-up buffer, and the persisted follow-up queue. Memory entries (canonry_memory_*) are preserved. Use when starting a fresh dialogue or when the operator wants to reset context.',
    access: 'write',
    tier: 'agent',
    inputSchema: projectInputSchema,
    annotations: writeAnnotations({ idempotentHint: true, destructiveHint: true }),
    openApiOperations: ['DELETE /api/v1/projects/{name}/agent/transcript'],
    handler: async (client, input) => {
      await client.resetAgentTranscript(input.project)
      return { status: 'cleared' as const, project: input.project }
    },
  }),
  defineTool({
    name: 'canonry_agent_webhook_attach',
    title: 'Attach agent webhook',
    description: 'Attach an external agent webhook to project run and insight events.',
    access: 'write',
    tier: 'core',
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
    tier: 'agent',
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
  defineTool({
    name: 'canonry_discover_run_start',
    title: 'Start discovery run',
    description:
      'Kick off a discovery session for a project: ICP → seed (Gemini grounded prompt) → embed + cluster + pick representative → probe each canonical → classify into cited / aspirational / wasted-surface → aggregate competitor map. Returns {runId, sessionId, status:"running"} immediately; the work runs in the background. Poll canonry_discover_session_get with the returned sessionId until status is "completed" or "failed". Costs roughly $1 / session at default budget; budget capped at 500 probes / session.',
    access: 'write',
    tier: 'discovery',
    inputSchema: discoveryRunInputSchema,
    annotations: writeAnnotations({ idempotentHint: false, openWorldHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/discover/run'],
    handler: (client, input) => client.triggerDiscoveryRun(input.project, input.request),
  }),
  defineTool({
    name: 'canonry_discover_sessions_list',
    title: 'List discovery sessions',
    description: 'List recent discovery sessions for a project, newest first. Returns the session-level summary (status, seed counts, bucket counts, competitor map). Use canonry_discover_session_get to drill into per-query probe rows.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionsListInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions'],
    handler: (client, input) => client.listDiscoverySessions(input.project, input.limit !== undefined ? { limit: input.limit } : undefined),
  }),
  defineTool({
    name: 'canonry_discover_session_get',
    title: 'Get discovery session',
    description: 'Get one discovery session with the full probe list (per-query bucket + cited domains). Use after canonry_discover_run_start to inspect what the discovery pipeline produced; this is the canonical read for "what did discovery find" before calling canonry_discover_promote.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions/{id}'],
    handler: (client, input) => client.getDiscoverySession(input.project, input.sessionId),
  }),
  defineTool({
    name: 'canonry_discover_promote_preview',
    title: 'Preview discovery promotion',
    description: 'Read-only preview of available promotion candidates for a session: bucketed query lists and recurring suggested competitor domains not already in the project\'s tracked competitor list. Use it to confirm a basket before calling canonry_discover_promote.',
    access: 'read',
    tier: 'discovery',
    inputSchema: discoverySessionIdInputSchema,
    annotations: readAnnotations(),
    openApiOperations: ['GET /api/v1/projects/{name}/discover/sessions/{id}/promote'],
    handler: (client, input) => client.previewDiscoveryPromote(input.project, input.sessionId),
  }),
  defineTool({
    name: 'canonry_discover_promote',
    title: 'Promote discovery session',
    description: 'Adopt a completed discovery session\'s bucketed queries into the project\'s tracked basket, tagged with provenance "discovery:<sessionId>". By default, only cited + aspirational queries are promoted; include wasted-surface explicitly when off-ICP competitor gaps should also be tracked. Recurring discovered competitor domains classified as direct-competitor are also merged by default — pass request.competitorTypes to adopt editorial-media channels or recover legacy unknown entries. Add-only and idempotent: queries/domains already tracked are returned under `skipped`, never inserted twice. Only sessions with status "completed" can be promoted. Call canonry_discover_promote_preview first to inspect candidates.',
    access: 'write',
    tier: 'discovery',
    inputSchema: discoveryPromoteInputSchema,
    annotations: writeAnnotations({ idempotentHint: true }),
    openApiOperations: ['POST /api/v1/projects/{name}/discover/sessions/{id}/promote'],
    handler: (client, input) => client.promoteDiscovery(input.project, input.sessionId, input.request),
  }),
] as const

export const CANONRY_MCP_TOOL_COUNT = canonryMcpTools.length
export const CANONRY_MCP_READ_TOOL_COUNT = canonryMcpTools.filter(tool => tool.access === 'read').length
export const CANONRY_MCP_CORE_TOOL_COUNT = canonryMcpTools.filter(tool => tool.tier === 'core').length
