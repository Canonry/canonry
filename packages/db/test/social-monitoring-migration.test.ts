import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  projects,
  queries,
  runs,
  socialConnections,
  socialMentions,
  type DatabaseClient,
} from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v223 adds social monitoring storage: `social_mentions` (the posts a run
// found), `social_connections` (which platforms a project has connected; no
// secrets, those live in config.yaml) and `projects.social_platforms` (the
// platforms a project monitors, default `[]`).

const SOCIAL_VERSION = 223
const NOW = '2026-11-08T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-social-monitoring-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function tableExists(db: DatabaseClient, name: string): boolean {
  return db.$client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

function indexes(db: DatabaseClient, table: string): Array<{ name: string; unique: number; columns: string[] }> {
  const list = db.all(sql.raw(`PRAGMA index_list('${table}')`)) as Array<{ name: string; unique: number; origin: string }>
  return list
    .filter(entry => entry.origin === 'c')
    .map(entry => ({
      name: entry.name,
      unique: entry.unique,
      columns: (db.all(sql.raw(`PRAGMA index_info('${entry.name}')`)) as Array<{ name: string }>).map(col => col.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function columnNames(db: DatabaseClient, table: string): string[] {
  return (db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>).map(entry => entry.name)
}

function socialPlatformsColumn(db: DatabaseClient) {
  return (db.all(sql.raw(`PRAGMA table_info('projects')`)) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>)
    .find(entry => entry.name === 'social_platforms')
}

function seedProjectRunQuery(db: DatabaseClient, projectId: string): { runId: string; queryId: string } {
  insertLegacyProject(db, { id: projectId, createdAt: NOW })
  const runId = `${projectId}-run`
  const queryId = `${projectId}-query`
  insertLegacyRow(db, 'runs', { id: runId, project_id: projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', created_at: NOW })
  insertLegacyRow(db, 'queries', { id: queryId, project_id: projectId, query: 'best bike shop', created_at: NOW })
  return { runId, queryId }
}

function mention(id: string, refs: { projectId: string; runId: string; queryId: string | null }, platform: 'x' | 'reddit' | 'linkedin', externalId: string) {
  return {
    id,
    projectId: refs.projectId,
    runId: refs.runId,
    platform,
    queryId: refs.queryId,
    externalId,
    externalUrl: `https://example.com/${platform}/${externalId}`,
    matchedQuery: 'spoketuneworks',
    contentText: 'Anyone tried spoketuneworks.example?',
    postedAt: NOW,
    createdAt: NOW,
  }
}

function enableForeignKeys(db: DatabaseClient): void {
  db.$client.pragma('foreign_keys = ON')
}

describe('social monitoring tables (v223)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === SOCIAL_VERSION)?.name).toBe('social-monitoring-tables')
  })

  it('creates both tables, every index and the defaulted project column on a fresh database', () => {
    const db = tempDb()
    expect(tableExists(db, 'social_mentions')).toBe(true)
    expect(tableExists(db, 'social_connections')).toBe(true)

    expect(indexes(db, 'social_mentions')).toEqual([
      { name: 'idx_social_mentions_project_platform_external', unique: 1, columns: ['project_id', 'platform', 'external_id'] },
      { name: 'idx_social_mentions_query', unique: 0, columns: ['query_id'] },
      { name: 'idx_social_mentions_run', unique: 0, columns: ['run_id'] },
    ])
    expect(indexes(db, 'social_connections')).toEqual([
      { name: 'idx_social_connections_platform_project', unique: 1, columns: ['platform', 'project_id'] },
    ])

    expect(db.all(sql.raw(`PRAGMA foreign_key_list('social_mentions')`))).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'runs', from: 'project_id', to: 'project_id', on_delete: 'CASCADE' }),
      expect.objectContaining({ table: 'runs', from: 'run_id', to: 'id', on_delete: 'CASCADE' }),
    ]))

    expect(socialPlatformsColumn(db)).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: `'[]'` })
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    expect(db.select({ socialPlatforms: projects.socialPlatforms }).from(projects).where(eq(projects.id, 'project-1')).get())
      .toEqual({ socialPlatforms: [] })
  })

  it('defaults the JSON columns and leaves what a platform may not expose null', () => {
    const db = tempDb()
    const { runId, queryId } = seedProjectRunQuery(db, 'project-1')
    db.insert(socialMentions).values(mention('mention-1', { projectId: 'project-1', runId, queryId }, 'reddit', 't3_abc')).run()
    expect(db.select().from(socialMentions).get()).toMatchObject({
      authorHandle: null,
      authorName: null,
      authorFollowers: null,
      contentTitle: null,
      sentiment: null,
      likes: null,
      shares: null,
      comments: null,
      community: null,
      linkedUrls: [],
      hashtags: [],
      metadata: {},
    })

    db.insert(socialConnections).values({ id: 'connection-1', platform: 'reddit', projectId: 'project-1', createdAt: NOW, updatedAt: NOW }).run()
    expect(db.select().from(socialConnections).get()).toEqual({
      id: 'connection-1',
      platform: 'reddit',
      projectId: 'project-1',
      tokenExpiresAt: null,
      scopes: [],
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('round-trips the project URLs a post links to', () => {
    const db = tempDb()
    const { runId, queryId } = seedProjectRunQuery(db, 'project-1')
    const linkedUrls = ['https://spoketuneworks.example/pricing', 'https://spoketuneworks.example/blog/tune-up']
    db.insert(socialMentions).values({ ...mention('mention-1', { projectId: 'project-1', runId, queryId }, 'x', '1800'), linkedUrls }).run()
    expect(db.select({ linkedUrls: socialMentions.linkedUrls, matchedQuery: socialMentions.matchedQuery }).from(socialMentions).get())
      .toEqual({ linkedUrls, matchedQuery: 'spoketuneworks' })
  })

  it('stores no secret column for a connection', () => {
    const db = tempDb()
    expect(columnNames(db, 'social_connections')).toEqual([
      'id', 'platform', 'project_id', 'token_expires_at', 'scopes', 'metadata', 'created_at', 'updated_at',
    ])
    for (const column of ['accessToken', 'refreshToken', 'apiKey']) {
      expect(column in socialConnections).toBe(false)
    }
  })

  it('upgrades a v222 database, keeping its rows and reading existing projects as monitoring nothing', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < SOCIAL_VERSION))
    expect(tableExists(db, 'social_mentions')).toBe(false)
    expect(tableExists(db, 'social_connections')).toBe(false)
    expect(socialPlatformsColumn(db)).toBeUndefined()
    const { runId, queryId } = seedProjectRunQuery(db, 'legacy-project')

    migrate(db)

    expect(db.select({ id: projects.id, socialPlatforms: projects.socialPlatforms }).from(projects).all())
      .toEqual([{ id: 'legacy-project', socialPlatforms: [] }])
    expect(db.select({ id: runs.id }).from(runs).all()).toEqual([{ id: runId }])
    expect(db.select({ id: queries.id }).from(queries).all()).toEqual([{ id: queryId }])
    expect(db.select().from(socialMentions).all()).toEqual([])
    expect(db.select().from(socialConnections).all()).toEqual([])

    // An older writer that never names the column still inserts, monitoring nothing.
    insertLegacyProject(db, { id: 'older-writer', createdAt: NOW })
    expect(db.select({ socialPlatforms: projects.socialPlatforms }).from(projects).where(eq(projects.id, 'older-writer')).get())
      .toEqual({ socialPlatforms: [] })

    // A saved platform list round-trips as written.
    db.update(projects).set({ socialPlatforms: ['reddit', 'x'] }).where(eq(projects.id, 'legacy-project')).run()
    expect(db.select({ socialPlatforms: projects.socialPlatforms }).from(projects).where(eq(projects.id, 'legacy-project')).get())
      .toEqual({ socialPlatforms: ['reddit', 'x'] })
  })

  it('is idempotent when the statements run again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= SOCIAL_VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    db.update(projects).set({ socialPlatforms: ['reddit'] }).where(eq(projects.id, 'project-1')).run()
    // A retry after a crash between the statements and the `_migrations` row
    // re-runs them; the runner swallows the duplicate-column error.
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(SOCIAL_VERSION)
    expect(() => migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version === SOCIAL_VERSION))).not.toThrow()
    expect(db.select({ socialPlatforms: projects.socialPlatforms }).from(projects).get()).toEqual({ socialPlatforms: ['reddit'] })
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(SOCIAL_VERSION))
      .toEqual({ count: 1 })
  })

  it('stores a post once per project, while other projects and platforms keep their own copies', () => {
    const db = tempDb()
    enableForeignKeys(db)
    const a = seedProjectRunQuery(db, 'project-a')
    const b = seedProjectRunQuery(db, 'project-b')
    const refsA = { projectId: 'project-a', runId: a.runId, queryId: a.queryId }
    const refsB = { projectId: 'project-b', runId: b.runId, queryId: b.queryId }

    db.insert(socialMentions).values(mention('a-reddit', refsA, 'reddit', 'post-1')).run()
    db.insert(socialMentions).values(mention('a-x', refsA, 'x', 'post-1')).run()
    // Another project tracking the same post keeps its own row.
    db.insert(socialMentions).values(mention('b-reddit', refsB, 'reddit', 'post-1')).run()

    // The same project storing the same post again is a duplicate.
    expect(() => db.insert(socialMentions).values(mention('a-reddit-2', refsA, 'reddit', 'post-1')).run()).toThrow(/UNIQUE/)
    expect(db.select({ id: socialMentions.id }).from(socialMentions).orderBy(socialMentions.id).all())
      .toEqual([{ id: 'a-reddit' }, { id: 'a-x' }, { id: 'b-reddit' }])

    // Deleting one project leaves the other project's copy.
    db.delete(projects).where(eq(projects.id, 'project-a')).run()
    expect(db.select({ id: socialMentions.id, projectId: socialMentions.projectId, externalId: socialMentions.externalId }).from(socialMentions).all())
      .toEqual([{ id: 'b-reddit', projectId: 'project-b', externalId: 'post-1' }])
  })

  it('rejects a mention that pairs one project with another project\'s run', () => {
    const db = tempDb()
    enableForeignKeys(db)
    const a = seedProjectRunQuery(db, 'project-a')
    const b = seedProjectRunQuery(db, 'project-b')

    expect(() => db.insert(socialMentions).values(mention('crossed', { projectId: 'project-a', runId: b.runId, queryId: a.queryId }, 'reddit', 'post-1')).run())
      .toThrow(/FOREIGN KEY/)
    expect(db.select().from(socialMentions).all()).toEqual([])
  })

  it('keeps one connection per platform and project', () => {
    const db = tempDb()
    insertLegacyProject(db, { id: 'project-a', createdAt: NOW })
    insertLegacyProject(db, { id: 'project-b', createdAt: NOW })
    const connection = (id: string, platform: 'x' | 'reddit', projectId: string) =>
      ({ id, platform, projectId, createdAt: NOW, updatedAt: NOW })

    db.insert(socialConnections).values(connection('a-reddit', 'reddit', 'project-a')).run()
    db.insert(socialConnections).values(connection('a-x', 'x', 'project-a')).run()
    db.insert(socialConnections).values(connection('b-reddit', 'reddit', 'project-b')).run()
    expect(() => db.insert(socialConnections).values(connection('a-reddit-2', 'reddit', 'project-a')).run()).toThrow(/UNIQUE/)
    expect(db.select({ id: socialConnections.id }).from(socialConnections).orderBy(socialConnections.id).all())
      .toEqual([{ id: 'a-reddit' }, { id: 'a-x' }, { id: 'b-reddit' }])
  })

  it('removes mentions with their run, keeping other runs\' mentions', () => {
    const db = tempDb()
    enableForeignKeys(db)
    const { runId, queryId } = seedProjectRunQuery(db, 'project-1')
    insertLegacyRow(db, 'runs', { id: 'other-run', project_id: 'project-1', kind: 'answer-visibility', status: 'completed', trigger: 'manual', created_at: NOW })
    db.insert(socialMentions).values(mention('from-run', { projectId: 'project-1', runId, queryId }, 'reddit', 'post-1')).run()
    db.insert(socialMentions).values(mention('from-other-run', { projectId: 'project-1', runId: 'other-run', queryId }, 'reddit', 'post-2')).run()

    db.delete(runs).where(eq(runs.id, runId)).run()

    expect(db.select({ id: socialMentions.id }).from(socialMentions).all()).toEqual([{ id: 'from-other-run' }])
  })

  it('removes mentions and connections with their project, keeping other projects\' rows', () => {
    const db = tempDb()
    enableForeignKeys(db)
    const a = seedProjectRunQuery(db, 'project-a')
    const b = seedProjectRunQuery(db, 'project-b')
    db.insert(socialMentions).values(mention('a-mention', { projectId: 'project-a', runId: a.runId, queryId: a.queryId }, 'reddit', 'post-a')).run()
    db.insert(socialMentions).values(mention('b-mention', { projectId: 'project-b', runId: b.runId, queryId: b.queryId }, 'reddit', 'post-b')).run()
    db.insert(socialConnections).values({ id: 'a-connection', platform: 'reddit', projectId: 'project-a', scopes: ['read'], createdAt: NOW, updatedAt: NOW }).run()
    db.insert(socialConnections).values({ id: 'b-connection', platform: 'reddit', projectId: 'project-b', createdAt: NOW, updatedAt: NOW }).run()

    db.delete(projects).where(eq(projects.id, 'project-a')).run()

    expect(db.select({ id: socialMentions.id }).from(socialMentions).all()).toEqual([{ id: 'b-mention' }])
    expect(db.select({ id: socialConnections.id }).from(socialConnections).all()).toEqual([{ id: 'b-connection' }])
  })

  it('clears query_id when the query is deleted, keeping the mention', () => {
    const db = tempDb()
    enableForeignKeys(db)
    const { runId, queryId } = seedProjectRunQuery(db, 'project-1')
    db.insert(socialMentions).values(mention('mention-1', { projectId: 'project-1', runId, queryId }, 'reddit', 'post-1')).run()

    db.delete(queries).where(eq(queries.id, queryId)).run()

    expect(db.select({ id: socialMentions.id, queryId: socialMentions.queryId, runId: socialMentions.runId }).from(socialMentions).all())
      .toEqual([{ id: 'mention-1', queryId: null, runId }])
  })
})
