import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys, projects, queries, querySnapshots, runs, type DatabaseClient } from '@canonry/canonry-db'
import { CitationStates } from '@canonry/canonry-contracts'
import { apiRoutes, hashApiKey } from '@canonry/canonry-api-routes'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'

/**
 * Issued keys through the MCP transport (#817, fix 2). The stdio MCP server
 * re-dispatches each tool call as a fresh authenticated API request through
 * the caller's own ApiClient, so the capability gate in `authPlugin` applies
 * per tool call exactly as it does over plain HTTP. These tests prove that
 * with a real API server behind the MCP server — not a stubbed transport —
 * for the Simple and Advanced portfolios, including the cross-project
 * boundary and the backward-compatible legacy read / embed credentials.
 *
 * A denied tool call surfaces as a CallToolResult with `isError: true` and
 * `structuredContent.error.code === 'FORBIDDEN'` (see `withToolErrors`).
 * An allowed call has no `isError` and carries the API's own payload.
 */
let tmpDir: string
let db: DatabaseClient
let app: FastifyInstance
let apiUrl: string

const NOW = new Date().toISOString()
const ROOT_KEY = 'cnry_roottoken'
const READ_KEY = 'cnry_readtoken'
const DASHBOARD_KEY = 'cnry_dashtoken'
const ANALYTICS_KEY = 'cnry_anatoken'
const FULL_KEY = 'cnry_fulltoken'
const NARROW_KEY = 'cnry_narrowtoken'
const EMBED_KEY = 'cnry_embedtoken'
const SCOPED_KEY = 'cnry_scopedtoken'

function seedKey(name: string, raw: string, scopes: string[], projectId?: string): void {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9),
    scopes, projectId: projectId ?? null, createdAt: NOW,
  }).run()
}

function seedProject(name: string): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.example`,
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-capability-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectAId = seedProject('project-a')
  seedProject('project-b')
  // An Advanced project with no published plan yet: its measurement reads
  // answer from the handler, never from the capability gate — so an allowed
  // key is "not FORBIDDEN" rather than 200, and a denied key is FORBIDDEN.
  seedProject('project-adv')
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId, projectId: projectAId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: NOW, finishedAt: NOW,
  }).run()
  const queryId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId, projectId: projectAId, query: 'best project a', createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    queryText: 'best project a',
    provider: 'gemini',
    citationState: CitationStates.cited,
    answerMentioned: true,
    answerText: 'answer text',
    createdAt: NOW,
  }).run()
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('read', READ_KEY, ['read'])
  seedKey('dashboard', DASHBOARD_KEY, ['dashboard.read'])
  seedKey('analytics', ANALYTICS_KEY, ['analytics.read'])
  seedKey('full', FULL_KEY, ['full.read'])
  seedKey('narrow', NARROW_KEY, ['users.read'])
  seedKey('embed', EMBED_KEY, ['embed'])
  seedKey('scoped', SCOPED_KEY, ['dashboard.read'], projectAId)

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Test API has no TCP address')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

interface McpHandle {
  mcp: Client
  close: () => Promise<void>
}

async function mcpFor(rawKey: string): Promise<McpHandle> {
  const client = new ApiClient(apiUrl, rawKey, { skipProbe: true })
  const server = createCanonryMcpServer({ clientFactory: () => client, eager: true })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: 'test-read-capability', version: '1.0.0' }, { capabilities: {} })
  await mcp.connect(clientTransport)
  return {
    mcp,
    close: async () => {
      await mcp.close()
      await server.close()
    },
  }
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>

function errorCode(result: CallToolResult): string | undefined {
  const structured = result.structuredContent as { error?: { code?: string } } | undefined
  return structured?.error?.code
}

function expectAllowed(result: CallToolResult, tool: string): void {
  expect(result.isError, `${tool}: expected the tool call to succeed, got ${JSON.stringify(result.structuredContent)}`).not.toBe(true)
}

function expectForbidden(result: CallToolResult, tool: string): void {
  expect(result.isError, `${tool}: expected a denied tool call`).toBe(true)
  expect(errorCode(result), `${tool}: expected the FORBIDDEN envelope`).toBe('FORBIDDEN')
}

describe('issued keys through MCP', () => {
  it('a dashboard key reads the Simple overview but not the query list', async () => {
    const { mcp, close } = await mcpFor(DASHBOARD_KEY)
    try {
      expectAllowed(await mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-a' } }), 'canonry_project_overview')
      expectForbidden(await mcp.callTool({ name: 'canonry_queries_list', arguments: { project: 'project-a' } }), 'canonry_queries_list')
    } finally {
      await close()
    }
  })

  it('a full-read key reads the query list, a narrow key reads nothing', async () => {
    const full = await mcpFor(FULL_KEY)
    try {
      expectAllowed(await full.mcp.callTool({ name: 'canonry_queries_list', arguments: { project: 'project-a' } }), 'canonry_queries_list')
    } finally {
      await full.close()
    }
    const narrow = await mcpFor(NARROW_KEY)
    try {
      expectForbidden(await narrow.mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-a' } }), 'canonry_project_overview')
      expectForbidden(await narrow.mcp.callTool({ name: 'canonry_queries_list', arguments: { project: 'project-a' } }), 'canonry_queries_list')
    } finally {
      await narrow.close()
    }
  })

  it('an analytics key reaches the Advanced measurement overview but a dashboard key does not', async () => {
    const analytics = await mcpFor(ANALYTICS_KEY)
    try {
      // No plan is published for project-adv, so the handler answers from
      // its own logic — but the capability gate has passed (not FORBIDDEN).
      const result = await analytics.mcp.callTool({ name: 'canonry_measurement_overview', arguments: { project: 'project-adv', scope: 'all' } })
      expect(errorCode(result), 'canonry_measurement_overview with an analytics key').not.toBe('FORBIDDEN')
    } finally {
      await analytics.close()
    }
    const dashboard = await mcpFor(DASHBOARD_KEY)
    try {
      expectForbidden(await dashboard.mcp.callTool({ name: 'canonry_measurement_overview', arguments: { project: 'project-adv', scope: 'all' } }), 'canonry_measurement_overview')
    } finally {
      await dashboard.close()
    }
  })

  it('legacy read and embed credentials keep their backward-compatible reads over MCP', async () => {
    const read = await mcpFor(READ_KEY)
    try {
      expectAllowed(await read.mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-a' } }), 'canonry_project_overview')
      expectAllowed(await read.mcp.callTool({ name: 'canonry_queries_list', arguments: { project: 'project-a' } }), 'canonry_queries_list')
    } finally {
      await read.close()
    }
    const embed = await mcpFor(EMBED_KEY)
    try {
      expectAllowed(await embed.mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-a' } }), 'canonry_project_overview')
      expectForbidden(await embed.mcp.callTool({ name: 'canonry_queries_list', arguments: { project: 'project-a' } }), 'canonry_queries_list')
    } finally {
      await embed.close()
    }
  })

  it('a project-scoped key cannot read another project over MCP', async () => {
    const { mcp, close } = await mcpFor(SCOPED_KEY)
    try {
      expectAllowed(await mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-a' } }), 'canonry_project_overview')
      expectForbidden(await mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'project-b' } }), 'canonry_project_overview')
    } finally {
      await close()
    }
  })
})
