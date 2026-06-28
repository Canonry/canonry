import { describe, it, expect } from 'vitest'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { CanonryMcpToolNames, canonryMcpTools } from '../src/mcp/tool-registry.js'
import {
  AERO_EXCLUDED_MCP_TOOLS,
  buildMcpAgentTools,
  mcpToAgentTool,
} from '../src/agent/mcp-to-agent-tool.js'
import {
  AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME,
  AERO_ADS_OPERATOR_MCP_TOOL_NAMES,
  AeroToolScopes,
  buildAdsOperatorTools,
  buildAllTools,
  buildAeroStateTools,
  buildReadTools,
  type ToolContext,
} from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'

interface CallLog {
  method: string
  args: unknown[]
}

function recordingClient(calls: CallLog[]): ApiClient {
  return new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const method = String(property)
        calls.push({ method, args })
        if (method === 'getProject') return { name: args[0], canonicalDomain: 'demo.example.com' }
        if (method === 'getProjectOverview') {
          return {
            project: { name: args[0], canonicalDomain: 'demo.example.com' },
            latestRun: null,
            health: null,
            scores: {},
            queryCounts: {},
            providers: [],
            citationMovement: {},
            mentionMovement: {},
            movementComparison: {},
            topInsights: [],
            attentionItems: [],
            competitors: [],
            contextLabel: 'All locations',
            dateRangeLabel: 'All time',
          }
        }
        if (method === 'getAdsStatus') return { connected: true, adAccountId: 'acct_1', lastSyncedAt: '2026-06-28T00:00:00Z' }
        if (method === 'getAdsSummary') {
          return {
            connected: true,
            displayName: 'Demo ads',
            currencyCode: 'USD',
            lastSyncedAt: '2026-06-28T00:00:00Z',
            campaignCount: 1,
            adGroupCount: 1,
            adCount: 1,
            window: { from: '2026-06-01', to: '2026-06-28' },
            totals: { impressions: 100, clicks: 10, spendMicros: 1_000_000, conversions: 1, ctr: 0.1, cpcMicros: 100_000 },
          }
        }
        if (method === 'getAdsCampaigns') {
          return {
            campaigns: [{
              id: 'camp_1',
              name: 'High intent',
              status: 'active',
              biddingType: 'cpc',
              dailySpendLimitMicros: 5_000_000,
              lifetimeSpendLimitMicros: null,
              adGroups: [{
                id: 'ag_1',
                campaignId: 'camp_1',
                name: 'Branded alternatives',
                status: 'active',
                billingEventType: 'click',
                maxBidMicros: 250_000,
                contextHints: ['best demo software\ncanonry alternative'],
                ads: [{
                  id: 'ad_1',
                  adGroupId: 'ag_1',
                  name: 'Primary',
                  status: 'active',
                  reviewStatus: 'approved',
                  creative: { title: 'Demo', body: 'Try demo', targetUrl: 'https://demo.example.com' },
                }],
              }],
            }],
          }
        }
        if (method === 'getAdsInsights') {
          return {
            currencyCode: 'USD',
            rows: [{
              level: args[1]?.level ?? 'campaign',
              entityId: 'camp_1',
              date: '2026-06-28',
              impressions: 100,
              clicks: 10,
              spendMicros: 1_000_000,
              conversions: 1,
              ctr: 0.1,
              cpcMicros: 100_000,
            }],
          }
        }
        if (method === 'runDoctor') return { status: 'ok', checks: [] }
        if (method === 'listProjects') return []
        if (method === 'listAgentMemory') return { entries: [] }
        if (method === 'setAgentMemory') return { status: 'ok', entry: { id: 'm1', key: 'pref', value: 'note', source: 'aero', createdAt: '', updatedAt: '' } }
        return { ok: true }
      }
    },
  }) as unknown as ApiClient
}

function ctxFor(client: ApiClient): ToolContext {
  return { client, projectName: 'demo' }
}

function jsonSchemaProperties(tool: AgentTool): Record<string, unknown> | undefined {
  const params = tool.parameters as { properties?: Record<string, unknown> }
  return params?.properties
}

describe('buildAllTools', () => {
  it('exposes every MCP read + write tool minus the Aero exclusion set', () => {
    const calls: CallLog[] = []
    const tools = buildAllTools(ctxFor(recordingClient(calls)))
    const expectedCount = canonryMcpTools.filter((t) => !AERO_EXCLUDED_MCP_TOOLS.has(t.name)).length

    expect(tools).toHaveLength(expectedCount)
    expect(tools.map((t) => t.name)).not.toContain(CanonryMcpToolNames.canonry_agent_clear)
    // Spot-check that every other tool from the registry is exposed.
    expect(tools.map((t) => t.name)).toContain(CanonryMcpToolNames.canonry_project_overview)
    expect(tools.map((t) => t.name)).toContain(CanonryMcpToolNames.canonry_run_trigger)
    expect(tools.map((t) => t.name)).toContain(CanonryMcpToolNames.canonry_memory_list)
    expect(tools.map((t) => t.name)).toContain(CanonryMcpToolNames.canonry_memory_set)
  })
})

