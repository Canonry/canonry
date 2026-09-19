/**
 * Prompt-only Aero: interactive, but it never wakes itself.
 *
 * Three states, not two. `disabled` removes the agent entirely; `prompt-only`
 * keeps every interactive surface and removes only the proactive wake on run
 * completion; absent keeps today's behaviour, where runs wake the agent. They
 * live on one config field so "off but proactive" cannot be expressed.
 *
 * The enforcing layer is the registry, not the caller. `server.ts` returns
 * early from the run-completion callback, but a follow-up may already be sitting
 * in `agent_sessions.follow_up_queue` from before the mode was set, and the
 * interactive prompt path bundles pending messages in front of the next turn.
 * So prompt-only also has to mean: nothing new is queued, nothing drains, and
 * nothing already queued rides along on a later interactive turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  agentSessions,
  createClient,
  migrate,
  parseJsonColumn,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@mariozechner/pi-ai'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { resolveAgentEnabled, resolveAgentProactiveEnabled } from '../src/agent-config.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { createServer } from '../src/server.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

function cfg(agent?: CanonryConfig['agent']): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    ...(agent ? { agent } : {}),
  } as CanonryConfig
}

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

function followUp(content: string): AgentMessage {
  return { role: 'user', content, timestamp: Date.now() } as unknown as AgentMessage
}

describe('resolveAgentProactiveEnabled', () => {
  it('defaults to proactive, so existing installs are unchanged', () => {
    expect(resolveAgentProactiveEnabled({}, cfg())).toBe(true)
  })

  it('config agent.mode "prompt-only" stops the proactive wake', () => {
    expect(resolveAgentProactiveEnabled({}, cfg({ mode: 'prompt-only' }))).toBe(false)
  })

  it('prompt-only is still ENABLED — it is not a second kill switch', () => {
    expect(resolveAgentEnabled({}, cfg({ mode: 'prompt-only' }))).toBe(true)
  })

  it.each(['1', 'true', 'TRUE'])('CANONRY_AGENT_PROMPT_ONLY=%s stops the wake', (value) => {
    expect(resolveAgentProactiveEnabled({ CANONRY_AGENT_PROMPT_ONLY: value }, cfg())).toBe(false)
  })

  it.each(['0', 'false'])('CANONRY_AGENT_PROMPT_ONLY=%s forces the wake back on', (value) => {
    // Env wins over config, the same way the kill switch resolves.
    expect(
      resolveAgentProactiveEnabled({ CANONRY_AGENT_PROMPT_ONLY: value }, cfg({ mode: 'prompt-only' })),
    ).toBe(true)
  })

  it('an empty or blank env falls through to config', () => {
    expect(resolveAgentProactiveEnabled({ CANONRY_AGENT_PROMPT_ONLY: '   ' }, cfg({ mode: 'prompt-only' }))).toBe(false)
    expect(resolveAgentProactiveEnabled({ CANONRY_AGENT_PROMPT_ONLY: '' }, cfg())).toBe(true)
  })
})

describe('SessionRegistry proactive wake', () => {
  let tmpDir: string
  let db: DatabaseClient
  let faux: FauxProviderRegistration

  function insertProject(name: string): string {
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

  function queueRow(projectId: string): AgentMessage[] {
    const row = db.select().from(agentSessions).where(eq(agentSessions.projectId, projectId)).get()
    return row ? parseJsonColumn<AgentMessage[]>(row.followUpQueue, []) : []
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-prompt-only-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    faux = registerFauxProvider({ api: 'faux-api', provider: 'faux', models: [{ id: 'faux-model' }] })
  })

  afterEach(() => {
    faux.unregister()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('proactive (the default)', () => {
    it('queues a follow-up and drains it into the transcript', async () => {
      insertProject('demo')
      const registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
      const agent = registry.getOrCreate('demo')
      agent.state.model = faux.getModel()
      faux.setResponses([fauxAssistantMessage('Acknowledged.')])

      registry.queueFollowUp('demo', followUp('run just completed, please review'))
      expect(registry.peekPending('demo')).toHaveLength(1)

      await registry.drainNow('demo')

      expect(registry.peekPending('demo')).toHaveLength(0)
      expect(agent.state.messages.length).toBeGreaterThanOrEqual(2)
      expect(agent.state.messages[agent.state.messages.length - 1].role).toBe('assistant')
    })
  })

  describe('prompt-only', () => {
    const promptOnly = (db: DatabaseClient) =>
      new SessionRegistry({ db, client: stubClient(), config: stubConfig(), proactive: false })

    it('queues nothing on a live session', () => {
      insertProject('demo')
      const registry = promptOnly(db)
      registry.getOrCreate('demo')

      registry.queueFollowUp('demo', followUp('run just completed'))

      expect(registry.peekPending('demo')).toHaveLength(0)
    })

    it('queues nothing to the database on an idle session', () => {
      const projectId = insertProject('demo')
      const registry = promptOnly(db)
      registry.getOrCreate('demo')
      registry.evict('demo')

      registry.queueFollowUp('demo', followUp('queued while idle'))

      expect(queueRow(projectId)).toHaveLength(0)
    })

    it('drains nothing, so the transcript is untouched', async () => {
      const projectId = insertProject('demo')
      // A follow-up persisted BEFORE prompt-only was turned on.
      const proactive = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
      proactive.getOrCreate('demo')
      proactive.evict('demo')
      proactive.queueFollowUp('demo', followUp('queued under the old mode'))
      expect(queueRow(projectId)).toHaveLength(1)

      const registry = promptOnly(db)
      const agent = registry.getOrCreate('demo')
      agent.state.model = faux.getModel()
      faux.setResponses([fauxAssistantMessage('should never be asked for')])
      const before = agent.state.messages.length

      await registry.drainNow('demo')

      expect(agent.state.messages.length).toBe(before)
    })

    it('does not consume a queue it was never going to send', () => {
      const projectId = insertProject('demo')
      const proactive = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
      proactive.getOrCreate('demo')
      proactive.evict('demo')
      proactive.queueFollowUp('demo', followUp('queued under the old mode'))

      const registry = promptOnly(db)
      registry.getOrCreate('demo')

      // Not hoovered into memory, and not silently discarded either: turning
      // the wake back on must not have cost the operator the queued events.
      expect(registry.peekPending('demo')).toHaveLength(0)
      expect(queueRow(projectId)).toHaveLength(1)
    })

    it('still answers an interactive prompt, without the queued follow-up riding along', async () => {
      const projectId = insertProject('demo')
      const proactive = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
      proactive.getOrCreate('demo')
      proactive.evict('demo')
      proactive.queueFollowUp('demo', followUp('queued under the old mode'))

      const registry = promptOnly(db)
      const agent = await registry.acquireForTurn('demo')
      agent.state.model = faux.getModel()
      faux.setResponses([fauxAssistantMessage('Here is the answer.')])

      // What the prompt route does: bundle anything pending in front of the
      // user's message. In prompt-only there must be nothing to bundle.
      const pending = registry.consumePending('demo')
      expect(pending).toHaveLength(0)

      await agent.prompt('what changed this week?')
      await agent.waitForIdle()

      expect(agent.state.messages[agent.state.messages.length - 1].role).toBe('assistant')
      const asked = JSON.stringify(agent.state.messages)
      expect(asked).toContain('what changed this week?')
      expect(asked).not.toContain('queued under the old mode')
      expect(queueRow(projectId)).toHaveLength(1)
    })
  })
})

describe('prompt-only is not a kill switch', () => {
  const AGENT_ROUTES: ReadonlyArray<readonly [string, string, unknown?]> = [
    ['GET', '/api/v1/projects/acme/agent/transcript'],
    ['GET', '/api/v1/projects/acme/agent/providers'],
    ['GET', '/api/v1/projects/acme/agent/memory'],
    ['DELETE', '/api/v1/projects/acme/agent/transcript'],
    ['POST', '/api/v1/projects/acme/agent/prompt', { prompt: '' }],
  ] as const

  it('serves the whole interactive surface with agent.mode "prompt-only"', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-prompt-only-server-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const app = await createServer({
      config: { apiUrl: 'http://localhost:4100', database: dbPath, apiKey, providers: {}, agent: { mode: 'prompt-only' } } as CanonryConfig,
      db,
      logger: false,
    })
    try {
      const seeded = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/acme',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' },
      })
      expect(seeded.statusCode).toBe(201)

      for (const [method, url, payload] of AGENT_ROUTES) {
        const res = await app.inject({
          method: method as 'GET' | 'POST' | 'DELETE',
          url,
          headers: { authorization: `Bearer ${apiKey}` },
          ...(payload !== undefined ? { payload } : {}),
        })
        // 404 would mean the routes were never mounted, which is what the
        // `disabled` kill switch does. Prompt-only must not do that.
        expect(res.statusCode, `${method} ${url} should still be mounted`).not.toBe(404)
      }
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
