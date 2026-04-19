import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  AGENT_MEMORY_KEY_MAX_LENGTH,
  AGENT_MEMORY_VALUE_MAX_BYTES,
  MemorySources,
} from '@ainyc/canonry-contracts'
import type { ApiClient } from '../client.js'
import {
  COMPACTION_KEY_PREFIX,
  deleteMemoryEntry,
  listMemoryEntries,
  upsertMemoryEntry,
} from './memory-store.js'

const MAX_TOOL_RESULT_CHARS = 20_000

function truncate(json: string): string {
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json
  return json.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... (truncated — result too large)'
}

function textResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: truncate(JSON.stringify(details, null, 2)) }],
    details,
  }
}

export interface ToolContext {
  client: ApiClient
  projectName: string
  db: DatabaseClient
  projectId: string
}

const StatusSchema = Type.Object({
  runLimit: Type.Optional(
    Type.Number({
      description: 'Max recent runs to include. Default 5.',
      minimum: 1,
      maximum: 50,
    }),
  ),
})

function buildGetStatusTool(ctx: ToolContext): AgentTool<typeof StatusSchema> {
  return {
    name: 'get_status',
    label: 'Get status',
    description: 'Current project overview with its most recent runs.',
    parameters: StatusSchema,
    execute: async (_toolCallId, params) => {
      const runLimit = params.runLimit ?? 5
      const [project, runs] = await Promise.all([
        ctx.client.getProject(ctx.projectName),
        ctx.client.listRuns(ctx.projectName, runLimit),
      ])
      return textResult({ project, runs })
    },
  }
}

const HealthSchema = Type.Object({})

function buildGetHealthTool(ctx: ToolContext): AgentTool<typeof HealthSchema> {
  return {
    name: 'get_health',
    label: 'Get health',
    description:
      'Latest visibility health snapshot including overall cited rate, pair counts, and per-provider breakdown.',
    parameters: HealthSchema,
    execute: async () => {
      const health = await ctx.client.getHealth(ctx.projectName)
      return textResult(health)
    },
  }
}

const TimelineSchema = Type.Object({
  keyword: Type.Optional(
    Type.String({
      description: 'Restrict the timeline to a single keyword. Omit to return all keywords.',
    }),
  ),
})

function buildGetTimelineTool(ctx: ToolContext): AgentTool<typeof TimelineSchema> {
  return {
    name: 'get_timeline',
    label: 'Get timeline',
    description:
      'Per-keyword citation timeline showing how visibility evolved across runs. Use to identify regressions, emerging citations, or competitor movement.',
    parameters: TimelineSchema,
    execute: async (_toolCallId, params) => {
      const timeline = await ctx.client.getTimeline(ctx.projectName)
      const filtered = params.keyword
        ? timeline.filter((row) => row.keyword === params.keyword)
        : timeline
      return textResult(filtered)
    },
  }
}

const InsightsSchema = Type.Object({
  includeDismissed: Type.Optional(
    Type.Boolean({
      description: 'Include dismissed insights. Default false (only active insights).',
    }),
  ),
  runId: Type.Optional(
    Type.String({
      description: 'Restrict insights to a specific run id. Omit for all runs.',
    }),
  ),
})

function buildGetInsightsTool(ctx: ToolContext): AgentTool<typeof InsightsSchema> {
  return {
    name: 'get_insights',
    label: 'Get insights',
    description:
      'Insights produced by the canonry intelligence engine — regressions, gains, and opportunities with cause/recommendation metadata. Query this before re-deriving conclusions from raw timeline data.',
    parameters: InsightsSchema,
    execute: async (_toolCallId, params) => {
      const insights = await ctx.client.getInsights(ctx.projectName, {
        dismissed: params.includeDismissed,
        runId: params.runId,
      })
      return textResult(insights)
    },
  }
}

const KeywordsSchema = Type.Object({})

function buildListKeywordsTool(ctx: ToolContext): AgentTool<typeof KeywordsSchema> {
  return {
    name: 'list_keywords',
    label: 'List keywords',
    description: 'All keywords currently tracked for this project.',
    parameters: KeywordsSchema,
    execute: async () => {
      const keywords = await ctx.client.listKeywords(ctx.projectName)
      return textResult(keywords)
    },
  }
}

const CompetitorsSchema = Type.Object({})

function buildListCompetitorsTool(ctx: ToolContext): AgentTool<typeof CompetitorsSchema> {
  return {
    name: 'list_competitors',
    label: 'List competitors',
    description: 'Competitor domains tracked alongside this project for side-by-side comparison.',
    parameters: CompetitorsSchema,
    execute: async () => {
      const competitors = await ctx.client.listCompetitors(ctx.projectName)
      return textResult(competitors)
    },
  }
}

