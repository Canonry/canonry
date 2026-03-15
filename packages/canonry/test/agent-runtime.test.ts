import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'

describe('agent runtime', () => {
  it('picks up provider configuration changes without restarting the server', async () => {
    const tmpDir = path.join(os.tmpdir(), `canonry-agent-runtime-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'test.db')

    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'default',
      keyHash,
      keyPrefix: rawKey.slice(0, 9),
      scopes: '["*"]',
      createdAt: new Date().toISOString(),
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: rawKey,
        providers: {},
      },
      db,
      logger: false,
    })

    const originalFetch = globalThis.fetch
    let llmCalls = 0

    try {
      const createProject = await app.inject({
        method: 'PUT',
        url: '/api/v1/projects/agent-project',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          displayName: 'Agent Project',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
        },
      })
      assert.equal(createProject.statusCode, 201)

      const createThread = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/agent-project/agent/threads',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { title: 'Thread' },
      })
      assert.equal(createThread.statusCode, 201)
      const thread = createThread.json() as { id: string }

      const unavailable = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/agent-project/agent/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { message: 'How am I doing?' },
      })
      assert.equal(unavailable.statusCode, 503)

      const updateProvider = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/openai',
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          apiKey: 'sk-test',
          model: 'gpt-4o',
        },
      })
      assert.equal(updateProvider.statusCode, 200)

      globalThis.fetch = async (input, init) => {
        llmCalls++
        assert.equal(input, 'https://api.openai.com/v1/chat/completions')

        const body = JSON.parse(String(init?.body)) as { model: string }
        assert.equal(body.model, 'gpt-4o')

        return new Response(JSON.stringify({
          choices: [{
            message: { content: 'Agent reply' },
            finish_reason: 'stop',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const available = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/agent-project/agent/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { message: 'How am I doing now?' },
      })
      assert.equal(available.statusCode, 200)
      assert.equal(available.json().response, 'Agent reply')
      assert.equal(llmCalls, 1)
    } finally {
      globalThis.fetch = originalFetch
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
