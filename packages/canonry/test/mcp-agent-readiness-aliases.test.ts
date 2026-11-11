import { describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { buildAllTools, buildReadTools } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'
import { OPERATIONS_GUIDE } from '../src/mcp/operations-guide.generated.js'
import { availablePlaybooks, readPlaybook } from '../src/mcp/playbooks.js'
import { createCanonryMcpServerWithCatalog } from '../src/mcp/server.js'
import { canonryMcpTools, DEPRECATED_MCP_TOOL_ALIASES } from '../src/mcp/tool-registry.js'

// The published contract: each canonical Agent Readiness tool and its operation.
const CANONICAL_TOOLS: Record<string, string> = {
  canonry_agent_readiness_score: 'GET /api/v1/projects/{name}/agent-readiness',
  canonry_agent_readiness_page_scores: 'GET /api/v1/projects/{name}/agent-readiness/pages',
  canonry_agent_readiness_trend: 'GET /api/v1/projects/{name}/agent-readiness/trend',
  canonry_agent_readiness_overview: 'GET /api/v1/projects/{name}/agent-readiness/crawl',
  canonry_agent_readiness_pages: 'GET /api/v1/projects/{name}/agent-readiness/crawl/pages',
  canonry_agent_readiness_page_audit: 'GET /api/v1/projects/{name}/agent-readiness/crawl/pages/audit',
  canonry_agent_readiness_issues: 'GET /api/v1/projects/{name}/agent-readiness/issues',
  canonry_agent_readiness_issue_pages: 'GET /api/v1/projects/{name}/agent-readiness/issues/{issueId}/pages',
  canonry_agent_readiness_structure: 'GET /api/v1/projects/{name}/agent-readiness/structure',
  canonry_agent_readiness_links: 'GET /api/v1/projects/{name}/agent-readiness/internal-links',
  canonry_agent_readiness_link_neighbors: 'GET /api/v1/projects/{name}/agent-readiness/internal-links/neighbors',
  canonry_agent_readiness_dead_links: 'GET /api/v1/projects/{name}/agent-readiness/dead-links',
  canonry_agent_readiness_subgraph: 'GET /api/v1/projects/{name}/agent-readiness/subgraph',
  canonry_agent_readiness_path: 'GET /api/v1/projects/{name}/agent-readiness/path',
  canonry_agent_readiness_changes: 'GET /api/v1/projects/{name}/agent-readiness/changes',
  canonry_agent_readiness_run: 'POST /api/v1/projects/{name}/agent-readiness/runs',
}

// Every deprecated name and the canonical tool it must keep answering as.
const DEPRECATED_TOOLS: Record<string, string> = {
  canonry_technical_aeo_score: 'canonry_agent_readiness_score',
  canonry_technical_aeo_pages: 'canonry_agent_readiness_page_scores',
  canonry_technical_aeo_trend: 'canonry_agent_readiness_trend',
  canonry_site_health_overview: 'canonry_agent_readiness_overview',
  canonry_technical_aeo_crawl: 'canonry_agent_readiness_overview',
  canonry_technical_aeo_crawl_pages: 'canonry_agent_readiness_pages',
  canonry_site_health_page_audit: 'canonry_agent_readiness_page_audit',
  canonry_site_health_issues: 'canonry_agent_readiness_issues',
  canonry_site_health_issue_pages: 'canonry_agent_readiness_issue_pages',
  canonry_technical_aeo_structure: 'canonry_agent_readiness_structure',
  canonry_technical_aeo_internal_links: 'canonry_agent_readiness_links',
  canonry_technical_aeo_link_neighbors: 'canonry_agent_readiness_link_neighbors',
  canonry_technical_aeo_dead_links: 'canonry_agent_readiness_dead_links',
  canonry_site_health_subgraph: 'canonry_agent_readiness_subgraph',
  canonry_site_health_path: 'canonry_agent_readiness_path',
  canonry_site_health_changes: 'canonry_agent_readiness_changes',
  canonry_technical_aeo_run: 'canonry_agent_readiness_run',
}

const LEGACY_NAME = /canonry_(?:technical_aeo|site_health)_/
const LEGACY_PRODUCT = /Site Health|Technical AEO|technical AEO|Page Health/
const tool = (name: string) => {
  const found = canonryMcpTools.find(candidate => candidate.name === name)
  expect(found, name).toBeTruthy()
  return found!
}

describe('canonical Agent Readiness MCP tools', () => {
  it('registers each canonical tool on its canonical operation', () => {
    expect(canonryMcpTools.filter(entry => entry.name.startsWith('canonry_agent_readiness_')).map(entry => entry.name).sort())
      .toEqual(Object.keys(CANONICAL_TOOLS).sort())
    for (const [name, operation] of Object.entries(CANONICAL_TOOLS)) {
      const canonical = tool(name)
      const write = name === 'canonry_agent_readiness_run'
      expect(canonical, name).toMatchObject({
        tier: 'monitoring',
        access: write ? 'write' : 'read',
        openApiOperations: [operation],
        annotations: { readOnlyHint: !write },
      })
      expect(canonical.deprecatedAliasOf, name).toBeUndefined()
      expect(canonical.title, name).toContain('Agent Readiness')
    }
  })

  it('names only canonical tools and the Agent Readiness product in every canonical tool contract', () => {
    for (const canonical of canonryMcpTools.filter(entry => entry.deprecatedAliasOf === undefined)) {
      const contract = `${canonical.title}\n${canonical.description}\n${JSON.stringify(canonical.inputJsonSchema)}`
      expect(contract, canonical.name).not.toMatch(LEGACY_NAME)
      expect(contract, canonical.name).not.toMatch(LEGACY_PRODUCT)
    }
  })
})

describe('deprecated Agent Readiness MCP tool names', () => {
  it('registers each deprecated name as an alias of its canonical tool', () => {
    expect(DEPRECATED_MCP_TOOL_ALIASES).toEqual(DEPRECATED_TOOLS)
    expect(canonryMcpTools.filter(entry => entry.deprecatedAliasOf !== undefined).map(entry => entry.name).sort())
      .toEqual(Object.keys(DEPRECATED_TOOLS).sort())
    for (const [name, canonicalName] of Object.entries(DEPRECATED_TOOLS)) {
      const alias = tool(name)
      const canonical = tool(canonicalName)
      expect(alias.deprecatedAliasOf, name).toBe(canonicalName)
      expect(alias.inputSchema, name).toBe(canonical.inputSchema)
      expect(alias.handler, name).toBe(canonical.handler)
      expect(alias.outputSchema, name).toBe(canonical.outputSchema)
      expect(alias.annotations, name).toEqual(canonical.annotations)
      expect(alias.access, name).toBe(canonical.access)
      expect(alias.tier, name).toBe(canonical.tier)
      expect(alias.requiredScope, name).toBe(canonical.requiredScope)
      expect(alias.openApiOperations, name).toEqual([CANONICAL_TOOLS[canonicalName]])
      expect(alias.inputJsonSchema, name).toEqual({ ...(canonical.inputJsonSchema as object), title: name })
      expect(alias.title, name).toBe(`${canonical.title} (deprecated name)`)
      expect(alias.description, name).toBe(`Deprecated name for ${canonicalName}; call that tool instead. Same input and output.`)
    }
  })

  it('lists each deprecated name over MCP with the canonical input schema', async () => {
    const { server } = createCanonryMcpServerWithCatalog({ eager: true, clientFactory: () => ({}) as ApiClient })
    const client = new Client({ name: 'agent-readiness-alias-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const listed = new Map((await client.listTools()).tools.map(entry => [entry.name, entry]))
      for (const [name, canonicalName] of Object.entries(DEPRECATED_TOOLS)) {
        const alias = listed.get(name)
        const canonical = listed.get(canonicalName)
        expect(alias, name).toBeTruthy()
        expect(alias!.title, name).toBe(`${canonical!.title} (deprecated name)`)
        expect(alias!.inputSchema, name).toEqual(canonical!.inputSchema)
        expect(alias!.annotations, name).toEqual(canonical!.annotations)
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()])
    }
  })

  it('stays out of canonry_help, toolkit listings, the operations guide and playbooks', async () => {
    const { server, catalog } = createCanonryMcpServerWithCatalog({ clientFactory: () => ({}) as ApiClient })
    const loaded = catalog.loadToolkit('monitoring')
    expect(loaded.status).toBe('loaded')
    expect(loaded.tools).toEqual(expect.arrayContaining(Object.keys(CANONICAL_TOOLS)))
    expect(loaded.tools.filter(name => LEGACY_NAME.test(name))).toEqual([])

    const client = new Client({ name: 'agent-readiness-help-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      // Loading the toolkit still enables the deprecated names for existing callers.
      expect((await client.listTools()).tools.map(entry => entry.name)).toEqual(expect.arrayContaining(Object.keys(DEPRECATED_TOOLS)))
      for (const intent of ['status', 'diagnose', 'reports', 'agent readiness scan']) {
        const help = await client.callTool({ name: 'canonry_help', arguments: { intent, includeCatalog: true } })
        expect(help.isError, intent).not.toBe(true)
        const text = JSON.stringify(help.structuredContent)
        expect(text, intent).toContain('canonry_agent_readiness_issues')
        expect(text, intent).not.toMatch(LEGACY_NAME)
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()])
    }

    expect(JSON.stringify(OPERATIONS_GUIDE)).not.toMatch(LEGACY_NAME)
    for (const slug of availablePlaybooks()) expect(readPlaybook(slug), slug).not.toMatch(LEGACY_NAME)
  })

  it('never reaches Aero, which gets each canonical tool once', () => {
    const ctx = { client: {} as ApiClient, projectName: 'demo' }
    const all = buildAllTools(ctx).map(entry => entry.name)
    const reads = buildReadTools(ctx).map(entry => entry.name)
    for (const names of [all, reads]) expect(names.filter(name => LEGACY_NAME.test(name))).toEqual([])
    const agentReadiness = (names: string[]) => names.filter(name => name.startsWith('canonry_agent_readiness_')).sort()
    expect(agentReadiness(all)).toEqual(Object.keys(CANONICAL_TOOLS).sort())
    expect(agentReadiness(reads)).toEqual(Object.keys(CANONICAL_TOOLS).filter(name => name !== 'canonry_agent_readiness_run').sort())
  })
})