describe('buildReadTools', () => {
  it('returns every MCP read tool minus the exclusion set', () => {
    const calls: CallLog[] = []
    const tools = buildReadTools(ctxFor(recordingClient(calls)))
    const expectedReads = canonryMcpTools.filter(
      (t) => t.access === 'read' && !AERO_EXCLUDED_MCP_TOOLS.has(t.name),
    )

    expect(tools).toHaveLength(expectedReads.length)
    expect(tools.every((t) => expectedReads.some((r) => r.name === t.name))).toBe(true)
    // Read scope must not include any write-only tool.
    expect(tools.map((t) => t.name)).not.toContain(CanonryMcpToolNames.canonry_run_trigger)
    expect(tools.map((t) => t.name)).not.toContain(CanonryMcpToolNames.canonry_memory_set)
  })
})

describe('buildAdsOperatorTools', () => {
  it('adds the one-call context tool and narrows read-only mode to the ads operator allow-list', () => {
    const calls: CallLog[] = []
    const tools = buildAdsOperatorTools(ctxFor(recordingClient(calls)), { scope: AeroToolScopes.readOnly })
    const names = tools.map((t) => t.name)
    const expectedReads = canonryMcpTools.filter(
      (t) =>
        t.access === 'read' &&
        AERO_ADS_OPERATOR_MCP_TOOL_NAMES.has(t.name) &&
        !AERO_EXCLUDED_MCP_TOOLS.has(t.name),
    )

    expect(tools).toHaveLength(expectedReads.length + 1)
    expect(names[0]).toBe(AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME)
    expect(names).toContain(CanonryMcpToolNames.canonry_project_overview)
    expect(names).toContain(CanonryMcpToolNames.canonry_ads_summary)
    expect(names).toContain(CanonryMcpToolNames.canonry_memory_list)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_ads_sync)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_run_trigger)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_memory_set)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_queries_replace)
  })

  it('keeps only selected write tools when full scope is requested', () => {
    const calls: CallLog[] = []
    const tools = buildAdsOperatorTools(ctxFor(recordingClient(calls)), { scope: AeroToolScopes.all })
    const names = tools.map((t) => t.name)

    expect(names).toContain(CanonryMcpToolNames.canonry_ads_sync)
    expect(names).toContain(CanonryMcpToolNames.canonry_run_trigger)
    expect(names).toContain(CanonryMcpToolNames.canonry_memory_set)
    expect(names).toContain(CanonryMcpToolNames.canonry_memory_forget)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_schedule_set)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_queries_replace)
    expect(names).not.toContain(CanonryMcpToolNames.canonry_traffic_connect_cloud_run)
  })

  it('keeps the full-scope local profile inside the explicit ads operator allow-list', () => {
    const calls: CallLog[] = []
    const tools = buildAdsOperatorTools(ctxFor(recordingClient(calls)), { scope: AeroToolScopes.all })
    const allowedNames = new Set<string>([
      AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME,
      ...AERO_ADS_OPERATOR_MCP_TOOL_NAMES,
    ])

    expect(tools.map((t) => t.name).filter((name) => !allowedNames.has(name))).toEqual([])
  })

  it('executes the context tool as a bounded composite read', async () => {
    const calls: CallLog[] = []
    const tools = buildAdsOperatorTools(ctxFor(recordingClient(calls)), { scope: AeroToolScopes.readOnly })
    const contextTool = tools.find((t) => t.name === AERO_ADS_OPERATOR_CONTEXT_TOOL_NAME)!

    const result = await contextTool.execute('call-1', { windowDays: 14, campaignLimit: 1, insightRowLimit: 1 })

    expect(result.details).toMatchObject({
      project: 'demo',
      window: { days: 14 },
      overview: { status: 'ok' },
      ads: {
        status: { status: 'ok' },
        summary: { status: 'ok' },
      },
      doctor: { status: 'ok' },
      memory: { status: 'ok' },
    })
    expect(calls.map((c) => c.method)).toEqual([
      'getProjectOverview',
      'getAdsStatus',
      'getAdsSummary',
      'getAdsCampaigns',
      'getAdsInsights',
      'getAdsInsights',
      'runDoctor',
      'listAgentMemory',
    ])
    expect((result.content[0] as { text: string }).text).toContain('High intent')
  })
})

describe('buildAeroStateTools', () => {
  it('keeps the default profile equivalent to the existing read/full builders', () => {
    const calls: CallLog[] = []
    const ctx = ctxFor(recordingClient(calls))

    expect(buildAeroStateTools(ctx, { scope: AeroToolScopes.readOnly }).map((t) => t.name))
      .toEqual(buildReadTools(ctx).map((t) => t.name))
    expect(buildAeroStateTools(ctx, { scope: AeroToolScopes.all }).map((t) => t.name))
      .toEqual(buildAllTools(ctx).map((t) => t.name))
  })
})

