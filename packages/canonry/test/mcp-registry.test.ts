import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument } from '../../api-routes/src/openapi.js'
import { CliError } from '../src/cli-error.js'
import { ApiClient as RealApiClient, type ApiClient } from '../src/client.js'
import {
  CANONRY_MCP_READ_TOOL_COUNT,
  CANONRY_MCP_TOOL_COUNT,
  canonryMcpTools,
} from '../src/mcp/tool-registry.js'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'
import { createCanonryMcpServer, getCanonryMcpTools } from '../src/mcp/server.js'
import { withToolErrors } from '../src/mcp/results.js'

const expectedToolNames = [
  'canonry_projects_list',
  'canonry_project_get',
  'canonry_project_export',
  'canonry_project_history',
  'canonry_runs_list',
  'canonry_runs_latest',
  'canonry_run_get',
  'canonry_timeline_get',
  'canonry_snapshots_list',
  'canonry_snapshots_diff',
  'canonry_insights_list',
  'canonry_insight_get',
  'canonry_health_latest',
  'canonry_health_history',
  'canonry_keywords_list',
  'canonry_competitors_list',
  'canonry_schedule_get',
  'canonry_settings_get',
  'canonry_google_connections_list',
  'canonry_gsc_performance',
  'canonry_gsc_inspections',
  'canonry_gsc_deindexed',
  'canonry_gsc_coverage',
  'canonry_gsc_coverage_history',
  'canonry_gsc_sitemaps',
  'canonry_ga_status',
  'canonry_ga_traffic',
  'canonry_ga_coverage',
  'canonry_ga_ai_referral_history',
  'canonry_ga_social_referral_history',
  'canonry_ga_social_referral_trend',
  'canonry_ga_attribution_trend',
  'canonry_ga_session_history',
  'canonry_project_upsert',
  'canonry_apply_config',
  'canonry_keywords_generate',
  'canonry_keywords_replace',
  'canonry_run_trigger',
  'canonry_run_cancel',
  'canonry_keywords_add',
  'canonry_keywords_remove',
  'canonry_competitors_add',
  'canonry_competitors_remove',
  'canonry_schedule_set',
  'canonry_schedule_delete',
  'canonry_insight_dismiss',
  'canonry_agent_webhook_attach',
  'canonry_agent_webhook_detach',
] as const

