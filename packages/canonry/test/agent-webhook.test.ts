import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects as projectsTable, notifications, parseJsonColumn } from '@ainyc/canonry-db'
import { attachAgentWebhookDirect, buildAgentWebhookUrl, AGENT_WEBHOOK_EVENTS } from '../src/agent-webhook.js'

let tmpDir: string
let dbPath: string

function insertProject(db: ReturnType<typeof createClient>, name: string): string {
  const id = `proj_${name}`
  const now = new Date().toISOString()
  db.insert(projectsTable).values({
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-webhook-'))
  dbPath = path.join(tmpDir, 'data.db')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('attachAgentWebhookDirect', () => {
  it('inserts a webhook notification when none exists', () => {
    const db = createClient(dbPath)
    migrate(db)
    const projectId = insertProject(db, 'alpha')

    const result = attachAgentWebhookDirect(db, projectId, 3579)

    expect(result).toBe('attached')
    const rows = db.select().from(notifications).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].channel).toBe('webhook')
    expect(rows[0].enabled).toBe(1)
    expect(rows[0].webhookSecret).toBeTruthy()

    const cfg = parseJsonColumn<{ url: string; events: string[]; source?: string }>(rows[0].config, { url: '', events: [] })
    expect(cfg.url).toBe('http://localhost:3579/hooks/canonry')
    expect(cfg.source).toBe('agent')
    expect(cfg.events).toEqual([...AGENT_WEBHOOK_EVENTS])
  })

  it('is idempotent — returns already-attached when same URL exists', () => {
    const db = createClient(dbPath)
    migrate(db)
    const projectId = insertProject(db, 'beta')

    expect(attachAgentWebhookDirect(db, projectId, 3579)).toBe('attached')
    expect(attachAgentWebhookDirect(db, projectId, 3579)).toBe('already-attached')

    const rows = db.select().from(notifications).all()
    expect(rows).toHaveLength(1)
  })

  it('treats a different gateway port as already-attached (one agent webhook per project)', () => {
    const db = createClient(dbPath)
    migrate(db)
    const projectId = insertProject(db, 'gamma')

    expect(attachAgentWebhookDirect(db, projectId, 3579)).toBe('attached')
    // Source-based matching means port change is still "already attached"
    expect(attachAgentWebhookDirect(db, projectId, 4000)).toBe('already-attached')

    const rows = db.select().from(notifications).all()
    expect(rows).toHaveLength(1)
  })

  it('scopes per-project — attaching to one project does not affect another', () => {
    const db = createClient(dbPath)
    migrate(db)
    const alpha = insertProject(db, 'alpha')
    const beta = insertProject(db, 'beta')

    attachAgentWebhookDirect(db, alpha, 3579)

    expect(db.select().from(notifications).all()).toHaveLength(1)
    expect(attachAgentWebhookDirect(db, beta, 3579)).toBe('attached')
    expect(db.select().from(notifications).all()).toHaveLength(2)
  })

  it('does not collide with a pre-existing non-agent webhook on the same project', () => {
    const db = createClient(dbPath)
    migrate(db)
    const projectId = insertProject(db, 'delta')

    const now = new Date().toISOString()
    db.insert(notifications).values({
      id: 'user-webhook-1',
      projectId,
      channel: 'webhook',
      config: JSON.stringify({ url: 'https://user.example.com/hook', events: ['run.completed'] }),
      enabled: 1,
      webhookSecret: 'secret',
      createdAt: now,
      updatedAt: now,
    }).run()

    const result = attachAgentWebhookDirect(db, projectId, 3579)
    expect(result).toBe('attached')
    expect(db.select().from(notifications).all()).toHaveLength(2)
  })
})

describe('buildAgentWebhookUrl', () => {
  it('produces the canonical localhost URL', () => {
    expect(buildAgentWebhookUrl(3579)).toBe('http://localhost:3579/hooks/canonry')
    expect(buildAgentWebhookUrl(4000)).toBe('http://localhost:4000/hooks/canonry')
  })
})