describe('mcpToAgentTool', () => {
  it('strips the top-level project property from the LLM-visible schema', () => {
    const calls: CallLog[] = []
    const overview = canonryMcpTools.find((t) => t.name === CanonryMcpToolNames.canonry_project_overview)!
    const tool = mcpToAgentTool(overview, { client: recordingClient(calls), projectName: 'demo' })

    const props = jsonSchemaProperties(tool) ?? {}
    expect(props).not.toHaveProperty('project')
    const required = (tool.parameters as { required?: string[] }).required ?? []
    expect(required).not.toContain('project')
  })

  it('injects ctx.projectName into the handler call when the schema had project', async () => {
    const calls: CallLog[] = []
    const overview = canonryMcpTools.find((t) => t.name === CanonryMcpToolNames.canonry_project_overview)!
    const tool = mcpToAgentTool(overview, { client: recordingClient(calls), projectName: 'demo' })

    await tool.execute('call-1', {})
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('getProjectOverview')
    expect(calls[0].args[0]).toBe('demo')
  })

  it('passes through schemas that do not carry a project field', () => {
    const calls: CallLog[] = []
    const projectsList = canonryMcpTools.find((t) => t.name === CanonryMcpToolNames.canonry_projects_list)!
    const tool = mcpToAgentTool(projectsList, { client: recordingClient(calls), projectName: 'demo' })

    // Empty input schema has no `project` to strip; the schema stays unchanged.
    const props = jsonSchemaProperties(tool) ?? {}
    expect(props).not.toHaveProperty('project')
  })

  it('injects projectName for multi-arg tools (memory set)', async () => {
    const calls: CallLog[] = []
    const memorySet = canonryMcpTools.find((t) => t.name === CanonryMcpToolNames.canonry_memory_set)!
    const tool = mcpToAgentTool(memorySet, { client: recordingClient(calls), projectName: 'demo' })

    await tool.execute('call-1', { key: 'pref', value: 'be terse' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('setAgentMemory')
    expect(calls[0].args[0]).toBe('demo')
    expect(calls[0].args[1]).toEqual({ key: 'pref', value: 'be terse' })
  })

  it('wraps the handler result in an AgentToolResult envelope', async () => {
    const calls: CallLog[] = []
    const memoryList = canonryMcpTools.find((t) => t.name === CanonryMcpToolNames.canonry_memory_list)!
    const tool = mcpToAgentTool(memoryList, { client: recordingClient(calls), projectName: 'demo' })

    const result = await tool.execute('call-1', {})
    expect(result.details).toEqual({ entries: [] })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('"entries"')
  })
})

describe('buildMcpAgentTools', () => {
  it('respects the readOnly filter', () => {
    const calls: CallLog[] = []
    const reads = buildMcpAgentTools(canonryMcpTools, { client: recordingClient(calls), projectName: 'demo' }, { readOnly: true })

    const expectedReads = canonryMcpTools.filter(
      (t) => t.access === 'read' && !AERO_EXCLUDED_MCP_TOOLS.has(t.name),
    )
    expect(reads).toHaveLength(expectedReads.length)
  })

  it('respects an explicit tool-name allow-list', () => {
    const calls: CallLog[] = []
    const tools = buildMcpAgentTools(
      canonryMcpTools,
      { client: recordingClient(calls), projectName: 'demo' },
      {
        includeNames: new Set([
          CanonryMcpToolNames.canonry_project_overview,
          CanonryMcpToolNames.canonry_ads_sync,
        ]),
      },
    )

    expect(tools.map((t) => t.name)).toEqual([
      CanonryMcpToolNames.canonry_project_overview,
      CanonryMcpToolNames.canonry_ads_sync,
    ])
  })

  it('applies readOnly after the allow-list', () => {
    const calls: CallLog[] = []
    const tools = buildMcpAgentTools(
      canonryMcpTools,
      { client: recordingClient(calls), projectName: 'demo' },
      {
        readOnly: true,
        includeNames: new Set([
          CanonryMcpToolNames.canonry_project_overview,
          CanonryMcpToolNames.canonry_ads_sync,
        ]),
      },
    )

    expect(tools.map((t) => t.name)).toEqual([CanonryMcpToolNames.canonry_project_overview])
  })

  it('excludes Aero-blacklisted tools', () => {
    const calls: CallLog[] = []
    const tools = buildMcpAgentTools(canonryMcpTools, { client: recordingClient(calls), projectName: 'demo' })

    for (const excluded of AERO_EXCLUDED_MCP_TOOLS) {
      expect(tools.map((t) => t.name)).not.toContain(excluded)
    }
  })
})