const RunDetailSchema = Type.Object({
  runId: Type.String({
    description: 'Run id (UUID) to fetch. Typically obtained from get_status runs[].id.',
  }),
})

function buildGetRunTool(ctx: ToolContext): AgentTool<typeof RunDetailSchema> {
  return {
    name: 'get_run',
    label: 'Get run detail',
    description:
      'Full detail for a specific run including per-keyword snapshots, error messages, and provider breakdown. Use to investigate failed runs or drill into a particular sweep.',
    parameters: RunDetailSchema,
    execute: async (_toolCallId, params) => {
      const run = await ctx.client.getRun(params.runId)
      return textResult(run)
    },
  }
}

const BacklinksSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({
      description: 'Max linking-domain rows to include. Default 50, max 200.',
      minimum: 1,
      maximum: 200,
    }),
  ),
  release: Type.Optional(
    Type.String({
      description: 'Common Crawl release id (e.g., cc-main-2026-jan-feb-mar). Omit for the most recent release with data.',
    }),
  ),
})

function buildListBacklinksTool(ctx: ToolContext): AgentTool<typeof BacklinksSchema> {
  return {
    name: 'list_backlinks',
    label: 'List backlinks',
    description:
      'Backlink summary and top linking domains from the most recent ready Common Crawl release. Off-site authority signal that correlates with citation likelihood. Returns null summary when no release sync has completed for this workspace.',
    parameters: BacklinksSchema,
    execute: async (_toolCallId, params) => {
      const response = await ctx.client.backlinksDomains(ctx.projectName, {
        limit: params.limit ?? 50,
        release: params.release,
      })
      return textResult(response)
    },
  }
}

const RecallSchema = Type.Object({
  limit: Type.Optional(
    Type.Number({
      description: 'Max notes to return, ordered newest-first. Default 50. Max 100.',
      minimum: 1,
      maximum: 100,
    }),
  ),
})

function buildRecallTool(ctx: ToolContext): AgentTool<typeof RecallSchema> {
  return {
    name: 'recall',
    label: 'Recall memory',
    description:
      'Read project-scoped durable notes Aero has stored via `remember` (plus compaction summaries). Returns entries newest-first. The N most-recent entries are also injected into the system prompt at session start, so you usually do not need to call this — reach for it when you need older context or the full note value.',
    parameters: RecallSchema,
    execute: async (_toolCallId, params) => {
      const entries = listMemoryEntries(ctx.db, ctx.projectId, { limit: params.limit ?? 50 })
      return textResult({ entries })
    },
  }
}

/** Read-only Aero tools — fetch canonry state + recall durable notes. Does not mutate anything. */
export function buildReadTools(ctx: ToolContext): AgentTool[] {
  return [
    buildGetStatusTool(ctx) as unknown as AgentTool,
    buildGetHealthTool(ctx) as unknown as AgentTool,
    buildGetTimelineTool(ctx) as unknown as AgentTool,
    buildGetInsightsTool(ctx) as unknown as AgentTool,
    buildListKeywordsTool(ctx) as unknown as AgentTool,
    buildListCompetitorsTool(ctx) as unknown as AgentTool,
    buildGetRunTool(ctx) as unknown as AgentTool,
    buildRecallTool(ctx) as unknown as AgentTool,
    buildListBacklinksTool(ctx) as unknown as AgentTool,
  ]
}

// ═══════════════════════════════════════════════════════════════════
// Write tools — mutate canonry state.
//
// Intentionally additive-only for now: tools can create/append but not
// delete or replace. Aero should recommend removals in prose, not enact
// them. Write-tool calls surface via tool_execution_start events so the
// user sees exactly what fired in CLI / UI output.
// ═══════════════════════════════════════════════════════════════════

const RunSweepSchema = Type.Object({
  providers: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Subset of providers to run. Omit to use every configured provider on the project.',
    }),
  ),
  noLocation: Type.Optional(
    Type.Boolean({
      description: 'Run without a location context. Default: use the project default location.',
    }),
  ),
})

function buildRunSweepTool(ctx: ToolContext): AgentTool<typeof RunSweepSchema> {
  return {
    name: 'run_sweep',
    label: 'Trigger sweep',
    description:
      'Trigger a new answer-visibility sweep for this project across configured AI providers. Returns the run id(s). Use when fresh citation data is needed.',
    parameters: RunSweepSchema,
    execute: async (_toolCallId, params) => {
      const body: Record<string, unknown> = {}
      if (params.providers?.length) body.providers = params.providers
      if (params.noLocation) body.noLocation = true
      const result = await ctx.client.triggerRun(ctx.projectName, body)
      return textResult(result)
    },
  }
}

