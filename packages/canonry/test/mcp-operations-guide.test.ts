import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type { ApiClient } from '../src/client.js'
import { createCanonryMcpServerWithCatalog, type CanonryMcpServerOptions } from '../src/mcp/server.js'
import { OPERATIONS_GUIDE } from '../src/mcp/operations-guide.generated.js'
import { operationsHelp } from '../src/mcp/operations-guide.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import { CANONRY_MCP_TIERS } from '../src/mcp/toolkits.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

async function connect(options: CanonryMcpServerOptions = {}) {
  const listProjects = vi.fn().mockResolvedValue([{ name: 'demo' }])
  const getProjectOverview = vi.fn().mockResolvedValue({ project: 'demo', evidence: null })
  const getSettings = vi.fn().mockResolvedValue({ providers: [] })
  const createSnapshot = vi.fn().mockResolvedValue({ companyName: 'Acme' })
  const { server, catalog } = createCanonryMcpServerWithCatalog({
    clientFactory: () => ({ listProjects, getProjectOverview, getSettings, createSnapshot }) as unknown as ApiClient,
    ...options,
  })
  const client = new Client({ name: 'guide-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return { client, catalog, listProjects, getProjectOverview, getSettings, createSnapshot }
}

describe('universal MCP operations guidance', () => {
  it('navigates initialize → help → stored reads without skills or resources', async () => {
    const { client, listProjects, getProjectOverview } = await connect({ tiers: CANONRY_MCP_TIERS, scope: 'read-only' })
    expect(client.getInstructions()).toBe(OPERATIONS_GUIDE.initialize)
    const response = await client.callTool({ name: 'canonry_help', arguments: { intent: 'status' } })
    expect(response.isError).not.toBe(true)
    const help = response.structuredContent!
    expect(help).toMatchObject({ guideVersion: 'v1', mode: 'hosted-fixed-catalog', next: ['canonry_projects_list', 'canonry_project_overview'] })
    expect(help).not.toHaveProperty('loadToolkits')
    expect(help).not.toHaveProperty('toolkits')
    expect(JSON.stringify(help).length).toBeLessThan(2000)
    expect(JSON.parse((response.content as Array<{ text: string }>)[0]!.text)).toEqual(help)
    expect(listProjects).not.toHaveBeenCalled()
    expect(getProjectOverview).not.toHaveBeenCalled()
    await client.callTool({ name: 'canonry_projects_list', arguments: {} })
    await client.callTool({ name: 'canonry_project_overview', arguments: { project: 'demo' } })
    expect(listProjects).toHaveBeenCalledOnce()
    expect(getProjectOverview).toHaveBeenCalledOnce()
  })

  it.each(CANONRY_MCP_TIERS)('only routes to offered stored reads on hosted %s profiles', async tier => {
    const { client } = await connect({ tiers: ['core', tier], scope: 'read-only' })
    const listed = (await client.listTools()).tools.map(tool => tool.name)
    expect(listed).not.toContain('canonry_load_toolkit')
    for (const intent of Object.keys(OPERATIONS_GUIDE.workflows)) {
      const result = await client.callTool({ name: 'canonry_help', arguments: { intent } })
      const help = result.structuredContent!
      expect(help).not.toHaveProperty('loadToolkits')
      expect((help.next as string[]).length).toBeGreaterThan(0)
      for (const name of help.next as string[]) {
        expect(listed).toContain(name)
        expect(canonryMcpTools.find(tool => tool.name === name)?.access).toBe('read')
      }
      expect(JSON.stringify(help).length).toBeLessThan(2000)
    }
    const expanded = await client.callTool({ name: 'canonry_help', arguments: { includeCatalog: true } })
    expect(expanded.structuredContent).toHaveProperty('toolkits')
    expect(expanded.structuredContent?.usage).not.toContain('canonry_load_toolkit')
  })

  it('offers progressive discovery only for registered, not-yet-loaded tools', async () => {
    const { client } = await connect({ scope: 'read-only' })
    const before = await client.callTool({ name: 'canonry_help', arguments: { intent: 'reports' } })
    expect(before.structuredContent).toMatchObject({ mode: 'stdio-progressive', loadToolkits: ['monitoring'] })
    expect(before.structuredContent?.next).not.toContain('canonry_report')
    await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'monitoring' } })
    const after = await client.callTool({ name: 'canonry_help', arguments: { intent: 'reports' } })
    expect(after.structuredContent?.next).toContain('canonry_report')
    expect(after.structuredContent).not.toHaveProperty('loadToolkits')
  })

  it.each(['prospect', 'prospecting', 'snapshot', 'generate a prospect snapshot', 'prospect report with manual queries'])('discovers snapshot execution from "%s" without starting provider work', async intent => {
    const { client, listProjects, getSettings, createSnapshot } = await connect()
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('canonry_snapshot')
    const before = await client.callTool({ name: 'canonry_help', arguments: { intent } })
    expect(before.structuredContent).toMatchObject({
      workflow: 'prospecting', next: ['canonry_settings_get'], loadToolkits: ['discovery'],
    })
    expect(before.structuredContent).not.toHaveProperty('actions')
    expect(getSettings).not.toHaveBeenCalled()
    expect(createSnapshot).not.toHaveBeenCalled()
    await client.callTool({ name: 'canonry_settings_get', arguments: {} })
    await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'discovery' } })
    const after = await client.callTool({ name: 'canonry_help', arguments: { intent } })
    expect(after.structuredContent).toMatchObject({ next: ['canonry_settings_get'], actions: ['canonry_snapshot'] })
    expect(after.structuredContent).not.toHaveProperty('loadToolkits')
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('canonry_snapshot')
    expect(listProjects).not.toHaveBeenCalled()
    expect(createSnapshot).not.toHaveBeenCalled()
    const input = { companyName: 'Acme', domain: 'acme.example', providers: ['gemini'] }
    const result = await client.callTool({ name: 'canonry_snapshot', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(createSnapshot).toHaveBeenCalledExactlyOnceWith(input)
  })

  it.each<CanonryMcpServerOptions>([{ eager: true }, { tiers: CANONRY_MCP_TIERS }])('offers available snapshot actions without loading on fixed catalogs: %j', async options => {
    const { client, createSnapshot } = await connect(options)
    const response = await client.callTool({ name: 'canonry_help', arguments: { intent: 'prospect snapshot' } })
    expect(response.structuredContent).toMatchObject({ next: ['canonry_settings_get'], actions: ['canonry_snapshot'] })
    expect(response.structuredContent).not.toHaveProperty('loadToolkits')
    expect(createSnapshot).not.toHaveBeenCalled()
  })

  it.each<CanonryMcpServerOptions>([
    { scope: 'read-only' },
    { credentialScopes: ['read'] },
    { credentialScopes: ['read', 'research.run'] },
    { credentialScopes: ['ads.write'] },
    { tiers: ['core', 'monitoring'] },
    { tiers: CANONRY_MCP_TIERS, scope: 'read-only' },
    { tiers: CANONRY_MCP_TIERS, credentialScopes: ['research.run'] },
  ])('does not offer excluded snapshot actions or their toolkit: %j', async options => {
    const { client, createSnapshot } = await connect(options)
    const response = await client.callTool({ name: 'canonry_help', arguments: { intent: 'prospect snapshot' } })
    expect(response.structuredContent).toMatchObject({ workflow: 'prospecting', next: ['canonry_settings_get'] })
    expect(response.structuredContent).not.toHaveProperty('actions')
    expect(response.structuredContent).not.toHaveProperty('loadToolkits')
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('canonry_snapshot')
    expect(createSnapshot).not.toHaveBeenCalled()
  })

  it.each(['all', 'read-only'] as const)('keeps research guidance inside the %s credential-filtered catalog', async scope => {
    const { client } = await connect({ tiers: ['core', 'discovery'], scope, credentialScopes: ['read', 'research.run'] })
    const tools = (await client.listTools()).tools
    const names = tools.map(tool => tool.name)
    expect(names.includes('canonry_research_run_start')).toBe(scope === 'all')
    expect(names.includes('canonry_research_batch_start')).toBe(scope === 'all')
    expect(names).not.toContain('canonry_run_trigger')
    expect(names).not.toContain('canonry_load_toolkit')
    const result = await client.callTool({ name: 'canonry_help', arguments: { intent: 'research' } })
    expect(result.structuredContent).toMatchObject({
      scope, workflow: 'measurement', next: ['canonry_projects_list', 'canonry_research_runs_list'],
      approvalBoundary: ['provider reads', 'sweeps', 'writes'],
    })
    expect(result.structuredContent?.next).not.toContain('canonry_research_run_start')
  })

  it('keeps eager stdio distinct from hosted mode and validates intents', async () => {
    const { client, catalog } = await connect({ eager: true })
    expect(operationsHelp(catalog.helpResult(), 'stdio-fixed-catalog', 'unknown').workflow).toBe('status')
    const eager = await client.callTool({ name: 'canonry_help', arguments: { intent: 'diagnose a regression' } })
    expect(eager.structuredContent).toMatchObject({ mode: 'stdio-fixed-catalog', workflow: 'diagnose' })
    expect(eager.structuredContent).not.toHaveProperty('loadToolkits')
    const invalid = await client.callTool({ name: 'canonry_help', arguments: { intent: 'x'.repeat(201) } })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid)).toContain('VALIDATION_ERROR')
  })

  it('exposes the same guide as an optional resource without reading project data', async () => {
    const { client, listProjects } = await connect()
    const resources = await client.listResources()
    expect(resources.resources.map(resource => resource.uri)).toContain(OPERATIONS_GUIDE.resourceUri)
    const result = await client.readResource({ uri: OPERATIONS_GUIDE.resourceUri })
    expect(result.contents).toEqual([{ uri: OPERATIONS_GUIDE.resourceUri, mimeType: 'text/markdown', text: OPERATIONS_GUIDE.markdown }])
    expect(listProjects).not.toHaveBeenCalled()
  })

  it('derives runtime guidance and both native skill copies from the public source', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const source = fs.readFileSync(path.join(root, 'docs/agent-operations/v1.md'), 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)!
    const data = parse(match[1]!) as Record<string, unknown>
    const { skill: _skill, nativeReferences: _native, ...runtime } = data
    expect(OPERATIONS_GUIDE).toEqual({ ...runtime, markdown: match[2]!.trim() + '\n' })
    const skill = fs.readFileSync(path.join(root, 'skills/canonry/SKILL.md'), 'utf8')
    expect(skill).toContain(OPERATIONS_GUIDE.markdown)
    expect(fs.readFileSync(path.join(root, 'plugins/canonry/skills/canonry/SKILL.md'), 'utf8')).toBe(skill)
    for (const workflow of Object.values(OPERATIONS_GUIDE.workflows)) {
      for (const name of workflow.next) {
        const tool = canonryMcpTools.find(candidate => candidate.name === name)!
        expect(tool, name).toBeDefined()
        expect(tool.access).toBe('read')
        // These are curated stored-evidence starts, never provider-discovery,
        // refresh, spend, or mutation tools despite their read-only hints.
        expect(name).not.toMatch(/_(sync|run_start|trigger|customers|accounts|live_delivery)$/)
      }
    }
  })
})
