import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { AppError, MemorySources } from '@ainyc/canonry-contracts'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import {
  COMPACTION_KEY_PREFIX,
  upsertMemoryEntry,
  writeCompactionNote,
} from '../src/agent/memory-store.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

function stubConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: { claude: { apiKey: 'anthropic-key' } },
  } as CanonryConfig
}

function insertProject(db: DatabaseClient, name: string): string {
  const id = `proj_${name}_${crypto.randomUUID()}`
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

describe('agent memory HTTP routes', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: FastifyInstance
  let registry: SessionRegistry

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-memory-routes-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    insertProject(db, 'demo')
    registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })

    app = Fastify()
    // Mirror the production error handler so AppError -> structured JSON.
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(error.toJSON())
      }
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } })
    })
    registerAgentRoutes(app, { db, sessionRegistry: registry })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET returns an empty entries list when no notes exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/demo/agent/memory' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [] })
  })

  it('PUT upserts a note with source=user and GET returns it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'operator-pref', value: 'EU-first reporting' },
    })
    expect(put.statusCode).toBe(200)
    const putBody = put.json() as { status: string; entry: { key: string; source: string; value: string } }
    expect(putBody.status).toBe('ok')
    expect(putBody.entry.key).toBe('operator-pref')
    expect(putBody.entry.source).toBe(MemorySources.user)

    const list = await app.inject({ method: 'GET', url: '/projects/demo/agent/memory' })
    const body = list.json() as { entries: Array<{ key: string; value: string; source: string }> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].key).toBe('operator-pref')
    expect(body.entries[0].value).toBe('EU-first reporting')
    expect(body.entries[0].source).toBe(MemorySources.user)
  })

  it('PUT is idempotent — writing the same key replaces the value', async () => {
    await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'k', value: 'first' },
    })
    await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'k', value: 'second' },
    })

    const list = await app.inject({ method: 'GET', url: '/projects/demo/agent/memory' })
    const body = list.json() as { entries: Array<{ value: string }> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].value).toBe('second')
  })

  it('DELETE removes a note and reports status=forgotten', async () => {
    await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'drop-me', value: 'x' },
    })

    const del = await app.inject({
      method: 'DELETE',
      url: '/projects/demo/agent/memory',
      payload: { key: 'drop-me' },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ status: 'forgotten', key: 'drop-me' })

    const list = await app.inject({ method: 'GET', url: '/projects/demo/agent/memory' })
    expect((list.json() as { entries: unknown[] }).entries).toEqual([])
  })

  it('DELETE returns status=missing when the key does not exist', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: '/projects/demo/agent/memory',
      payload: { key: 'never-was-there' },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ status: 'missing', key: 'never-was-there' })
  })

  it('PUT rejects the reserved compaction: prefix with a validation error', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: `${COMPACTION_KEY_PREFIX}mine`, value: 'nope' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/reserved/)
  })

  it('DELETE rejects the reserved compaction: prefix', async () => {
    // Seed a compaction note directly so we can verify DELETE refuses it.
    writeCompactionNote(db, {
      projectId: db.select({ id: projects.id }).from(projects).get()!.id,
      sessionId: 'sess-1',
      summary: 'compaction data',
      removedCount: 5,
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/projects/demo/agent/memory',
      payload: { key: `${COMPACTION_KEY_PREFIX}sess-1:foo` },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('PUT rejects oversized values', async () => {
    const oversize = 'x'.repeat(3 * 1024)
    const res = await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'too-big', value: oversize },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('PUT rejects bodies missing required fields', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: '' }, // empty key + missing value
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the project does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/missing/agent/memory' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('PUT and DELETE rehydrate the live session so the next turn sees the edit', async () => {
    // Force a live agent for the project.
    const agent = registry.getOrCreate('demo')
    const promptBefore = agent.state.systemPrompt
    expect(promptBefore).not.toContain('<memory>')

    const put = await app.inject({
      method: 'PUT',
      url: '/projects/demo/agent/memory',
      payload: { key: 'default-provider', value: 'Claude' },
    })
    expect(put.statusCode).toBe(200)
    expect(agent.state.systemPrompt).not.toBe(promptBefore)
    expect(agent.state.systemPrompt).toContain('default-provider')

    const del = await app.inject({
      method: 'DELETE',
      url: '/projects/demo/agent/memory',
      payload: { key: 'default-provider' },
    })
    expect(del.statusCode).toBe(200)
    // After delete, the block is empty again and the prompt reverts to the base.
    expect(agent.state.systemPrompt).not.toContain('default-provider')
  })

  it('memory is project-scoped', async () => {
    const otherId = insertProject(db, 'other')
    upsertMemoryEntry(db, {
      projectId: otherId,
      key: 'other-only',
      value: 'secret',
      source: MemorySources.user,
    })

    const res = await app.inject({ method: 'GET', url: '/projects/demo/agent/memory' })
    const body = res.json() as { entries: Array<{ key: string }> }
    expect(body.entries.map((e) => e.key)).not.toContain('other-only')
  })
})
