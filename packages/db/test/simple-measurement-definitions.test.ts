import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers, type SimpleMeasurementDefinition } from '@ainyc/canonry-contracts'
import {
  MIGRATION_VERSIONS,
  createClient,
  migrate,
  runs,
  simpleMeasurementDefinitions,
} from '../src/index.js'

const NOW = '2026-09-04T12:00:00.000Z'
const PRE_SIDECAR_VERSION = 149

function createTempDb(prefix: string, through = Number.POSITIVE_INFINITY) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= through))
  return db
}

function seedProject(db: ReturnType<typeof createTempDb>, id = 'project_1') {
  db.$client.prepare(`
    INSERT INTO projects
      (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (?, ?, 'Example', 'example.com', 'US', 'en', ?, ?)
  `).run(id, id, NOW, NOW)
}

function seedRun(db: ReturnType<typeof createTempDb>, projectId = 'project_1', id = 'run_1') {
  db.insert(runs).values({
    id,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.queued,
    trigger: RunTriggers.manual,
    createdAt: NOW,
  }).run()
}

const DEFINITION: SimpleMeasurementDefinition = {
  schemaVersion: 1,
  capturedAt: NOW,
  identity: {
    displayName: 'Example',
    aliases: ['Example'],
    canonicalDomain: 'example.com',
    ownedDomains: ['example.com'],
  },
  country: 'US',
  language: 'en',
  location: null,
  engines: [{ provider: 'openai', requestedModel: null }],
  queries: [{
    queryId: 'query_1',
    queryText: 'What is Example?',
    provenance: null,
    queryClass: 'branded',
  }],
}

function definitionValues(runId = 'run_1', projectId = 'project_1') {
  return {
    runId,
    projectId,
    definition: DEFINITION,
    checksum: 'a'.repeat(64),
    capturedAt: NOW,
  }
}

test('fresh schema creates the immutable simple measurement definition sidecar', () => {
  const db = createTempDb('canonry-simple-measurement-fresh-')

  const columns = db.$client.prepare('PRAGMA table_info(simple_measurement_definitions)').all() as Array<{ name: string }>
  expect(columns.map(column => column.name)).toEqual([
    'run_id', 'project_id', 'definition', 'checksum', 'captured_at',
  ])
  const indexes = db.$client.prepare('PRAGMA index_list(simple_measurement_definitions)').all() as Array<{ name: string }>
  expect(indexes.map(index => index.name)).toContain('idx_simple_measurement_definitions_project')
  const trigger = db.$client.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'simple_measurement_definitions_no_update'
  `).get()
  expect(trigger).toEqual({ name: 'simple_measurement_definitions_no_update' })
})

test('v150 adds no sidecars or rewrites to existing v149 runs', () => {
  const db = createTempDb('canonry-simple-measurement-upgrade-', PRE_SIDECAR_VERSION)
  seedProject(db)
  seedRun(db)

  migrate(db)

  expect(db.select().from(runs).where(eq(runs.id, 'run_1')).get()).toMatchObject({
    id: 'run_1', projectId: 'project_1', status: RunStatuses.queued,
  })
  expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
})

test('typed simple definitions round-trip as native JSON', () => {
  const db = createTempDb('canonry-simple-measurement-roundtrip-')
  seedProject(db)
  seedRun(db)

  db.insert(simpleMeasurementDefinitions).values(definitionValues()).run()

  expect(db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, 'run_1')).get())
    .toMatchObject(definitionValues())
})

test('definition ownership cannot cross project boundaries', () => {
  const db = createTempDb('canonry-simple-measurement-ownership-')
  seedProject(db, 'project_1')
  seedProject(db, 'project_2')
  seedRun(db, 'project_1', 'run_1')

  expect(() => db.insert(simpleMeasurementDefinitions).values(definitionValues('run_1', 'project_2')).run())
    .toThrow(/FOREIGN KEY/i)
})

test('a sidecar always names its run', () => {
  const db = createTempDb('canonry-simple-measurement-run-required-')
  seedProject(db)
  seedRun(db)

  expect(() => db.$client.prepare(`
    INSERT INTO simple_measurement_definitions (run_id, project_id, definition, checksum, captured_at)
    VALUES (NULL, ?, ?, ?, ?)
  `).run('project_1', JSON.stringify(DEFINITION), 'a'.repeat(64), NOW)).toThrow(/NOT NULL/i)
})

test('a frozen simple definition cannot be updated', () => {
  const db = createTempDb('canonry-simple-measurement-immutable-')
  seedProject(db)
  seedRun(db)
  db.insert(simpleMeasurementDefinitions).values(definitionValues()).run()

  expect(() => db.update(simpleMeasurementDefinitions)
    .set({ checksum: 'b'.repeat(64) })
    .where(eq(simpleMeasurementDefinitions.runId, 'run_1'))
    .run()).toThrow(/immutable/i)
})

test('the sidecar trigger does not block normal run lifecycle updates', () => {
  const db = createTempDb('canonry-simple-measurement-run-update-')
  seedProject(db)
  seedRun(db)
  db.insert(simpleMeasurementDefinitions).values(definitionValues()).run()

  expect(() => db.update(runs)
    .set({ status: RunStatuses.running })
    .where(eq(runs.id, 'run_1'))
    .run()).not.toThrow()
  expect(db.select().from(runs).where(eq(runs.id, 'run_1')).get()?.status).toBe(RunStatuses.running)
})

test('run and project deletion cascade through the sidecar', () => {
  const db = createTempDb('canonry-simple-measurement-cascade-')
  seedProject(db, 'project_1')
  seedProject(db, 'project_2')
  seedRun(db, 'project_1', 'run_1')
  seedRun(db, 'project_2', 'run_2')
  db.insert(simpleMeasurementDefinitions).values([
    definitionValues('run_1', 'project_1'),
    definitionValues('run_2', 'project_2'),
  ]).run()

  db.delete(runs).where(eq(runs.id, 'run_1')).run()
  expect(db.select().from(simpleMeasurementDefinitions).all().map(row => row.runId)).toEqual(['run_2'])

  db.run(sql`DELETE FROM projects WHERE id = 'project_2'`)
  expect(db.select().from(simpleMeasurementDefinitions).all()).toEqual([])
})

test('the v150 migration is safe on a second boot', () => {
  const db = createTempDb('canonry-simple-measurement-rerun-', PRE_SIDECAR_VERSION)

  migrate(db)
  migrate(db)

  const applied = db.$client.prepare(`SELECT version FROM _migrations WHERE version = 150`).all()
  expect(applied).toHaveLength(1)
})
