import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  AGENT_MEMORY_VALUE_MAX_BYTES,
  MemorySources,
} from '@ainyc/canonry-contracts'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { buildReadTools, buildWriteTools, type ToolContext } from '../src/agent/tools.js'
import {
  COMPACTION_KEY_PREFIX,
  listMemoryEntries,
  writeCompactionNote,
} from '../src/agent/memory-store.js'
import type { ApiClient } from '../src/client.js'

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

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

function findTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool "${name}" not found`)
  return tool
}

describe('remember / forget / recall tools', () => {
  let tmpDir: string
  let db: DatabaseClient
  let projectId: string
  let ctx: ToolContext

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-memory-tools-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = insertProject(db, 'demo')
    ctx = { client: stubClient(), projectName: 'demo', db, projectId }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('remember → recall returns the stored note', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    await remember.execute('call-1', {
      key: 'preferred-provider',
      value: 'Claude is the default; OpenAI is the backup.',
    })

    const recall = findTool(buildReadTools(ctx), 'recall')
    const result = await recall.execute('call-2', {})
    const details = result.details as { entries: Array<{ key: string; value: string; source: string }> }

    expect(details.entries).toHaveLength(1)
    expect(details.entries[0].key).toBe('preferred-provider')
    expect(details.entries[0].value).toContain('Claude is the default')
    expect(details.entries[0].source).toBe(MemorySources.aero)
  })

  it('remember is upsert — same key replaces the prior value', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    await remember.execute('call-1', { key: 'status', value: 'first' })
    await remember.execute('call-2', { key: 'status', value: 'second' })

    const entries = listMemoryEntries(db, projectId)
    expect(entries).toHaveLength(1)
    expect(entries[0].value).toBe('second')
  })

  it('remember rejects values over the 2 KB cap', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    const oversize = 'x'.repeat(AGENT_MEMORY_VALUE_MAX_BYTES + 1)
    await expect(
      remember.execute('call-1', { key: 'too-big', value: oversize }),
    ).rejects.toThrow(/exceeds/)
  })

  it('remember rejects the reserved compaction: key prefix', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    await expect(
      remember.execute('call-1', { key: `${COMPACTION_KEY_PREFIX}abc`, value: 'nope' }),
    ).rejects.toThrow(/reserved/)
  })

  it('forget removes a note and reports status=forgotten', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    const forget = findTool(buildWriteTools(ctx), 'forget')

    await remember.execute('call-1', { key: 'drop-me', value: 'transient' })
    const result = await forget.execute('call-2', { key: 'drop-me' })
    const details = result.details as { status: string; key: string }

    expect(details.status).toBe('forgotten')
    expect(details.key).toBe('drop-me')
    expect(listMemoryEntries(db, projectId)).toHaveLength(0)
  })

  it('forget returns status=missing when the key does not exist', async () => {
    const forget = findTool(buildWriteTools(ctx), 'forget')
    const result = await forget.execute('call-1', { key: 'never-was-there' })
    const details = result.details as { status: string; key: string }

    expect(details.status).toBe('missing')
    expect(details.key).toBe('never-was-there')
  })

  it('forget rejects keys with the reserved compaction: prefix', async () => {
    // Seed a compaction note so we know it survives a failed forget attempt.
    writeCompactionNote(db, {
      projectId,
      sessionId: 'sess-1',
      summary: 'compacted-slice',
      removedCount: 10,
    })
    const forget = findTool(buildWriteTools(ctx), 'forget')
    await expect(
      forget.execute('call-1', { key: `${COMPACTION_KEY_PREFIX}sess-1:foo` }),
    ).rejects.toThrow(/reserved/)
    expect(listMemoryEntries(db, projectId)).toHaveLength(1)
  })

  it('memory is project-scoped — one project cannot recall another project\'s notes', async () => {
    const otherProjectId = insertProject(db, 'other')
    const otherCtx: ToolContext = {
      client: stubClient(),
      projectName: 'other',
      db,
      projectId: otherProjectId,
    }
    const remember = findTool(buildWriteTools(ctx), 'remember')
    const otherRemember = findTool(buildWriteTools(otherCtx), 'remember')

    await remember.execute('call-1', { key: 'demo-only', value: 'secret-demo' })
    await otherRemember.execute('call-2', { key: 'other-only', value: 'secret-other' })

    const recallDemo = findTool(buildReadTools(ctx), 'recall')
    const recallOther = findTool(buildReadTools(otherCtx), 'recall')

    const demoResult = await recallDemo.execute('call-3', {})
    const otherResult = await recallOther.execute('call-4', {})

    const demoEntries = (demoResult.details as { entries: Array<{ key: string }> }).entries
    const otherEntries = (otherResult.details as { entries: Array<{ key: string }> }).entries

    expect(demoEntries.map((e) => e.key)).toEqual(['demo-only'])
    expect(otherEntries.map((e) => e.key)).toEqual(['other-only'])
  })

  it('recall honors the limit parameter and returns newest-first', async () => {
    const remember = findTool(buildWriteTools(ctx), 'remember')
    // Insert five notes in order. Because each insert sets updatedAt to now,
    // serialize them with a micro-delay so the ORDER BY is deterministic.
    await remember.execute('call-1', { key: 'a', value: '1' })
    await new Promise((r) => setTimeout(r, 5))
    await remember.execute('call-2', { key: 'b', value: '2' })
    await new Promise((r) => setTimeout(r, 5))
    await remember.execute('call-3', { key: 'c', value: '3' })

    const recall = findTool(buildReadTools(ctx), 'recall')
    const result = await recall.execute('call-4', { limit: 2 })
    const entries = (result.details as { entries: Array<{ key: string }> }).entries

    expect(entries).toHaveLength(2)
    expect(entries[0].key).toBe('c')
    expect(entries[1].key).toBe('b')
  })
})
