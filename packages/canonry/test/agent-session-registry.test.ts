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
import { MemorySources } from '@ainyc/canonry-contracts'
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
    expect(row!.modelProvider).toBe('claude')
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

  it('drainNow hydrates a cold session and processes DB-queued follow-ups', async () => {
    // Regression: drainNow used to check only the in-memory pending map
    // and bail early on cold / post-restart sessions. queueFollowUp on a
    // cold session persists to the DB follow-up queue, so proactive
    // wake-up after run.completed never fired until a manual prompt
    // hydrated the session — the follow-up just sat in the DB.
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })

    // Pre-warm the session, swap in the faux model so the subsequent drain
    // has a usable backend, then evict WITHOUT clearing pending so the
    // queue flows through the DB (cold-session code path).
    const warm = registry.getOrCreate('demo')
    warm.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Acknowledged.')])
    registry.evict('demo')

    // Cold-session enqueue — lands in DB queue (not in-memory pending).
    registry.queueFollowUp('demo', {
      role: 'user',
      content: '[system] run.completed while cold',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    expect(registry.isLive('demo')).toBe(false)
    expect(registry.peekPending('demo')).toHaveLength(0)
    const beforeRow = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(parseJsonColumn<AgentMessage[]>(beforeRow!.followUpQueue, [])).toHaveLength(1)

    await registry.drainNow('demo')

    // Fix: drain no longer returns early on cold sessions.
    expect(registry.isLive('demo')).toBe(true)
    expect(registry.peekPending('demo')).toHaveLength(0)
    const afterRow = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(parseJsonColumn<AgentMessage[]>(afterRow!.followUpQueue, [])).toEqual([])

    // Re-hydrated agent rebuilds with the default model, so replace it
    // with faux before asserting a prompt landed. (The drain itself ran
    // against a fresh agent whose default model was fine for construction;
    // we're verifying the queue-clearing side effect here.)
    const rehydrated = registry.getOrCreate('demo')
    expect(
      rehydrated.state.messages.some(
        (m) => (m as { content: string }).content === '[system] run.completed while cold',
      ),
    ).toBe(true)
  })

  it('reset clears live agent, in-memory pending, and scope cache', () => {
    // Regression: DELETE /agent/transcript wiped the DB row but called
    // evict(), which only drops the live Agent. The in-memory pending map
    // and scope cache survived, so a system follow-up queued on a hot
    // session would leak into the next prompt after the reset.
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    registry.getOrCreate('demo', { toolScope: 'read-only' })

    registry.queueFollowUp('demo', {
      role: 'user',
      content: 'queued before reset',
      timestamp: Date.now(),
    } as unknown as AgentMessage)
    expect(registry.peekPending('demo')).toHaveLength(1)
    expect(registry.isLive('demo')).toBe(true)
    expect(
      (registry as unknown as { scopes: Map<string, string> }).scopes.get('demo'),
    ).toBe('read-only')

    registry.reset('demo')

    expect(registry.isLive('demo')).toBe(false)
    expect(registry.peekPending('demo')).toHaveLength(0)
    expect(
      (registry as unknown as { scopes: Map<string, string> }).scopes.get('demo'),
    ).toBeUndefined()
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

  it('drainNow preserves a read-only session scope and does not escalate to write tools', async () => {
    // Regression: drainNow used to call acquireForTurn with no preferences,
    // so alignScope defaulted wantScope to 'all' and silently upgraded a
    // read-only dashboard session to the full 13-tool write surface during
    // a system-triggered proactive drain.
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo', { toolScope: 'read-only' })
    agent.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Acknowledged.')])

    expect(agent.state.tools.length).toBe(10) // 8 read (incl. recall) + 2 skill-doc

    registry.queueFollowUp('demo', {
      role: 'user',
      content: '[system] run.completed',
      timestamp: Date.now(),
    } as unknown as AgentMessage)

    await registry.drainNow('demo')

    expect(agent.state.tools.length).toBe(10)
  })

  it('drainNow defaults to read-only when no session scope is set yet', async () => {
    // Fail-closed: if somehow a drain fires before any user turn has
    // established a scope, we should default to the read-only surface
    // rather than the full write surface.
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    // Create the row without a live agent, then seed a queued follow-up.
    registry.getOrCreate('demo')
    registry.evict('demo')

    const now = new Date().toISOString()
    db.update(agentSessions)
      .set({
        followUpQueue: JSON.stringify([
          { role: 'user', content: '[system] run.completed', timestamp: Date.now() },
        ]),
        updatedAt: now,
      })
      .where(eq(agentSessions.projectId, projectId))
      .run()

    const agent = registry.getOrCreate('demo') // hydrates; defaults scope to 'all' in cache
    agent.state.model = faux.getModel()
    faux.setResponses([fauxAssistantMessage('Acknowledged.')])

    // Clear the scope cache so drainNow falls through the `?? 'read-only'` branch
    ;(registry as unknown as { scopes: Map<string, string> }).scopes.delete('demo')

    await registry.drainNow('demo')

    expect(agent.state.tools.length).toBe(10) // 8 read (incl. recall) + 2 skill-doc
  })

  it('acquireForTurn compacts the transcript when it crosses the threshold, rehydrates the system prompt, and persists a compaction note', async () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    agent.state.model = faux.getModel()

    // Build a transcript long enough that shouldCompact() fires via message-count cap.
    // COMPACTION_MAX_MESSAGES (400) messages, alternating user/assistant so findSafeSplit
    // can land on a user boundary.
    const bulk: AgentMessage[] = []
    for (let i = 0; i < 420; i++) {
      bulk.push(
        i % 2 === 0
          ? ({ role: 'user', content: `u${i}`, timestamp: 0 } as AgentMessage)
          : ({
              role: 'assistant',
              content: [{ type: 'text', text: `a${i}` }],
              api: 'faux-api',
              provider: 'faux',
              model: 'faux-model',
              usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: 0,
            } as AgentMessage),
      )
    }
    agent.state.messages = bulk

    // Faux response feeds the summarizer's `complete()` call.
    faux.setResponses([
      fauxAssistantMessage('- Compacted older turns: user asked about status; agent ran sweeps.'),
    ])

    const basePrompt = agent.state.systemPrompt

    await registry.acquireForTurn('demo')

    // Transcript shrank — the prefix was rolled into a memory note.
    expect(agent.state.messages.length).toBeLessThan(bulk.length)
    // System prompt now carries the hydrated `<memory>` block with the new compaction note.
    expect(agent.state.systemPrompt).not.toBe(basePrompt)
    expect(agent.state.systemPrompt).toContain('<memory>')
    expect(agent.state.systemPrompt).toContain('[compaction]')

    // Persisted compaction row in agent_memory.
    const { agentMemory } = await import('@ainyc/canonry-db')
    const rows = db.select().from(agentMemory).where(eq(agentMemory.projectId, projectId)).all()
    expect(rows.some((r) => r.source === MemorySources.compaction)).toBe(true)
  })

  it('rehydrateLiveMemory rebuilds the live agent system prompt with the latest notes', async () => {
    const projectId = insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    const promptBefore = agent.state.systemPrompt
    expect(promptBefore).not.toContain('<memory>')

    const { upsertMemoryEntry } = await import('../src/agent/memory-store.js')
    upsertMemoryEntry(db, {
      projectId,
      key: 'default-provider',
      value: 'Claude',
      source: MemorySources.user,
    })

    registry.rehydrateLiveMemory('demo')

    expect(agent.state.systemPrompt).not.toBe(promptBefore)
    expect(agent.state.systemPrompt).toContain('<memory>')
    expect(agent.state.systemPrompt).toContain('default-provider')
  })

  it('rehydrateLiveMemory is a no-op when no live agent exists', () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    // Should not throw — no live agent yet.
    expect(() => registry.rehydrateLiveMemory('demo')).not.toThrow()
    expect(registry.isLive('demo')).toBe(false)
  })

  it('acquireForTurn throws AGENT_BUSY without mutating tools when streaming', async () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    // Drive it into the streaming state so the busy guard fires.
    ;(agent.state as unknown as { isStreaming: boolean }).isStreaming = true

    const toolsBefore = agent.state.tools
    const toolsBeforeLen = toolsBefore.length

    let caught: unknown
    try {
      await registry.acquireForTurn('demo', { toolScope: 'read-only' })
    } catch (err) {
      caught = err
    }

    expect((caught as { code?: string })?.code).toBe('AGENT_BUSY')
    // Critical: tools must NOT have been swapped despite the scope mismatch.
    expect(agent.state.tools).toBe(toolsBefore)
    expect(agent.state.tools.length).toBe(toolsBeforeLen)
  })

  it('acquireForTurn aligns tool scope on cached agents when idle', async () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo')
    expect(agent.state.tools.length).toBe(18) // 8 read + 8 write (incl. remember/forget) + 2 skill-doc

    await registry.acquireForTurn('demo', { toolScope: 'read-only' })

    expect(agent.state.tools.length).toBe(10) // 8 read (incl. recall) + 2 skill-doc
  })

  it('acquireForTurn swaps model on cached agents when preferences change', async () => {
    insertProject(db, 'demo')
    const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
    const agent = registry.getOrCreate('demo', { provider: 'claude' })
    const originalModelId = (agent.state.model as { id: string }).id

    await registry.acquireForTurn('demo', { provider: 'zai', modelId: 'glm-5.1' })

    const newModelId = (agent.state.model as { id: string }).id
    expect(newModelId).not.toBe(originalModelId)
    expect(newModelId).toContain('glm')

    // Persisted back to the DB row
    const projectId = db.select({ id: projects.id }).from(projects).where(eq(projects.name, 'demo')).get()!.id
    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    expect(row?.modelProvider).toBe('zai')
    expect(row?.modelId).toBe('glm-5.1')
  })
})
