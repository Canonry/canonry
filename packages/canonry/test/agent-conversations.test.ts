import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { agentConversations, agentMemory, agentSessions, createClient, migrate, MIGRATION_VERSIONS, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { AppError, MemorySources, agentConversationListSchema, agentConversationSchema } from '@ainyc/canonry-contracts'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { loadRecentForHydrate, upsertMemoryEntry, writeCompactionNote } from '../src/agent/memory-store.js'
import { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let registry: SessionRegistry
const config = { apiKey: 'test', providers: { claude: { apiKey: 'test' } } } as CanonryConfig
const messages = [{ role: 'user' as const, content: 'Explain the London Property', timestamp: 1, aeroContext: { view: 'property', selection: { scope: 'property', scopeKey: 'hotel', marketKey: 'london', queryClass: 'non-brand' } } }]
const current = () => db.select().from(agentSessions).where(eq(agentSessions.projectId, 'demo')).get()!
const url = '/api/v1/projects/demo/agent/conversations'
const create = (id = crypto.randomUUID()) => app.inject({ method: 'POST', url, payload: { id } })

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-history-'))
  db = createClient(path.join(directory, 'data.db'))
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 158))
  const now = '2026-09-01T10:00:00.000Z'
  for (const name of ['demo', 'other']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(agentSessions).values({ id: 'legacy', projectId: 'demo', systemPrompt: 'Old installed prompt', modelProvider: 'claude', modelId: 'claude-opus-4-7', messages: JSON.stringify(messages), followUpQueue: '[]', createdAt: now, updatedAt: now }).run()
  migrate(db)
  registry = new SessionRegistry({ db, client: {} as ApiClient, config, proactive: false })
  app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.status(500).send(error)
  })
  await app.register(async scope => { registerAgentRoutes(scope, { db, sessionRegistry: registry }) }, { prefix: '/api/v1' })
  await app.ready()
})
afterEach(async () => { vi.restoreAllMocks(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })

it('migrates the existing transcript without rewriting it and paginates only this project', async () => {
  expect(current()).toMatchObject({ id: 'legacy', messages: JSON.stringify(messages), updatedAt: '2026-09-01T10:00:00.000Z' })
  const first = agentConversationListSchema.parse((await app.inject(url)).json())
  expect(first).toMatchObject({ conversations: [{ id: 'legacy', title: 'Explain the London Property', active: true }], currentConversationId: 'legacy', nextOffset: null })
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  for (const id of ids) expect((await create(id)).statusCode).toBe(200)
  const page = (await app.inject(`${url}?limit=2`)).json()
  const rest = (await app.inject(`${url}?limit=2&offset=${page.nextOffset}`)).json()
  expect(page.conversations).toHaveLength(3)
  expect(rest.conversations).toHaveLength(1)
  expect(rest.nextOffset).toBeNull()
  expect(new Set([...page.conversations, ...rest.conversations].map(row => row.id))).toEqual(new Set(['legacy', ...ids]))
  expect((await app.inject('/api/v1/projects/other/agent/conversations')).json().conversations).toEqual([])
  expect((await app.inject(`${url}?limit=0`)).statusCode).toBe(400)
})

it('archives, reopens, and restores transcript/model/context after the registry restarts', async () => {
  const id = crypto.randomUUID()
  const fresh = agentConversationSchema.parse((await create(id)).json())
  expect(fresh).toMatchObject({ id, active: true, messages: [], modelId: 'claude-opus-4-7' })
  expect((await app.inject(`${url}/legacy`)).json()).toMatchObject({ active: false, messages })
  registry.clear()
  expect(registry.getOrCreate('demo').state.messages).toEqual([])
  const resumed = await app.inject({ method: 'POST', url: `${url}/legacy/resume` })
  expect(resumed.statusCode).toBe(200)
  expect(resumed.json()).toMatchObject({ id: 'legacy', active: true, messages })
  expect(registry.getOrCreate('demo').state.messages).toEqual(messages)
  expect((await create(id)).json()).toMatchObject({ id, active: false })
  expect(current().id).toBe('legacy') // replay of creation cannot switch context again
  expect((await app.inject({ method: 'POST', url: `${url}/legacy/resume` })).statusCode).toBe(200)
  expect(db.select().from(agentConversations).all()).toHaveLength(1)
})

it('keeps project notes, isolates compaction before LIMIT, and deletes only the selected summaries', async () => {
  upsertMemoryEntry(db, { projectId: 'demo', key: 'cadence', value: 'Weekly reports', source: MemorySources.user })
  writeCompactionNote(db, { projectId: 'demo', sessionId: 'legacy', summary: 'Private old context', removedCount: 10 })
  expect(registry.getOrCreate('demo').state.systemPrompt).toContain('Private old context')
  const id = crypto.randomUUID()
  await create(id)
  const fresh = registry.getOrCreate('demo')
  expect(fresh.state.systemPrompt).toContain('Weekly reports')
  expect(fresh.state.systemPrompt).not.toContain('Private old context')
  expect(loadRecentForHydrate(db, 'demo', 1, id).map(note => note.key)).toEqual(['cadence'])
  await app.inject({ method: 'POST', url: `${url}/legacy/resume` })
  expect(registry.getOrCreate('demo').state.systemPrompt).toContain('Private old context')
  await app.inject({ method: 'DELETE', url: `${url}/legacy` })
  expect(db.select().from(agentMemory).all().map(note => note.key)).toEqual(['cadence'])
  expect(registry.isLive('demo')).toBe(false)
  expect((await app.inject('/api/v1/projects/demo/agent/transcript')).json()).toMatchObject({ conversationId: null, messages: [] })
  expect((await app.inject({ method: 'DELETE', url: `${url}/legacy` })).json()).toEqual({ id: 'legacy', status: 'deleted' })
  expect((await app.inject(`${url}/${id}`)).statusCode).toBe(200)
})

it('preserves pending followups with their conversation and refuses changes during acquisition or streaming', async () => {
  registry = new SessionRegistry({ db, client: {} as ApiClient, config })
  // The original route registry is prompt-only; exercise its durable queue boundary.
  db.update(agentSessions).set({ followUpQueue: JSON.stringify(messages) }).where(eq(agentSessions.id, 'legacy')).run()
  const busy = vi.spyOn(SessionRegistry.prototype, 'isBusy').mockReturnValue(true)
  expect((await create()).statusCode).toBe(409)
  expect((await app.inject({ method: 'DELETE', url: `${url}/legacy` })).statusCode).toBe(409)
  expect((await app.inject({ method: 'DELETE', url: '/api/v1/projects/demo/agent/transcript' })).statusCode).toBe(409)
  busy.mockRestore()
  await create()
  expect(db.select().from(agentConversations).all()[0].followUpQueue).toEqual(messages)
  expect(current().followUpQueue).toBe('[]')
  await app.inject({ method: 'POST', url: `${url}/legacy/resume` })
  expect(registry.getOrCreate('demo')).toBeTruthy()
  expect(registry.peekPending('demo')).toEqual(messages)
})

it('rolls back an archive and active change together if a transaction fails', async () => {
  db.run(sql.raw("CREATE TRIGGER reject_conversation_update BEFORE UPDATE ON agent_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END"))
  expect((await create()).statusCode).toBe(500)
  expect(current().id).toBe('legacy')
  expect(db.select().from(agentConversations).all()).toEqual([])
})

it('refuses cross-project reads/resumes and validates the requested prompt conversation before any provider call', async () => {
  expect((await create('not-a-uuid')).statusCode).toBe(400)
  for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url: `/api/v1/projects/other/agent/conversations/legacy${method === 'POST' ? '/resume' : ''}` })).statusCode).toBe(404)
  expect((await app.inject({ method: 'DELETE', url: '/api/v1/projects/other/agent/conversations/legacy' })).statusCode).toBe(200)
  expect(current().id).toBe('legacy')
  const response = await app.inject({ method: 'POST', url: '/api/v1/projects/demo/agent/prompt', payload: { prompt: 'Continue', conversationId: 'stale-id' } })
  expect(response.statusCode).toBe(400)
  expect(response.body).toContain('active conversation changed')
})

it('MCP tools use the public client across HTTP and preserve API response shapes', async () => {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  const client = new ApiClient(`http://127.0.0.1:${address.port}`, 'test')
  const id = crypto.randomUUID()
  const tool = (name: string) => canonryMcpTools.find(entry => entry.name === name)!
  const created = await tool('canonry_agent_conversations_new').handler(client, { project: 'demo', id })
  expect(created).toMatchObject({ id, active: true, messages: [] })
  const list = await tool('canonry_agent_conversations_list').handler(client, { project: 'demo', limit: 1 })
  expect(list).toEqual((await app.inject(`${url}?limit=1`)).json())
  expect(await tool('canonry_agent_conversations_get').handler(client, { project: 'demo', id: 'legacy' })).toMatchObject({ id: 'legacy', messages })
  expect(await tool('canonry_agent_conversations_resume').handler(client, { project: 'demo', id: 'legacy' })).toMatchObject({ id: 'legacy', active: true })
  expect(await tool('canonry_agent_conversations_delete').handler(client, { project: 'demo', id })).toEqual({ id, status: 'deleted' })
})
