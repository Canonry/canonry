/**
 * Agent tools — canonry operations exposed as LLM-callable functions.
 *
 * Each tool wraps the ApiClient so the agent uses the same HTTP API
 * that CLI commands and the UI use. No direct DB access from tools.
 */

import type { ApiClient } from '../client.js'

export interface AgentTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<string>
}

export function buildTools(client: ApiClient, projectName: string): AgentTool[] {
  return [
    {
      name: 'get_status',
      description:
        'Get the current citation visibility status for this project. Returns domain, country, latest run info.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const project = await client.getProject(projectName)
        const runs = await client.listRuns(projectName)
        return JSON.stringify({ project, latestRuns: (runs as unknown[]).slice(-3) }, null, 2)
      },
    },
    {
      name: 'run_sweep',
      description:
        'Trigger a new visibility sweep across configured AI providers. Returns the run ID. Use this when the user wants fresh data.',
      parameters: {
        type: 'object',
        properties: {
          providers: {
            type: 'string',
            description: 'Comma-separated provider names to sweep. Omit for all configured providers.',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const body: Record<string, unknown> = {}
        if (args.providers) {
          body.providers = (args.providers as string).split(',').map(s => s.trim())
        }
        const run = await client.triggerRun(projectName, body)
        return JSON.stringify(run, null, 2)
      },
    },
    {
      name: 'get_evidence',
      description:
        'Get per-keyword citation evidence showing which providers cite this project and which competitors appear instead. This is the primary tool for understanding visibility.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const runs = await client.listRuns(projectName) as Array<{ id: string }>
        const latestRun = runs.at(-1)

        if (!latestRun) {
          return JSON.stringify({
            project: projectName,
            latestRun: null,
            snapshots: [],
          }, null, 2)
        }

        const run = await client.getRun(latestRun.id)
        return JSON.stringify(run, null, 2)
      },
    },
    {
      name: 'get_timeline',
      description:
        'Get the citation timeline showing how visibility has changed across runs over time. Use this to identify trends, regressions, or improvements.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const timeline = await client.getTimeline(projectName)
        return JSON.stringify(timeline, null, 2)
      },
    },
    {
      name: 'list_keywords',
      description: 'List all tracked keywords for this project.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const keywords = await client.listKeywords(projectName)
        return JSON.stringify(keywords, null, 2)
      },
    },
    {
      name: 'list_competitors',
      description: 'List tracked competitors for this project.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const competitors = await client.listCompetitors(projectName)
        return JSON.stringify(competitors, null, 2)
      },
    },
    {
      name: 'get_run_details',
      description: 'Get detailed results for a specific run by ID, including all snapshots.',
      parameters: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'The run ID to inspect.',
          },
        },
        required: ['runId'],
      },
      execute: async (args) => {
        const run = await client.getRun(args.runId as string)
        return JSON.stringify(run, null, 2)
      },
    },
    {
      name: 'get_gsc_performance',
      description:
        'Get Google Search Console performance data (clicks, impressions, CTR, position) for tracked keywords. Only works if GSC is connected.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'string',
            description: 'Number of days to look back (default: 28).',
          },
        },
        required: [],
      },
      execute: async (args) => {
        try {
          const params: Record<string, string> = {}
          if (args.days) params.days = args.days as string
          const perf = await client.gscPerformance(projectName, params)
          return JSON.stringify(perf, null, 2)
        } catch (err) {
          return `GSC not available: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
    {
      name: 'get_gsc_coverage',
      description:
        'Get index coverage summary from Google Search Console showing how many URLs are indexed, excluded, or errored.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        try {
          const coverage = await client.gscCoverage(projectName)
          return JSON.stringify(coverage, null, 2)
        } catch (err) {
          return `GSC not available: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
    {
      name: 'inspect_url',
      description:
        'Inspect a specific URL in Google Search Console to check indexing status, crawl info, and mobile-friendliness.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to inspect (e.g. https://example.com/page).',
          },
        },
        required: ['url'],
      },
      execute: async (args) => {
        try {
          const result = await client.gscInspect(projectName, args.url as string)
          return JSON.stringify(result, null, 2)
        } catch (err) {
          return `GSC inspect failed: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
  ]
}