describe('MCP tool registry', () => {
  it('ships the curated v1 surface', () => {
    expect(CANONRY_MCP_TOOL_COUNT).toBe(48)
    expect(CANONRY_MCP_READ_TOOL_COUNT).toBe(33)
    expect(canonryMcpTools.map(tool => tool.name)).toEqual(expectedToolNames)
    expect(getCanonryMcpTools('read-only').map(tool => tool.name)).toEqual(expectedToolNames.slice(0, 33))
  })

  it('generates JSON schema from every Zod input schema', () => {
    for (const tool of canonryMcpTools) {
      expect(tool.inputSchema).toBeTruthy()
      expect(tool.inputJsonSchema).toMatchObject({
        type: 'object',
        title: tool.name,
      })
      expect(tool.inputJsonSchema).not.toHaveProperty('$ref')
    }

    const projectSchema = inputSchemaFor('canonry_project_get')
    expect(projectSchema.required).toContain('project')
    expect(schemaProperty(projectSchema, 'project')).toMatchObject({
      type: 'string',
      minLength: 1,
      description: 'Canonry project name.',
    })

    const runTriggerRequest = schemaProperty(inputSchemaFor('canonry_run_trigger'), 'request')
    expect(schemaProperty(runTriggerRequest, 'kind')).toMatchObject({ const: 'answer-visibility' })
    expect(schemaProperty(runTriggerRequest, 'trigger')).toMatchObject({ const: 'manual' })
    expect(runTriggerRequest.required ?? []).not.toContain('kind')
    expect(runTriggerRequest.required ?? []).not.toContain('trigger')

    expect(schemaProperty(inputSchemaFor('canonry_runs_list'), 'limit')).toMatchObject({
      type: 'integer',
      maximum: 500,
    })
  })

  it('limits MCP run trigger input to manual answer-visibility runs', () => {
    const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_run_trigger')
    expect(tool).toBeTruthy()

    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { kind: 'ga-sync' } })).toThrow()
    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { trigger: 'scheduled' } })).toThrow()
    expect(() => tool!.inputSchema.parse({ project: 'acme', request: { kind: 'answer-visibility', trigger: 'manual' } })).not.toThrow()
  })

  it('trims batch write strings before handlers receive them', () => {
    const keywordsTool = canonryMcpTools.find(candidate => candidate.name === 'canonry_keywords_add')
    const competitorsTool = canonryMcpTools.find(candidate => candidate.name === 'canonry_competitors_add')
    expect(keywordsTool).toBeTruthy()
    expect(competitorsTool).toBeTruthy()

    expect(keywordsTool!.inputSchema.parse({ project: 'acme', request: { keywords: [' alpha '] } })).toEqual({
      project: 'acme',
      request: { keywords: ['alpha'] },
    })
    expect(() => keywordsTool!.inputSchema.parse({ project: 'acme', request: { keywords: ['  '] } })).toThrow()
    expect(competitorsTool!.inputSchema.parse({ project: 'acme', request: { competitors: [' rival.example.com '] } })).toEqual({
      project: 'acme',
      request: { competitors: ['rival.example.com'] },
    })
  })

  it('creates one API client per MCP server instance', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let factoryCalls = 0
    createCanonryMcpServer({
      clientFactory: () => {
        factoryCalls += 1
        return makeClient(calls)
      },
    })

    expect(factoryCalls).toBe(1)
  })

  it('sets write annotations from the audit table', () => {
    const annotations = Object.fromEntries(
      canonryMcpTools
        .filter(tool => tool.access === 'write')
        .map(tool => [tool.name, tool.annotations]),
    )

    expect(annotations.canonry_run_trigger).toMatchObject({ idempotentHint: false, destructiveHint: false })
    expect(annotations.canonry_run_cancel).toMatchObject({ idempotentHint: false, destructiveHint: true })
    expect(annotations.canonry_project_upsert).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_apply_config).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_keywords_generate).toMatchObject({ idempotentHint: false, destructiveHint: false })
    expect(annotations.canonry_keywords_replace).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_keywords_add).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_keywords_remove).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_competitors_add).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_competitors_remove).toMatchObject({ idempotentHint: true, destructiveHint: true })
    expect(annotations.canonry_schedule_set).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_schedule_delete).toMatchObject({ idempotentHint: false, destructiveHint: true })
    expect(annotations.canonry_insight_dismiss).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_agent_webhook_attach).toMatchObject({ idempotentHint: true, destructiveHint: false })
    expect(annotations.canonry_agent_webhook_detach).toMatchObject({ idempotentHint: true, destructiveHint: true })
  })

  it('classifies every OpenAPI operation for MCP coverage drift', () => {
    const doc = buildOpenApiDocument({ includeCanonryLocal: true })
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods as Record<string, unknown>).map(method => `${method.toUpperCase()} ${path}`),
    )

    expect(operations.sort()).toEqual(Object.keys(MCP_OPENAPI_OPERATION_CLASSIFICATIONS).sort())

    const referencedOperations = new Set(canonryMcpTools.flatMap(tool => tool.openApiOperations))
    const includedOperations = Object.entries(MCP_OPENAPI_OPERATION_CLASSIFICATIONS)
      .filter(([, classification]) => classification === 'included')
      .map(([operation]) => operation)

    expect([...referencedOperations].sort()).toEqual(expect.arrayContaining(includedOperations.sort()))
  })

  it('maps Canonry client errors to isError tool results', async () => {
    const result = await withToolErrors(async () => {
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      })
    })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project' },
      },
    })
  })

  it('preserves API error details in MCP tool errors', async () => {
    const api = await startErrorApi()
    try {
      const client = new RealApiClient(api.origin, 'cnry_test', { skipProbe: true })
      const result = await withToolErrors(() => client.getProject('acme'))

      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}')).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'bad input',
          details: {
            field: 'project',
            reason: 'missing',
            httpStatus: 400,
          },
        },
      })
    } finally {
      await api.close()
    }
  })
})

