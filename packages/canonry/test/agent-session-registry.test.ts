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

  it('hydrates an evicted session from the DB and surfaces persisted queue as pending', () => {
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

    // Persisted queue is pulled into the registry's pending buffer, not pi's follow-up queue
    expect(registry.peekPending('demo')).toHaveLength(1)

    // DB queue cleared once pulled into pending
    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(parseJsonColumn<AgentMessage[]>(row!.followUpQueue, [])).toEqual([])
  })

  it('queueFollowUp on a live session lands in pending (consumed on next prompt)', () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    registry.getOrCreate('demo')

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'run.completed hook fired',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    expect(registry.peekPending('demo')).toHaveLength(1)

    // consumePending drains the buffer
    const drained = registry.consumePending('demo')
    expect(drained).toHaveLength(1)
    expect(registry.peekPending('demo')).toHaveLength(0)
  })

  it('queueFollowUp on an idle (evicted) session writes to the DB queue', () => {
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

  it('queueFollowUp creates a session row on the fly when none exists', () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'arrived before anyone opened the session',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(row).toBeDefined()
    const queue = parseJsonColumn<AgentMessage[]>(row!.followUpQueue, [])
    expect(queue).toHaveLength(1)
  })

  it('drainNow prompts the live agent with pending messages and clears them', async () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    agent.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Acknowledged.')])

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'run just completed — please review',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    expect(registry.peekPending('demo')).toHaveLength(1)

    await registry.drainNow('demo')

    expect(registry.peekPending('demo')).toHaveLength(0)
    // Transcript now includes the user event + an assistant reply
    expect(agent.state.messages.length).toBeGreaterThanOrEqual(2)
    expect(agent.state.messages[agent.state.messages.length - 1].role).toBe('assistant')
  })

  it('drainNow is a no-op when there are no pending messages', async () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    const before = agent.state.messages.length

    await registry.drainNow('demo')

    expect(agent.state.messages.length).toBe(before)
  })

  it('does not duplicate a message queued while idle when drainNow hydrates the session', async () => {
    // Regression: the first end-to-end dogfood showed the [system] message
    // appearing twice in the transcript because queueFollowUp wrote to both
    // the in-memory pending Map AND the DB follow_up_queue, then getOrCreate
    // migrated the DB queue INTO pending, producing a second copy.
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    // Pre-warm a session then evict so we're in the "idle with row" state
    registry.getOrCreate('demo')
    registry.evict('demo')

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'only once please',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    // drainNow internally hydrates via getOrCreate
    const agent = registry.getOrCreate('demo')
    agent.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Acknowledged.')])

    await registry.drainNow('demo')

    // Count how many times the original content appears in the agent transcript
    const count = agent.state.messages.filter(
      (m) =>
        (m as { role: string }).role === 'user' &&
        typeof (m as { content: unknown }).content === 'string' &&
        (m as { content: string }).content === 'only once please',
    ).length
    expect(count).toBe(1)
  })
})
