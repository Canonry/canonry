import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ApiClient } from '../client.js'

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

/** Read-only Aero tools — fetch canonry state. Does not mutate anything. */
export function buildReadTools(ctx: ToolContext): AgentTool[] {
  return [
    buildGetStatusTool(ctx) as unknown as AgentTool,
    buildGetHealthTool(ctx) as unknown as AgentTool,
    buildGetTimelineTool(ctx) as unknown as AgentTool,
  ]
}