describe('MCP tool handlers', () => {
  it('calls the expected ApiClient method for every tool', async () => {
    for (const testCase of handlerCases) {
      const calls: Array<{ method: string; args: unknown[] }> = []
      const client = makeClient(calls, testCase.fixture)
      const tool = canonryMcpTools.find(candidate => candidate.name === testCase.tool)
      expect(tool, testCase.tool).toBeTruthy()
      await tool!.handler(client, testCase.input)
      expect(calls.map(call => call.method)).toEqual(testCase.methods)
    }
  })
})

type HandlerCase = {
  tool: string
  input: Record<string, unknown>
  methods: string[]
  fixture?: 'agent-notification'
}

const projectInput = { project: 'acme' }

const handlerCases: HandlerCase[] = [
  { tool: 'canonry_projects_list', input: {}, methods: ['listProjects'] },
  { tool: 'canonry_project_get', input: projectInput, methods: ['getProject'] },
  { tool: 'canonry_project_export', input: projectInput, methods: ['getExport'] },
  { tool: 'canonry_project_history', input: projectInput, methods: ['getHistory'] },
  { tool: 'canonry_runs_list', input: { project: 'acme', limit: 5 }, methods: ['listRuns'] },
  { tool: 'canonry_runs_latest', input: projectInput, methods: ['getLatestRun'] },
  { tool: 'canonry_run_get', input: { runId: 'run-1' }, methods: ['getRun'] },
  { tool: 'canonry_timeline_get', input: { project: 'acme', location: 'nyc' }, methods: ['getTimeline'] },
  { tool: 'canonry_snapshots_list', input: { project: 'acme', limit: 5 }, methods: ['getSnapshots'] },
  { tool: 'canonry_snapshots_diff', input: { project: 'acme', run1: 'run-1', run2: 'run-2' }, methods: ['getSnapshotDiff'] },
  { tool: 'canonry_insights_list', input: { project: 'acme', dismissed: true }, methods: ['getInsights'] },
  { tool: 'canonry_insight_get', input: { project: 'acme', insightId: 'insight-1' }, methods: ['getInsight'] },
  { tool: 'canonry_health_latest', input: projectInput, methods: ['getHealth'] },
  { tool: 'canonry_health_history', input: { project: 'acme', limit: 10 }, methods: ['getHealthHistory'] },
  { tool: 'canonry_keywords_list', input: projectInput, methods: ['listKeywords'] },
  { tool: 'canonry_competitors_list', input: projectInput, methods: ['listCompetitors'] },
  { tool: 'canonry_schedule_get', input: projectInput, methods: ['getSchedule'] },
  { tool: 'canonry_settings_get', input: {}, methods: ['getSettings'] },
  { tool: 'canonry_google_connections_list', input: projectInput, methods: ['googleConnections'] },
  { tool: 'canonry_gsc_performance', input: { project: 'acme', window: '30d' }, methods: ['gscPerformance'] },
  { tool: 'canonry_gsc_inspections', input: { project: 'acme', limit: 5 }, methods: ['gscInspections'] },
  { tool: 'canonry_gsc_deindexed', input: projectInput, methods: ['gscDeindexed'] },
  { tool: 'canonry_gsc_coverage', input: projectInput, methods: ['gscCoverage'] },
  { tool: 'canonry_gsc_coverage_history', input: { project: 'acme', limit: 5 }, methods: ['gscCoverageHistory'] },
  { tool: 'canonry_gsc_sitemaps', input: projectInput, methods: ['gscSitemaps'] },
  { tool: 'canonry_ga_status', input: projectInput, methods: ['gaStatus'] },
  { tool: 'canonry_ga_traffic', input: { project: 'acme', limit: 5 }, methods: ['gaTraffic'] },
  { tool: 'canonry_ga_coverage', input: projectInput, methods: ['gaCoverage'] },
  { tool: 'canonry_ga_ai_referral_history', input: { project: 'acme', window: '7d' }, methods: ['gaAiReferralHistory'] },
  { tool: 'canonry_ga_social_referral_history', input: { project: 'acme', window: '7d' }, methods: ['gaSocialReferralHistory'] },
  { tool: 'canonry_ga_social_referral_trend', input: projectInput, methods: ['gaSocialReferralTrend'] },
  { tool: 'canonry_ga_attribution_trend', input: projectInput, methods: ['gaAttributionTrend'] },
  { tool: 'canonry_ga_session_history', input: { project: 'acme', window: '7d' }, methods: ['gaSessionHistory'] },
  {
    tool: 'canonry_project_upsert',
    input: {
      project: 'acme',
      request: {
        displayName: 'Acme',
        canonicalDomain: 'acme.example.com',
        country: 'US',
        language: 'en',
      },
    },
    methods: ['putProject'],
  },
  {
    tool: 'canonry_apply_config',
    input: {
      config: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'acme' },
        spec: {
          displayName: 'Acme',
          canonicalDomain: 'acme.example.com',
          country: 'US',
          language: 'en',
        },
      },
    },
    methods: ['apply'],
  },
  { tool: 'canonry_keywords_generate', input: { project: 'acme', request: { provider: 'gemini', count: 3 } }, methods: ['generateKeywords'] },
  { tool: 'canonry_keywords_replace', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['putKeywords'] },
  { tool: 'canonry_run_trigger', input: { project: 'acme', request: { providers: ['gemini'] } }, methods: ['triggerRun'] },
  { tool: 'canonry_run_cancel', input: { runId: 'run-1' }, methods: ['cancelRun'] },
  { tool: 'canonry_keywords_add', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['appendKeywords'] },
  { tool: 'canonry_keywords_remove', input: { project: 'acme', request: { keywords: ['alpha'] } }, methods: ['deleteKeywords'] },
  { tool: 'canonry_competitors_add', input: { project: 'acme', request: { competitors: ['other.example.com'] } }, methods: ['appendCompetitors'] },
  { tool: 'canonry_competitors_remove', input: { project: 'acme', request: { competitors: ['other.example.com'] } }, methods: ['deleteCompetitors'] },
  { tool: 'canonry_schedule_set', input: { project: 'acme', schedule: { preset: 'daily', timezone: 'UTC' } }, methods: ['putSchedule'] },
  { tool: 'canonry_schedule_delete', input: projectInput, methods: ['deleteSchedule'] },
  { tool: 'canonry_insight_dismiss', input: { project: 'acme', insightId: 'insight-1' }, methods: ['dismissInsight'] },
  { tool: 'canonry_agent_webhook_attach', input: { project: 'acme', url: 'https://agent.example.com/hook' }, methods: ['listNotifications', 'createNotification'] },
  { tool: 'canonry_agent_webhook_detach', input: projectInput, methods: ['listNotifications', 'deleteNotification'], fixture: 'agent-notification' },
]