const DismissInsightSchema = Type.Object({
  insightId: Type.String({
    description: 'Insight id to dismiss. Obtain from get_insights details[].id.',
  }),
})

function buildDismissInsightTool(ctx: ToolContext): AgentTool<typeof DismissInsightSchema> {
  return {
    name: 'dismiss_insight',
    label: 'Dismiss insight',
    description:
      'Mark an insight as dismissed so it no longer surfaces in active insight lists. Reversible via the dashboard.',
    parameters: DismissInsightSchema,
    execute: async (_toolCallId, params) => {
      const result = await ctx.client.dismissInsight(ctx.projectName, params.insightId)
      return textResult(result)
    },
  }
}

const AddKeywordsSchema = Type.Object({
  keywords: Type.Array(Type.String(), {
    minItems: 1,
    description: 'Keywords to add to the tracking list. Duplicates against existing keywords are ignored server-side.',
  }),
})

function buildAddKeywordsTool(ctx: ToolContext): AgentTool<typeof AddKeywordsSchema> {
  return {
    name: 'add_keywords',
    label: 'Add keywords',
    description:
      'Append keywords to the project tracking list. Additive only — existing keywords are preserved. Use exact phrasing you want tracked.',
    parameters: AddKeywordsSchema,
    execute: async (_toolCallId, params) => {
      await ctx.client.appendKeywords(ctx.projectName, params.keywords)
      return textResult({ added: params.keywords })
    },
  }
}

const AddCompetitorsSchema = Type.Object({
  domains: Type.Array(Type.String(), {
    minItems: 1,
    description: 'Competitor domains to track. Provide bare domains (e.g. "example.com"), not URLs.',
  }),
})

function buildAddCompetitorsTool(ctx: ToolContext): AgentTool<typeof AddCompetitorsSchema> {
  return {
    name: 'add_competitors',
    label: 'Add competitors',
    description:
      'Append competitor domains to the project. Fetches the current set, merges with the requested domains (dedup on exact domain match), and persists the combined list.',
    parameters: AddCompetitorsSchema,
    execute: async (_toolCallId, params) => {
      const existing = await ctx.client.listCompetitors(ctx.projectName)
      const existingDomains = new Set(existing.map((c) => c.domain))
      const newDomains = params.domains.filter((d) => !existingDomains.has(d))
      if (newDomains.length === 0) {
        return textResult({ added: [], alreadyTracked: params.domains })
      }
      const merged = [...existing.map((c) => c.domain), ...newDomains]
      await ctx.client.putCompetitors(ctx.projectName, merged)
      return textResult({ added: newDomains, alreadyTracked: params.domains.filter((d) => existingDomains.has(d)) })
    },
  }
}

const UpdateScheduleSchema = Type.Object({
  cron: Type.Optional(
    Type.String({ description: 'Cron expression (e.g. "0 */6 * * *"). Provide cron OR preset, not both.' }),
  ),
  preset: Type.Optional(
    Type.String({ description: 'Preset keyword (e.g. "daily", "hourly"). Provide cron OR preset, not both.' }),
  ),
  timezone: Type.Optional(Type.String({ description: 'IANA timezone. Default: "UTC".' })),
  enabled: Type.Optional(
    Type.Boolean({ description: 'Whether the schedule is active. Default: true.' }),
  ),
  providers: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Providers to run on each scheduled sweep. Omit to use all configured providers.',
    }),
  ),
})

function buildUpdateScheduleTool(ctx: ToolContext): AgentTool<typeof UpdateScheduleSchema> {
  return {
    name: 'update_schedule',
    label: 'Update schedule',
    description:
      'Create or update the recurring sweep schedule for this project. Provide exactly one of `cron` (expression) or `preset` (keyword). Fully replaces any existing schedule.',
    parameters: UpdateScheduleSchema,
    execute: async (_toolCallId, params) => {
      if ((params.cron && params.preset) || (!params.cron && !params.preset)) {
        throw new Error('update_schedule: provide exactly one of `cron` or `preset`')
      }
      const body: Record<string, unknown> = {}
      if (params.cron) body.cron = params.cron
      if (params.preset) body.preset = params.preset
      if (params.timezone) body.timezone = params.timezone
      if (params.enabled !== undefined) body.enabled = params.enabled
      if (params.providers?.length) body.providers = params.providers
      const result = await ctx.client.putSchedule(ctx.projectName, body)
      return textResult(result)
    },
  }
}

