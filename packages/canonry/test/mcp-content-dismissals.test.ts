import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalMeasurementPlanV2Json } from '@ainyc/canonry-contracts'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects } from '@ainyc/canonry-db'
import { measurementPlanV2Fixture } from '../../api-routes/test/measurement-plan-v2-fixture.js'
import { ApiClient } from '../src/client.js'
import { registerMcpHttpRoutes, type McpHttpOptions } from '../src/mcp-http.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli } from './cli-test-utils.js'

const NOW = '2026-10-05T12:00:00.000Z'
const cleanups: Array<() => Promise<void>> = []
let directory: string
let origin: string
let keys: Record<string, string>

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-content-dismissals-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', directory)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(directory, 'test.db')
  const db = createClient(database)
  migrate(db)
  for (const name of ['simple', 'advanced']) {
    db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  }
  const plan = measurementPlanV2Fixture()
  db.insert(measurementPlanVersions).values({ id: 'advanced-version', projectId: 'advanced', revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '1'.repeat(64), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
  db.insert(measurementPlans).values({ projectId: 'advanced', activeVersionId: 'advanced-version',
    createdAt: NOW, updatedAt: NOW }).run()
  keys = {}
  for (const [name, scopes, projectId] of [
    ['root', ['*'], null], ['writer', ['read', 'write'], 'simple'], ['reader', ['read'], 'simple'],
  ] as const) {
    const key = `cnry_${crypto.randomBytes(16).toString('hex')}`
    keys[name] = key
    db.insert(apiKeys).values({ id: name, name, keyHash: crypto.createHash('sha256').update(key).digest('hex'),
      keyPrefix: key.slice(0, 9), scopes: [...scopes], projectId, createdAt: NOW }).run()
  }
  const config = { apiUrl: 'http://localhost:0', database, apiKey: keys.root!, providers: {}, basePath: '/canonry' }
  const app = Fastify()
  const mcpOptions: McpHttpOptions = { db, selfApiUrl: '' }
  app.register(apiRoutes, { db, routePrefix: '/canonry/api/v1',
    registerAuthenticatedRoutes: scope => registerMcpHttpRoutes(scope, mcpOptions) })
  cleanups.push(async () => { await app.close(); db.$client.close() })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
  origin = `http://127.0.0.1:${address.port}`
  mcpOptions.selfApiUrl = `${origin}/canonry`
  fs.writeFileSync(path.join(directory, 'config.yaml'), JSON.stringify({ ...config, apiUrl: `${origin}/canonry` }))
})

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

