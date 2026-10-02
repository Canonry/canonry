import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, it, onTestFinished } from 'vitest'
import { createClient, managedAgentSessions, managedAgentTurnGrants, migrate, MIGRATION_VERSIONS, projects } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

const now = '2026-10-02T00:00:00.000Z'
function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-managed-aero-'))
  const db = createClient(path.join(directory, 'test.db'))
  onTestFinished(() => { db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return db
}

it('upgrades without rewriting operator history, and preserves personal transcripts on a second boot', () => {
  const db = database()
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version < 167))
  insertLegacyProject(db, { id: 'demo', createdAt: now })
  insertLegacyRow(db, 'agent_sessions', { id: 'operator', project_id: 'demo', system_prompt: 'private prompt', model_provider: 'openai', model_id: 'operator-model', messages: '[{"role":"user","content":"operator secret"}]', follow_up_queue: '["queued"]', created_at: now, updated_at: now })
  const operator = db.$client.prepare('SELECT * FROM agent_sessions').all()
  migrate(db)
  db.insert(managedAgentSessions).values({ id: 'personal', projectId: 'demo', actorId: 'alice', connectionId: 'connection', modelId: 'account-model', messages: [{ role: 'user', content: 'personal prompt' }], createdAt: now, updatedAt: now }).run()
  db.insert(managedAgentTurnGrants).values({ id: 'grant', expiresAt: 12345 }).run()
  migrate(db)
  expect(db.$client.prepare('SELECT * FROM agent_sessions').all()).toEqual(operator)
  expect(db.select().from(managedAgentSessions).get()?.messages).toEqual([{ role: 'user', content: 'personal prompt' }])
  expect(db.select().from(managedAgentTurnGrants).get()).toEqual({ id: 'grant', expiresAt: 12345 })
  expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('enforces actor/connection/project uniqueness, grant admission uniqueness, and project cascade', () => {
  const db = database()
  migrate(db)
  insertLegacyProject(db, { id: 'demo', createdAt: now })
  const row = { id: 'one', projectId: 'demo', actorId: 'alice', connectionId: 'connection', modelId: 'account-model', createdAt: now, updatedAt: now }
  db.insert(managedAgentSessions).values(row).run()
  expect(() => db.insert(managedAgentSessions).values({ ...row, id: 'duplicate' }).run()).toThrow()
  db.insert(managedAgentSessions).values({ ...row, id: 'bob', actorId: 'bob' }).run()
  db.insert(managedAgentTurnGrants).values({ id: 'once', expiresAt: 12345 }).run()
  expect(() => db.insert(managedAgentTurnGrants).values({ id: 'once', expiresAt: 23456 }).run()).toThrow()
  db.delete(projects).where(eq(projects.id, 'demo')).run()
  expect(db.select().from(managedAgentSessions).all()).toEqual([])
  expect(db.select().from(managedAgentTurnGrants).all()).toEqual([{ id: 'once', expiresAt: 12345 }])
})
