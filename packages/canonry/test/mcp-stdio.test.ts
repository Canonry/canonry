import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.resolve(packageRoot, '..', '..')
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const mcpCli = path.join(packageRoot, 'src', 'mcp', 'cli.ts')

describe('canonry-mcp stdio', () => {
  const clients: Client[] = []
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()))
    await Promise.all(servers.splice(0).map(server => server.close()))
  })

  it('initializes, lists tools, and calls stubbed read/write tools through stdio frames', async () => {
    const api = await startStubApi()
    servers.push(api)

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-stdio-'))
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      `apiUrl: ${api.origin}`,
      'database: /tmp/canonry-mcp-stdio.sqlite',
      'apiKey: cnry_test',
      '',
    ].join('\n'))

    const stderrChunks: string[] = []
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, mcpCli],
      cwd: packageRoot,
      env: {
        ...stringEnv(),
        CANONRY_CONFIG_DIR: configDir,
        CANONRY_BASE_PATH: '',
      },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)))

    const client = new Client({ name: 'canonry-mcp-test', version: '0.0.0' })
    clients.push(client)
    await client.connect(transport)

    const list = await client.listTools()
    expect(list.tools).toHaveLength(9)
    const listedNames = list.tools.map(tool => tool.name)
    expect(listedNames).toContain('canonry_projects_list')
    expect(listedNames).toContain('canonry_help')
    expect(listedNames).toContain('canonry_load_toolkit')
    expect(listedNames).not.toContain('canonry_insights_list')

    const help = await client.callTool({ name: 'canonry_help', arguments: {} })
    expect(help.isError).not.toBe(true)
    const helpPayload = jsonText(help) as { toolkits: Array<{ name: string; toolCount: number }> }
    expect(helpPayload.toolkits.map(t => t.name)).toEqual(['monitoring', 'setup', 'gsc', 'ga', 'agent'])

    const projects = await client.callTool({ name: 'canonry_projects_list', arguments: {} })
    expect(projects.isError).not.toBe(true)
    expect(jsonText(projects)).toEqual([{ name: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' }])

    const beforeLoad = await client.callTool({ name: 'canonry_insights_list', arguments: { project: 'acme' } })
    expect(beforeLoad.isError).toBe(true)

    const loaded = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'monitoring' } })
    expect(loaded.isError).not.toBe(true)
    expect(jsonText(loaded)).toMatchObject({ status: 'loaded', name: 'monitoring' })

    const expandedList = await client.listTools()
    expect(expandedList.tools.map(tool => tool.name)).toContain('canonry_insights_list')

    const insights = await client.callTool({ name: 'canonry_insights_list', arguments: { project: 'acme' } })
    expect(insights.isError).not.toBe(true)
    expect(jsonText(insights)).toEqual([])

    const setupLoad = await client.callTool({ name: 'canonry_load_toolkit', arguments: { name: 'setup' } })
    expect(setupLoad.isError).not.toBe(true)

    const addKeywords = await client.callTool({
      name: 'canonry_keywords_add',
      arguments: { project: 'acme', request: { keywords: ['alpha', 'alpha'] } },
    })
    expect(addKeywords.isError).not.toBe(true)
    expect(jsonText(addKeywords)).toEqual({ ok: true })

    expect(stderrChunks.join('')).toBe('')
  })

  it('loads every toolkit at startup when --eager is passed', async () => {
    const api = await startStubApi()
    servers.push(api)

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-eager-'))
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      `apiUrl: ${api.origin}`,
      'database: /tmp/canonry-mcp-eager.sqlite',
      'apiKey: cnry_test',
      '',
    ].join('\n'))

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, mcpCli, '--eager'],
      cwd: packageRoot,
      env: {
        ...stringEnv(),
        CANONRY_CONFIG_DIR: configDir,
        CANONRY_BASE_PATH: '',
      },
      stderr: 'pipe',
    })

    const client = new Client({ name: 'canonry-mcp-eager-test', version: '0.0.0' })
    clients.push(client)
    await client.connect(transport)

    const list = await client.listTools()
    expect(list.tools).toHaveLength(50)
    const names = list.tools.map(tool => tool.name)
    expect(names).toContain('canonry_insights_list')
    expect(names).toContain('canonry_help')
  })
})

async function startStubApi(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to start stub API')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
    send(response, [{ name: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' }])
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/projects/acme/insights') {
    send(response, [])
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/projects/acme/keywords') {
    request.resume()
    send(response, [{ id: 'k1', keyword: 'alpha', createdAt: '2026-04-27T00:00:00Z' }])
    return
  }
  send(response, { error: { code: 'NOT_FOUND', message: `${request.method} ${url.pathname}` } }, 404)
}

function send(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function stringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function jsonText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text tool result')
  return JSON.parse(item.text)
}
