import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect } from 'vitest'
import { describeError } from '@ainyc/canonry-contracts'
import { createApiClient } from '../src/client.js'
import { mcpToAgentTool } from '../src/agent/mcp-to-agent-tool.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

export interface NativeDispatchCase {
  caseId: string
  tool: string
  channel: 'mcp' | 'aero'
  input: Record<string, unknown>
  requests: readonly {
    method: string
    path: string
    query: readonly (readonly [string, string])[]
    body: unknown
    status: number
    response: unknown
  }[]
  expectedText: unknown
  expectedStructured: unknown
  group?: string
}

/** A covered group must execute at least one native forwarding scenario. */
export function selectNativeDispatchCases(cases: readonly NativeDispatchCase[], group?: string): readonly NativeDispatchCase[] {
  const selected = group === undefined ? cases : cases.filter(scenario => scenario.group === group)
  if (selected.length === 0) {
    throw new Error(`No native MCP dispatch cases selected for ${group ?? 'registry table'}`)
  }
  return selected
}

interface CapturedRequest {
  method: string
  path: string
  query: [string, string][]
  body: unknown
  authorization: string | undefined
  tool: string | undefined
  call: string | undefined
  client: string | undefined
  logFields: string | undefined
}

/** Only the remote HTTP API is simulated. Both SDK transports and ApiClient run. */
export async function startNativeMcpDispatchFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'canonry-native-mcp-'))
  let active: NativeDispatchCase | undefined
  let captured: CapturedRequest[] = []
  const api = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      const header = (name: string) => {
        const value = request.headers[name]
        return typeof value === 'string' ? value : undefined
      }
      const record: CapturedRequest = {
        method: request.method ?? '', path: url.pathname,
        query: [...url.searchParams].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)),
        body: raw === '' ? null : JSON.parse(raw),
        authorization: header('authorization'), tool: header('x-canonry-mcp-tool'),
        call: header('x-canonry-mcp-call'), client: header('x-canonry-mcp-client'),
        logFields: header('x-canonry-log-fields'),
      }
      const script = active?.requests[captured.length]
      captured.push(record)
      if (!script) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'UNEXPECTED_REQUEST', message: 'No remaining scripted API response' } }))
        return
      }
      response.writeHead(script.status, script.status === 204 ? {} : { 'content-type': 'application/json' })
      response.end(script.status === 204 ? undefined : JSON.stringify(script.response))
    })().catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'FIXTURE_ERROR', message: describeError(error) } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    api.once('error', reject)
    api.listen(0, '127.0.0.1', resolve)
  })
  const address = api.address()
  if (!address || typeof address === 'string') throw new Error('Native fixture has no TCP address')
  await writeFile(join(directory, 'config.yaml'), JSON.stringify({
    apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'cnry_native_contract',
    database: join(directory, 'unused.sqlite'), basePath: '/native-mcp/',
  }))
  const names = ['CANONRY_CONFIG_DIR', 'CANONRY_PORT', 'CANONRY_BASE_PATH'] as const
  const saved = new Map(names.map(name => [name, process.env[name]]))
  let apiClient: ReturnType<typeof createApiClient>
  try {
    process.env.CANONRY_CONFIG_DIR = directory
    delete process.env.CANONRY_PORT
    delete process.env.CANONRY_BASE_PATH
    apiClient = createApiClient({ skipProbe: true, clientName: 'native-registry-contract', surface: 'mcp-stdio' })
  } catch (error) {
    api.closeAllConnections()
    await new Promise<void>(resolve => api.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    for (const name of names) {
      const previous = saved.get(name)
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }
  const server = createCanonryMcpServer({ clientFactory: () => apiClient, eager: true, operator: true })
  const protocol = new Client({ name: 'native-mcp-contract', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(serverTransport), protocol.connect(clientTransport)])
    await protocol.listTools()
  } catch (error) {
    await Promise.allSettled([protocol.close(), server.close()])
    api.closeAllConnections()
    await new Promise<void>(resolve => api.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    async verify(scenario: NativeDispatchCase) {
      active = scenario
      captured = []
      if (scenario.channel === 'mcp') {
        const result = CallToolResultSchema.parse(await protocol.callTool({ name: scenario.tool, arguments: scenario.input }))
        expect(result.isError, scenario.caseId).not.toBe(true)
        expect(result.structuredContent, scenario.caseId).toEqual(scenario.expectedStructured)
        expect(result.content, scenario.caseId).toHaveLength(1)
        const item = result.content[0]
        expect(item?.type, scenario.caseId).toBe('text')
        if (item?.type !== 'text') throw new Error(`${scenario.caseId}: missing MCP text`)
        expect(JSON.parse(item.text), scenario.caseId).toEqual(scenario.expectedText)
      } else {
        const registered = canonryMcpTools.find(tool => tool.name === scenario.tool)
        if (!registered) throw new Error(`Unknown Aero tool ${scenario.tool}`)
        const { project: _project, ...argumentsWithoutProject } = scenario.input
        const tool = mcpToAgentTool(registered, { client: apiClient, projectName: 'acme' })
        const result = await tool.execute(scenario.caseId, argumentsWithoutProject)
        expect(result.details, scenario.caseId).toEqual(scenario.expectedText)
        expect(result.content, scenario.caseId).toHaveLength(1)
        const item = result.content[0]
        expect(item?.type, scenario.caseId).toBe('text')
        if (item?.type !== 'text') throw new Error(`${scenario.caseId}: missing Aero text`)
        expect(JSON.parse(item.text), scenario.caseId).toEqual(scenario.expectedText)
      }
      expect(captured.map(({ method, path, query, body }) => ({ method, path, query, body })), scenario.caseId)
        .toEqual(scenario.requests.map(({ method, path, query, body }) => ({ method, path, query, body })))
      for (const request of captured) {
        expect(request.authorization, scenario.caseId).toBe('Bearer cnry_native_contract')
        expect(request.tool, scenario.caseId).toBe(scenario.tool)
        expect(request.call, scenario.caseId).toMatch(/^[0-9a-f-]{36}$/)
        expect(request.call, scenario.caseId).toBe(captured[0]?.call)
        if (scenario.channel === 'mcp') expect(request.client, scenario.caseId).toBe('native-mcp-contract')
        if (scenario.tool === 'canonry_logs_list') expect(request.logFields, scenario.caseId).toBe('provider')
      }
    },
    async close() {
      await Promise.allSettled([protocol.close(), server.close()])
      api.closeAllConnections()
      await new Promise<void>(resolve => api.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
