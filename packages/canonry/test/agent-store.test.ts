import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects, agentThreads } from '@ainyc/canonry-db'
import { AgentStore } from '../src/agent/store.js'

describe('AgentStore', () => {
  it('returns the most recent messages while preserving chronological order', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const projectId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const now = new Date()

    db.insert(projects).values({
      id: projectId,
      name: 'agent-store-project',
      displayName: 'Agent Store Project',
      canonicalDomain: 'example.com',
      ownedDomains: '[]',
      tags: '[]',
      labels: '{}',
      providers: '[]',
      configSource: 'cli',
      configRevision: 1,
      country: 'US',
      language: 'en',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).run()

    db.insert(agentThreads).values({
      id: threadId,
      projectId,
      title: 'Thread',
      channel: 'chat',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).run()

    const store = new AgentStore(db)
    const contents = ['first', 'second', 'third']

    try {
      for (const content of contents) {
        await store.addMessage({
          threadId,
          role: 'user',
          content,
          toolName: null,
          toolArgs: null,
          toolCallId: null,
        })
      }

      const recent = await store.getMessages(threadId, 2)
      assert.deepEqual(recent.map((msg) => msg.content), ['second', 'third'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
