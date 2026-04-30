import { describe, it, expect } from 'vitest'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import {
  AERO_EXCLUDED_MCP_TOOLS,
  buildMcpAgentTools,
  mcpToAgentTool,
} from '../src/agent/mcp-to-agent-tool.js'
import {
  buildAllTools,
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
    expect(tools.map((t) => t.name)).not.toContain('canonry_agent_clear')
    // Spot-check that every other tool from the registry is exposed.
    expect(tools.map((t) => t.name)).toContain('canonry_project_overview')
    expect(tools.map((t) => t.name)).toContain('canonry_run_trigger')
    expect(tools.map((t) => t.name)).toContain('canonry_memory_list')
    expect(tools.map((t) => t.name)).toContain('canonry_memory_set')
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
    expect(tools.map((t) => t.name)).not.toContain('canonry_run_trigger')
    expect(tools.map((t) => t.name)).not.toContain('canonry_memory_set')
  })
})

describe('mcpToAgentTool', () => {
  it('strips the top-level project property from the LLM-visible schema', () => {
    const calls: CallLog[] = []
    const overview = canonryMcpTools.find((t) => t.name === 'canonry_project_overview')!
    const tool = mcpToAgentTool(overview, { client: recordingClient(calls), projectName: 'demo' })

    const props = jsonSchemaProperties(tool) ?? {}
    expect(props).not.toHaveProperty('project')
    const required = (tool.parameters as { required?: string[] }).required ?? []
    expect(required).not.toContain('project')
  })

  it('injects ctx.projectName into the handler call when the schema had project', async () => {
    const calls: CallLog[] = []
    const overview = canonryMcpTools.find((t) => t.name === 'canonry_project_overview')!
    const tool = mcpToAgentTool(overview, { client: recordingClient(calls), projectName: 'demo' })

    await tool.execute('call-1', {})
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('getProjectOverview')
    expect(calls[0].args[0]).toBe('demo')
  })

  it('passes through schemas that do not carry a project field', () => {
    const calls: CallLog[] = []
    const projectsList = canonryMcpTools.find((t) => t.name === 'canonry_projects_list')!
    const tool = mcpToAgentTool(projectsList, { client: recordingClient(calls), projectName: 'demo' })

    // Empty input schema has no `project` to strip; the schema stays unchanged.
    const props = jsonSchemaProperties(tool) ?? {}
    expect(props).not.toHaveProperty('project')
  })

  it('injects projectName for multi-arg tools (memory set)', async () => {
    const calls: CallLog[] = []
    const memorySet = canonryMcpTools.find((t) => t.name === 'canonry_memory_set')!
    const tool = mcpToAgentTool(memorySet, { client: recordingClient(calls), projectName: 'demo' })

    await tool.execute('call-1', { key: 'pref', value: 'be terse' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('setAgentMemory')
    expect(calls[0].args[0]).toBe('demo')
    expect(calls[0].args[1]).toEqual({ key: 'pref', value: 'be terse' })
  })

  it('wraps the handler result in an AgentToolResult envelope', async () => {
    const calls: CallLog[] = []
    const memoryList = canonryMcpTools.find((t) => t.name === 'canonry_memory_list')!
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

  it('excludes Aero-blacklisted tools', () => {
    const calls: CallLog[] = []
    const tools = buildMcpAgentTools(canonryMcpTools, { client: recordingClient(calls), projectName: 'demo' })

    for (const excluded of AERO_EXCLUDED_MCP_TOOLS) {
      expect(tools.map((t) => t.name)).not.toContain(excluded)
    }
  })
})