function makeClient(calls: Array<{ method: string; args: unknown[] }>, fixture?: 'agent-notification'): ApiClient {
  const notifications = fixture === 'agent-notification'
    ? [{ id: 'notif-1', source: 'agent' }]
    : []
  const client = new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const method = String(property)
        calls.push({ method, args })
        if (method === 'listCompetitors') return [{ id: 'c1', domain: 'rival.example.com', createdAt: '2026-04-27T00:00:00Z' }]
        if (method === 'listNotifications') return notifications
        if (method === 'createNotification') return { id: 'notif-new', source: 'agent' }
        return { ok: true, method }
      }
    },
  })
  return client as unknown as ApiClient
}

type JsonSchemaObject = {
  type?: string
  title?: string
  minLength?: number
  description?: string
  enum?: unknown[]
  const?: unknown
  maximum?: number
  required?: string[]
  properties?: Record<string, JsonSchemaObject>
}

function inputSchemaFor(name: string): JsonSchemaObject {
  const tool = canonryMcpTools.find(candidate => candidate.name === name)
  expect(tool).toBeTruthy()
  return tool!.inputJsonSchema as JsonSchemaObject
}

function schemaProperty(schema: JsonSchemaObject, key: string): JsonSchemaObject {
  const property = schema.properties?.[key]
  expect(property, key).toBeTruthy()
  return property!
}

async function startErrorApi(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response: ServerResponse) => {
    sendJson(response, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        details: { field: 'project', reason: 'missing' },
      },
    }, 400)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start stub API')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
