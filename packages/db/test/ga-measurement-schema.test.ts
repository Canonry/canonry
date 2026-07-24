import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import {
  MIGRATION_VERSIONS,
  createClient,
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  migrate,
  projects,
} from '../src/index.js'

const V109 = 109
type Db = ReturnType<typeof createClient>

function tempDb(prefix: string, versions = MIGRATION_VERSIONS) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, versions)
  return db
}

function seedProject(db: Db, id = 'project_1') {
  const now = '2026-07-23T00:00:00.000Z'
  db.insert(projects).values({
    id,
    name: id,
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

test('v109 adds backward-compatible project measurement defaults and all measurement tables', () => {
  const db = tempDb(
    'canonry-ga-measurement-upgrade-',
    MIGRATION_VERSIONS.filter(migration => migration.version < V109),
  )

  db.run(sql`
    INSERT INTO projects
      (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES
      ('legacy_project', 'legacy-project', 'Legacy', 'example.com', 'US', 'en',
       '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
  `)

  migrate(db)

  const projectRows = db.all(sql`
    SELECT measurement_config AS measurementConfig
    FROM projects
    WHERE id = 'legacy_project'
  `) as Array<{ measurementConfig: string }>
  expect(JSON.parse(projectRows[0]!.measurementConfig)).toEqual({
    marketingHosts: [],
    brandTerms: [],
    leadEventNames: ['generate_lead'],
  })

  const tables = (db.all(sql`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `) as Array<{ name: string }>).map(row => row.name)
  expect(tables).toEqual(expect.arrayContaining([
    'ga_acquisition_daily',
    'ga_lead_events_daily',
    'ga_measurement_sync_state',
  ]))
  expect(MIGRATION_VERSIONS.find(migration => migration.version === V109)?.name)
    .toBe('ga-measurement-foundation')
})

test('acquisition rows enforce their complete GA4 dimension grain and nonnegative sessions', () => {
  const db = tempDb('canonry-ga-acquisition-grain-')
  seedProject(db)
  const now = '2026-07-23T00:00:00.000Z'
  const base = {
    projectId: 'project_1',
    date: '2026-07-22',
    channelGroup: 'Organic Search',
    source: 'google',
    medium: 'organic',
    hostName: 'example.com',
    landingPage: '/pricing?utm_source=ignored',
    landingPageNormalized: '/pricing',
    sessions: 8,
    syncedAt: now,
    createdAt: now,
  }

  db.insert(gaAcquisitionDaily).values({ id: crypto.randomUUID(), ...base }).run()

  expect(() => db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    ...base,
  }).run()).toThrow()

  db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    ...base,
    source: 'bing',
    sessions: 2,
  }).run()
  expect(db.select().from(gaAcquisitionDaily).all()).toHaveLength(2)

  expect(() => db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    ...base,
    date: '2026-07-21',
    sessions: -1,
  }).run()).toThrow()
})

test('lead rows preserve attribution scope and reject duplicate or negative event counts', () => {
  const db = tempDb('canonry-ga-lead-grain-')
  seedProject(db)
  const now = '2026-07-23T00:00:00.000Z'
  const base = {
    projectId: 'project_1',
    date: '2026-07-22',
    eventName: 'generate_lead',
    channelGroup: 'Paid Search',
    source: 'google',
    medium: 'cpc',
    hostName: 'example.com',
    landingPage: '/quote',
    landingPageNormalized: '/quote',
    attributionScope: 'landing-page' as const,
    eventCount: 3,
    syncedAt: now,
    createdAt: now,
  }

  db.insert(gaLeadEventsDaily).values({ id: crypto.randomUUID(), ...base }).run()
  expect(() => db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    ...base,
  }).run()).toThrow()

  db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    ...base,
    attributionScope: 'channel',
    hostName: '(not available)',
    landingPage: '(not available)',
    landingPageNormalized: null,
  }).run()
  expect(db.select().from(gaLeadEventsDaily).all()).toHaveLength(2)

  expect(() => db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    ...base,
    date: '2026-07-21',
    eventCount: -1,
  }).run()).toThrow()
})

test('component sync state distinguishes never-synced, ready, and error and cascades with its project', () => {
  const db = tempDb('canonry-ga-measurement-state-')
  seedProject(db)
  const now = '2026-07-23T00:00:00.000Z'

  db.insert(gaMeasurementSyncStates).values({
    projectId: 'project_1',
    acquisitionStatus: 'ready',
    acquisitionSyncedAt: now,
    leadStatus: 'error',
    leadError: 'GA4 rejected the landing-page dimension',
    updatedAt: now,
  }).run()

  expect(db.select().from(gaMeasurementSyncStates)
    .where(eq(gaMeasurementSyncStates.projectId, 'project_1')).get()).toMatchObject({
    acquisitionStatus: 'ready',
    acquisitionError: null,
    leadStatus: 'error',
    leadError: 'GA4 rejected the landing-page dimension',
    leadAttributionScope: null,
  })

  db.insert(gaAcquisitionDaily).values({
    id: crypto.randomUUID(),
    projectId: 'project_1',
    date: '2026-07-22',
    channelGroup: 'Organic Search',
    source: 'google',
    medium: 'organic',
    hostName: 'example.com',
    landingPage: '/guide',
    landingPageNormalized: '/guide',
    sessions: 2,
    syncedAt: now,
    createdAt: now,
  }).run()
  db.insert(gaLeadEventsDaily).values({
    id: crypto.randomUUID(),
    projectId: 'project_1',
    date: '2026-07-22',
    eventName: 'generate_lead',
    channelGroup: 'Organic Search',
    source: 'google',
    medium: 'organic',
    hostName: 'example.com',
    landingPage: '/guide',
    landingPageNormalized: '/guide',
    attributionScope: 'landing-page',
    eventCount: 1,
    syncedAt: now,
    createdAt: now,
  }).run()

  db.delete(projects).where(eq(projects.id, 'project_1')).run()
  expect(db.select().from(gaMeasurementSyncStates).all()).toEqual([])
  expect(db.select().from(gaAcquisitionDaily).all()).toEqual([])
  expect(db.select().from(gaLeadEventsDaily).all()).toEqual([])
})

test('measurement status and attribution CHECK constraints reject invalid values', () => {
  const db = tempDb('canonry-ga-measurement-checks-')
  seedProject(db)
  expect(() => db.run(sql`
    INSERT INTO ga_measurement_sync_state
      (project_id, acquisition_status, lead_status, updated_at)
    VALUES ('project_1', 'complete', 'never-synced', '2026-07-23T00:00:00.000Z')
  `)).toThrow()
  expect(() => db.run(sql`
    INSERT INTO ga_lead_events_daily
      (id, project_id, date, event_name, channel_group, source, medium, host_name,
       landing_page, attribution_scope, event_count, synced_at, created_at)
    VALUES
      ('lead_1', 'project_1', '2026-07-22', 'generate_lead', 'Organic Search',
       'google', 'organic', 'example.com', '/guide', 'page', 1,
       '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')
  `)).toThrow()
})
