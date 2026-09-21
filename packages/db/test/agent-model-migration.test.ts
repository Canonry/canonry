import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { agentSessions, createClient, migrate, MIGRATION_VERSIONS, projects } from '../src/index.js'

let tmpDir: string
let db: ReturnType<typeof createClient>
const now = '2026-09-19T12:00:00.000Z'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-model-migration-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 158))
})

afterEach(() => {
  db.$client.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function seed(id: string, modelProvider: string, modelId: string): void {
  db.insert(projects).values({
    id, name: id, displayName: id, canonicalDomain: `${id}.example.com`,
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(agentSessions).values({
    id, projectId: id, modelProvider, modelId, systemPrompt: 'operator instructions',
    messages: JSON.stringify([{ role: 'user', content: 'saved conversation', timestamp: 1 }]),
    followUpQueue: JSON.stringify([{ role: 'user', content: 'queued follow-up', timestamp: 2 }]),
    createdAt: now, updatedAt: now,
  }).run()
}

it('upgrades only the old DeepInfra default and preserves all other session data', () => {
  seed('legacy', 'deepinfra', 'zai-org/GLM-5.2')
  seed('custom', 'deepinfra', 'deepseek-ai/DeepSeek-V3.1')
  seed('other', 'zai', 'zai-org/GLM-5.2')
  const before = db.select().from(agentSessions).orderBy(agentSessions.id).all()

  migrate(db)

  expect(db.select().from(agentSessions).orderBy(agentSessions.id).all()).toEqual(
    before.map(row => row.id === 'legacy' ? { ...row, modelId: 'deepseek-ai/DeepSeek-V4-Flash' } : row),
  )
})

it('does not replay the upgrade over later explicit selections or new sessions', () => {
  seed('legacy', 'deepinfra', 'zai-org/GLM-5.2')
  migrate(db)
  db.update(agentSessions).set({ modelId: 'zai-org/GLM-5.2' }).where(eq(agentSessions.id, 'legacy')).run()
  seed('explicit', 'deepinfra', 'zai-org/GLM-5.2')
  const before = db.select().from(agentSessions).orderBy(agentSessions.id).all()

  migrate(db)

  expect(db.select().from(agentSessions).orderBy(agentSessions.id).all()).toEqual(before)
})
