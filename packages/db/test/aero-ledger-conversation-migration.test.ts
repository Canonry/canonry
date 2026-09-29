import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v165: an Aero conversation id lives in `agent_sessions` while the
// conversation is active and in `agent_conversations` once it is archived. A
// foreign key can reference only one of those tables, so the usage and tool
// ledgers keep the id as a plain indexed column. Before this, starting a new
// conversation after a turn failed on the key, and resuming another one nulled
// the archived conversation's ledger rows.

const LEDGER_VERSION = 165
const NOW = '2026-09-28T00:00:00.000Z'
const LEDGERS = ['llm_usage_events', 'agent_tool_events'] as const

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-aero-ledger-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, versions)
  return db
}

const rows = (db: DatabaseClient, table: string) => db.$client.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
const foreignKeys = (db: DatabaseClient, table: string) => (db.$client.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; on_delete: string }>)
  .map(key => `${key.from}->${key.table} ${key.on_delete}`).sort()
const indexes = (db: DatabaseClient, table: string) => (db.$client.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`).all(table))

function seed(db: DatabaseClient): void {
  insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
  insertLegacyRow(db, 'agent_sessions', {
    id: 'conversation-1', project_id: 'project-1', system_prompt: 'prompt', model_provider: 'deepinfra', model_id: 'test-model',
    messages: '[]', follow_up_queue: '[]', created_at: NOW, updated_at: NOW,
  })
  for (const [id, sessionId] of [['usage-1', 'conversation-1'], ['usage-2', null]] as const) {
    insertLegacyRow(db, 'llm_usage_events', {
      id, project_id: 'project-1', run_id: null, agent_session_id: sessionId, feature: 'aero.turn', provider: 'deepinfra', model: 'test-model',
      response_id: `response-${id}`, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 0, total_tokens: 17,
      cost_millicents: 42, prompt_family: 'aero', prompt_version: 'aero-system-v1', metadata: { toolCount: 3 }, created_at: NOW,
    })
  }
  insertLegacyRow(db, 'agent_tool_events', {
    id: 'tool-1', project_id: 'project-1', agent_session_id: 'conversation-1', tool_call_id: 'call-1', tool_name: 'canonry_project_get',
    assistant_response_id: 'response-usage-1', provider: 'deepinfra', model: 'test-model', status: 'success', duration_ms: 12,
    args_bytes: 3, result_text_chars: 40, result_bytes: 80, metadata: { toolCount: 3 }, created_at: NOW,
  })
}

it('keeps every ledger row and index, and drops only the key to the active conversation', () => {
  const db = tempDb(MIGRATION_VERSIONS.filter(version => version.version < LEDGER_VERSION))
  seed(db)
  const before = Object.fromEntries(LEDGERS.map(table => [table, { rows: rows(db, table), indexes: indexes(db, table), keys: foreignKeys(db, table) }]))
  expect(before.llm_usage_events!.keys).toContain('agent_session_id->agent_sessions SET NULL')

  migrate(db)

  expect(foreignKeys(db, 'llm_usage_events')).toEqual(['project_id->projects CASCADE', 'run_id->runs SET NULL'])
  expect(foreignKeys(db, 'agent_tool_events')).toEqual(['project_id->projects CASCADE'])
  for (const table of LEDGERS) {
    expect(rows(db, table)).toEqual(before[table]!.rows)
    expect(indexes(db, table)).toEqual(before[table]!.indexes)
  }
})

it('lets the active conversation change id while its ledger rows keep it, and still cascades a project delete', () => {
  const db = tempDb(MIGRATION_VERSIONS.filter(version => version.version < LEDGER_VERSION))
  seed(db)
  migrate(db)

  db.$client.prepare(`DELETE FROM agent_sessions WHERE id = 'conversation-1'`).run()
  db.$client.prepare(`INSERT INTO agent_sessions (id, project_id, system_prompt, model_provider, model_id, created_at, updated_at) VALUES ('conversation-2', 'project-1', 'prompt', 'deepinfra', 'test-model', ?, ?)`).run(NOW, NOW)
  expect(db.$client.prepare(`SELECT agent_session_id FROM llm_usage_events ORDER BY id`).all()).toEqual([{ agent_session_id: 'conversation-1' }, { agent_session_id: null }])
  expect(db.$client.prepare(`SELECT agent_session_id FROM agent_tool_events`).all()).toEqual([{ agent_session_id: 'conversation-1' }])

  db.$client.prepare(`DELETE FROM projects WHERE id = 'project-1'`).run()
  for (const table of LEDGERS) expect(rows(db, table)).toEqual([])
})

it('is a no-op when replayed over ledgers that no longer have the key', () => {
  const db = tempDb(MIGRATION_VERSIONS.filter(version => version.version < LEDGER_VERSION))
  seed(db)
  migrate(db)
  // A rebuild would drop these, so they only survive if the replay skips it.
  for (const table of LEDGERS) db.$client.prepare(`CREATE INDEX idx_${table}_replay_marker ON ${table}(created_at)`).run()
  const migrated = Object.fromEntries(LEDGERS.map(table => [table, { rows: rows(db, table), indexes: indexes(db, table) }]))
  for (const table of LEDGERS) expect(migrated[table]!.indexes.map(index => (index as { name: string }).name)).toContain(`idx_${table}_replay_marker`)
  db.$client.prepare('DELETE FROM _migrations WHERE version >= ?').run(LEDGER_VERSION)

  migrate(db)

  for (const table of LEDGERS) expect({ rows: rows(db, table), indexes: indexes(db, table) }).toEqual(migrated[table])
})

it('creates the ledgers without the conversation key on a fresh database', () => {
  const db = tempDb()
  expect(foreignKeys(db, 'llm_usage_events')).toEqual(['project_id->projects CASCADE', 'run_id->runs SET NULL'])
  expect(foreignKeys(db, 'agent_tool_events')).toEqual(['project_id->projects CASCADE'])
  expect(db.$client.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