async function connect(key: string, scope: 'read-write' | 'read-only' = 'read-write') {
  const server = createCanonryMcpServer({ scope, tiers: ['core', 'monitoring'],
    clientFactory: () => new ApiClient(`${origin}/canonry`, key, { skipProbe: true }) })
  const client = new Client({ name: 'content-dismissals-test', version: '1' }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(async () => { await client.close(); await server.close() })
  return client
}

describe('content dismissal CLI/REST/MCP parity', () => {
  it.each(['simple', 'advanced'])('can inspect and restore old dismissals for a %s portfolio', async project => {
    const api = new ApiClient(`${origin}/canonry`, keys.root!, { skipProbe: true })
    const stored = await api.dismissContentTarget(project, { targetRef: 'tgt_existing', note: 'Resolved before upgrade' })
    const cli = await invokeCli(['content', 'dismissals', project, '--format', 'json'])
    expect(cli.exitCode).toBeUndefined()
    expect(JSON.parse(cli.stdout)).toEqual({ dismissals: [stored] })
    const mcp = await connect(keys.root!)
    const list = await mcp.callTool({ name: 'canonry_content_dismissals', arguments: { project } })
    expect(list.isError).not.toBe(true)
    expect(list.structuredContent).toEqual(JSON.parse(cli.stdout))

    const updated = await mcp.callTool({ name: 'canonry_content_dismiss', arguments: {
      project, targetRef: 'tgt_existing', addressedUrl: 'https://example.com/resolution', note: 'Updated resolution',
    } })
    expect(updated.isError).not.toBe(true)
    const actual = await api.getContentDismissals(project)
    expect(actual.dismissals).toHaveLength(1)
    expect(updated.structuredContent).toEqual(actual.dismissals[0])
    expect(actual.dismissals[0]).toEqual({ targetRef: 'tgt_existing', addressedUrl: 'https://example.com/resolution',
      note: 'Updated resolution', dismissedAt: expect.any(String) })

    const restored = await mcp.callTool({ name: 'canonry_content_restore', arguments: { project, targetRef: 'tgt_existing' } })
    expect(restored.isError).not.toBe(true)
    expect(restored.structuredContent).toEqual({ targetRef: 'tgt_existing', restored: true })
    expect(await api.getContentDismissals(project)).toEqual({ dismissals: [] })
    expect(JSON.parse((await invokeCli(['content', 'dismissals', project, '--format', 'json'])).stdout))
      .toEqual({ dismissals: [] })
    const missing = await mcp.callTool({ name: 'canonry_content_restore', arguments: { project, targetRef: 'tgt_existing' } })
    expect(missing.isError).toBe(true)
    expect(missing.structuredContent).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('keeps dismissal reads available to read-only credentials without granting writes', async () => {
    const api = new ApiClient(`${origin}/canonry`, keys.root!, { skipProbe: true })
    const row = await api.dismissContentTarget('simple', { targetRef: 'tgt_existing' })
    const mcp = await connect(keys.reader!, 'read-only')
    const names = (await mcp.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('canonry_content_dismissals')
    expect(names).not.toContain('canonry_content_dismiss')
    expect(names).not.toContain('canonry_content_restore')
    expect((await mcp.callTool({ name: 'canonry_content_dismissals', arguments: { project: 'simple' } })).structuredContent)
      .toEqual({ dismissals: [row] })
    const readApi = new ApiClient(`${origin}/canonry`, keys.reader!, { skipProbe: true })
    await expect(readApi.dismissContentTarget('simple', { targetRef: 'tgt_denied' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(readApi.restoreContentTarget('simple', 'tgt_existing')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await api.getContentDismissals('simple')).toEqual({ dismissals: [row] })
  })

  it('enforces the project boundary for list, dismiss and restore through MCP', async () => {
    const mcp = await connect(keys.writer!)
    for (const [name, extra] of [
      ['canonry_content_dismissals', {}], ['canonry_content_dismiss', { targetRef: 'tgt_sibling' }],
      ['canonry_content_restore', { targetRef: 'tgt_sibling' }],
    ] as const) {
      const result = await mcp.callTool({ name, arguments: { project: 'advanced', ...extra } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
    expect(await new ApiClient(`${origin}/canonry`, keys.root!, { skipProbe: true }).getContentDismissals('advanced'))
      .toEqual({ dismissals: [] })
  })

  it('supports project-tagged JSONL reads and human resolution details', async () => {
    const api = new ApiClient(`${origin}/canonry`, keys.root!, { skipProbe: true })
    const row = await api.dismissContentTarget('simple', { targetRef: 'tgt_existing', addressedUrl: 'https://example.com/guide', note: 'Published guide' })
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true })
    const result = await invokeCli(['content', 'dismissals', 'simple', '--format', 'jsonl'])
    spy.mockRestore()
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(writes.join(''))).toEqual({ project: 'simple', ...row })
    const human = await invokeCli(['content', 'dismissals', 'simple'])
    expect(human.stdout).toContain('tgt_existing')
    expect(human.stdout).toContain('https://example.com/guide')
    expect(human.stdout).toContain('Published guide')
  })

  it('uses the same dismissal reads and writes through hosted HTTP MCP', async () => {
    const mcp = new Client({ name: 'content-dismissals-http-test', version: '1' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/canonry/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${keys.writer!}` } },
    })
    await mcp.connect(transport)
    cleanups.push(() => mcp.close())
    const stored = await mcp.callTool({ name: 'canonry_content_dismiss', arguments: { project: 'simple', targetRef: 'tgt_http' } })
    expect(stored.isError, JSON.stringify(stored)).not.toBe(true)
    const read = await mcp.callTool({ name: 'canonry_content_dismissals', arguments: { project: 'simple' } })
    expect(read.structuredContent).toEqual({ dismissals: [stored.structuredContent] })
    const restored = await mcp.callTool({ name: 'canonry_content_restore', arguments: { project: 'simple', targetRef: 'tgt_http' } })
    expect(restored.structuredContent).toEqual({ targetRef: 'tgt_http', restored: true })
    expect((await mcp.callTool({ name: 'canonry_content_dismissals', arguments: { project: 'simple' } })).structuredContent)
      .toEqual({ dismissals: [] })
  })
})
