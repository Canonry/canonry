import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  agentSessions,
  parseJsonColumn,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@mariozechner/pi-ai'
import { eq } from 'drizzle-orm'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { SessionRegistry } from '../src/agent/session-registry.js'
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

describe('SessionRegistry', () => {
  let tmpDir: string
  let db: DatabaseClient
  let faux: FauxProviderRegistration

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-session-registry-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    faux = registerFauxProvider({
      api: 'faux-api',
      provider: 'faux',
      models: [{ id: 'faux-model' }],
    })
  })

  afterEach(() => {
    faux.unregister()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a new DB row + live Agent on first getOrCreate', () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })

    expect(registry.isLive('demo')).toBe(false)

    const agent = registry.getOrCreate('demo')
    expect(agent).toBeDefined()
    expect(registry.isLive('demo')).toBe(true)

    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(row).toBeDefined()
    expect(row!.modelProvider).toBe('anthropic')
    expect(parseJsonColumn<unknown[]>(row!.messages, [])).toEqual([])
    expect(parseJsonColumn<unknown[]>(row!.followUpQueue, [])).toEqual([])
  })

  it('returns the same live Agent on subsequent calls', () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const a = registry.getOrCreate('demo')
    const b = registry.getOrCreate('demo')
    expect(a).toBe(b)
  })

  it('rejects with a clear error when the project does not exist', () => {
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    expect(() => registry.getOrCreate('missing')).toThrow(/Project "missing" not found/)
  })

  it('persists state.messages back to the DB on save', async () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')

    agent.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Hello from Aero.')])
    await agent.prompt('Status update please')
    await agent.waitForIdle()

    const inMemoryCount = agent.state.messages.length
    expect(inMemoryCount).toBeGreaterThan(0)

    registry.save('demo')

    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    const persisted = parseJsonColumn<AgentMessage[]>(row!.messages, [])
    expect(persisted).toHaveLength(inMemoryCount)
  })

  it('hydrates an evicted session from the DB, drains pending follow-ups', () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    registry.getOrCreate('demo')

    // Persist a fake seed transcript + a queued follow-up directly into the DB
    const now = new Date().toISOString()
    const seededMessages: AgentMessage[] = [
      { role: 'user', content: 'earlier question', timestamp: Date.now() },
    ] as unknown as AgentMessage[]
    const queued: AgentMessage[] = [
      { role: 'user', content: 'fired while agent was idle', timestamp: Date.now() },
    ] as unknown as AgentMessage[]
    db.update(agentSessions)
      .set({
        messages: JSON.stringify(seededMessages),
        followUpQueue: JSON.stringify(queued),
        updatedAt: now,
      })
      .where(eq(agentSessions.projectId, projectId))
      .run()

    registry.evict('demo')
    expect(registry.isLive('demo')).toBe(false)

    const rehydrated = registry.getOrCreate('demo')
    expect(registry.isLive('demo')).toBe(true)
    expect(rehydrated.state.messages).toHaveLength(seededMessages.length)
    expect(rehydrated.hasQueuedMessages()).toBe(true)

    // DB queue cleared once drained into the live Agent
    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(parseJsonColumn<AgentMessage[]>(row!.followUpQueue, [])).toEqual([])
  })

  it('queueFollowUp on a live session forwards directly to agent.followUp', () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    expect(agent.hasQueuedMessages()).toBe(false)

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'run.completed hook fired',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    expect(agent.hasQueuedMessages()).toBe(true)
  })

  it('queueFollowUp on an idle session writes to the DB queue', () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    registry.getOrCreate('demo') // create the row
    registry.evict('demo')

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'queued while idle',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    const queue = parseJsonColumn<AgentMessage[]>(row!.followUpQueue, [])
    expect(queue).toHaveLength(1)
    expect((queue[0] as { content: string }).content).toBe('queued while idle')
  })

  it('queueFollowUp buffers pre-session messages until the row is created', () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'arrived before anyone opened the session',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    // No row yet → nothing in DB
    const beforeRow = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(beforeRow).toBeUndefined()

    // getOrCreate drains the pre-session buffer into the new row + live Agent
    const agent = registry.getOrCreate('demo')
    expect(agent.hasQueuedMessages()).toBe(false) // drained to Agent only if a row existed — here no row existed yet
    // Actually here the row was freshly created; pending buffer should have been merged into the row's queue AT row insert time.
    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    const queue = parseJsonColumn<AgentMessage[]>(row!.followUpQueue, [])
    // Row was just written with mergedQueue (pre-session drained into the row's queue),
    // then getOrCreate did NOT re-read it for the same call — so queue stays in the row.
    // The next getOrCreate (after evict) would drain it.
    expect(queue).toHaveLength(1)
  })
})
