import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, projects } from '@ainyc/canonry-db'
import { AgentStore } from '../src/agent/store.js'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

function makeTempDir(prefix: string): string {
  const tmpDir = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

describe('agent', () => {
  it('AgentStore.getMessages keeps the newest window in chronological order', async () => {
    const tmpDir = makeTempDir('canonry-agent-store')
    const dbPath = path.join(tmpDir, 'data.db')
    const db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj-agent-store',
      name: 'agent-store',
      displayName: 'Agent Store',
      canonicalDomain: 'agent-store.example.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '[]',
      configSource: 'cli',
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    }).run()

    const store = new AgentStore(db)
    const thread = await store.createThread('proj-agent-store', { title: 'History test' })

    try {
      for (let index = 1; index <= 35; index++) {
        await store.addMessage({
          threadId: thread.id,
          role: 'user',
          content: `message ${index}`,
          toolName: null,
          toolArgs: null,
          toolCallId: null,
        })
      }

      const messages = await store.getMessages(thread.id, 30)
      assert.equal(messages.length, 30)
      assert.equal(messages[0]?.content, 'message 6')
      assert.equal(messages.at(-1)?.content, 'message 35')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('agent picks up provider updates without a server restart', async () => {
    const tmpDir = makeTempDir('canonry-agent-server')
    const dbPath = path.join(tmpDir, 'data.db')
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: '["*"]',
      createdAt: new Date().toISOString(),
    }).run()

    const config: Parameters<typeof createServer>[0]['config'] = {
      apiUrl: 'http://127.0.0.1:0',
      database: dbPath,
      apiKey: rawKey,
      providers: {},
    }

    const app = await createServer({ config, db, logger: false })
    const originalFetch = globalThis.fetch

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === 'https://api.openai.com/v1/chat/completions') {
        return new Response(JSON.stringify({
          choices: [{
            message: { content: 'Agent ready after update' },
            finish_reason: 'stop',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return originalFetch(input, init)
    }

    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const addr = app.server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      config.apiUrl = `http://127.0.0.1:${port}`

      const client = new ApiClient(config.apiUrl, rawKey)
      await client.putProject('agent-live-config', {
        displayName: 'Agent Live Config',
        canonicalDomain: 'agent-live-config.example.com',
        country: 'US',
        language: 'en',
      })

      const thread = await client.createAgentThread('agent-live-config', {
        title: 'Test thread',
      }) as { id: string }

      await assert.rejects(
        () => client.sendAgentMessage('agent-live-config', thread.id, 'hello'),
        /Agent is not configured/,
      )

      await client.updateProvider('openai', { apiKey: 'test-openai-key' })

      const response = await client.sendAgentMessage('agent-live-config', thread.id, 'hello again')
      assert.equal(response.response, 'Agent ready after update')
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
      if (originalConfigDir === undefined) {
        delete process.env.CANONRY_CONFIG_DIR
      } else {
        process.env.CANONRY_CONFIG_DIR = originalConfigDir
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