const AttachAgentWebhookSchema = Type.Object({
  url: Type.String({
    description: 'External agent webhook URL. Canonry will POST run.completed, insight.critical, insight.high, and citation.gained events to it.',
  }),
})

function buildAttachAgentWebhookTool(ctx: ToolContext): AgentTool<typeof AttachAgentWebhookSchema> {
  return {
    name: 'attach_agent_webhook',
    label: 'Attach agent webhook',
    description:
      'Register an external agent webhook for this project. Use when wiring a Claude Code / Codex / custom agent to receive canonry run and insight events. Idempotent — skips if one already exists.',
    parameters: AttachAgentWebhookSchema,
    execute: async (_toolCallId, params) => {
      const existing = await ctx.client.listNotifications(ctx.projectName)
      const hasAgent = existing.some((n) => n.source === 'agent')
      if (hasAgent) {
        return textResult({ status: 'already-attached' })
      }
      const result = await ctx.client.createNotification(ctx.projectName, {
        channel: 'webhook',
        url: params.url,
        events: ['run.completed', 'insight.critical', 'insight.high', 'citation.gained'],
        source: 'agent',
      })
      return textResult({ status: 'attached', notificationId: result.id, url: params.url })
    },
  }
}

const RememberSchema = Type.Object({
  key: Type.String({
    description: `Stable identifier for this note (max ${AGENT_MEMORY_KEY_MAX_LENGTH} chars). Writing the same key overwrites the prior value. Do NOT use the "${COMPACTION_KEY_PREFIX}" prefix — that namespace is reserved for transcript compaction summaries.`,
    minLength: 1,
    maxLength: AGENT_MEMORY_KEY_MAX_LENGTH,
  }),
  value: Type.String({
    description: `Plain-text note to persist (max ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes). Use for durable operator preferences, migration context, or non-obvious reasoning you'll want on a future turn. Do NOT duplicate data canonry already tracks (runs, insights, timelines) — query those instead.`,
    minLength: 1,
  }),
})

function buildRememberTool(ctx: ToolContext): AgentTool<typeof RememberSchema> {
  return {
    name: 'remember',
    label: 'Remember',
    description:
      'Persist a project-scoped durable note visible to every future Aero session for this project. Upsert — writing the same key replaces the prior value. Capped at 2 KB per note.',
    parameters: RememberSchema,
    execute: async (_toolCallId, params) => {
      const entry = upsertMemoryEntry(ctx.db, {
        projectId: ctx.projectId,
        key: params.key,
        value: params.value,
        source: MemorySources.aero,
      })
      return textResult({ status: 'remembered', entry })
    },
  }
}

const ForgetSchema = Type.Object({
  key: Type.String({
    description: 'Exact key of the note to remove. No-op (status=missing) when no note exists for that key.',
    minLength: 1,
    maxLength: AGENT_MEMORY_KEY_MAX_LENGTH,
  }),
})

function buildForgetTool(ctx: ToolContext): AgentTool<typeof ForgetSchema> {
  return {
    name: 'forget',
    label: 'Forget',
    description:
      'Delete a durable note by key. Use when a previously-remembered fact is wrong or no longer relevant.',
    parameters: ForgetSchema,
    execute: async (_toolCallId, params) => {
      if (params.key.startsWith(COMPACTION_KEY_PREFIX)) {
        throw new Error(
          `cannot forget compaction notes directly — they are pruned automatically (key prefix "${COMPACTION_KEY_PREFIX}" is reserved)`,
        )
      }
      const removed = deleteMemoryEntry(ctx.db, ctx.projectId, params.key)
      return textResult({ status: removed ? 'forgotten' : 'missing', key: params.key })
    },
  }
}

/** Write tools — mutate canonry state. Additive-only (memory upsert/delete included). */
export function buildWriteTools(ctx: ToolContext): AgentTool[] {
  return [
    buildRunSweepTool(ctx) as unknown as AgentTool,
    buildDismissInsightTool(ctx) as unknown as AgentTool,
    buildAddKeywordsTool(ctx) as unknown as AgentTool,
    buildAddCompetitorsTool(ctx) as unknown as AgentTool,
    buildUpdateScheduleTool(ctx) as unknown as AgentTool,
    buildAttachAgentWebhookTool(ctx) as unknown as AgentTool,
    buildRememberTool(ctx) as unknown as AgentTool,
    buildForgetTool(ctx) as unknown as AgentTool,
  ]
}

/** Full tool set — reads + writes. Use when wiring a session that should act as well as read. */
export function buildAllTools(ctx: ToolContext): AgentTool[] {
  return [...buildReadTools(ctx), ...buildWriteTools(ctx)]
}
