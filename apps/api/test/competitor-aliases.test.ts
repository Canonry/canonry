import { test, expect, onTestFinished, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addLogListener, type LogEntry } from '@ainyc/canonry-api-routes/runtime-logger'
import { getPlatformEnv } from '@ainyc/canonry-config'
import { apiKeys, competitors, createClient, migrate, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'

import { buildApp } from '../src/app.js'

// Cloud's `onCompetitorAliasesChanged` wiring, end to end: a competitor alias
// write refreshes the stored per-snapshot competitor columns that run details
// and exports read, and leaves the project's own `answer_mentioned` alone. The
// refresh has finished by the time the write responds, because a Cloud Run
// instance may be throttled once its response is sent.

const ORIGINAL_CANONRY_TRUST_PROXY = process.env.CANONRY_TRUST_PROXY

beforeEach(() => {
  process.env.CANONRY_TRUST_PROXY = 'false'
})

afterEach(() => {
  if (ORIGINAL_CANONRY_TRUST_PROXY === undefined) delete process.env.CANONRY_TRUST_PROXY
  else process.env.CANONRY_TRUST_PROXY = ORIGINAL_CANONRY_TRUST_PROXY
})

const SNAPSHOT_ID = 'cloud-hook-snapshot'
const ALIAS_URL = '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases'

/**
 * A Cloud app over a fresh SQLite file with one project, one tracked
 * competitor (`spoketuneworks.example`, no aliases yet) and one stored answer
 * that names that competitor only by its brand, "TuneSpoke".
 */
async function seedCloud() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-competitor-aliases-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const app = buildApp(getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
  }))
  onTestFinished(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  const auth = { authorization: `Bearer ${rawKey}` }

  const created = await app.inject({
    method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' },
  })
  expect(created.statusCode, created.body).toBe(201)
  const added = await app.inject({
    method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: auth,
    payload: { competitors: ['spoketuneworks.example'] },
  })
  expect(added.statusCode, added.body).toBe(200)

  const projectId = db.select().from(projects).all().find(row => row.name === 'rotorwise')!.id
  const queryId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const at = '2026-10-01T01:00:00.000Z'
  db.insert(queries).values({ id: queryId, projectId, query: 'best bike repair shop', createdAt: at }).run()
  db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: at, finishedAt: at }).run()
  db.insert(querySnapshots).values({
    id: SNAPSHOT_ID,
    runId,
    queryId,
    provider: 'openai',
    citationState: 'not-cited',
    // Deliberately disagrees with the text: a competitor alias change is not a
    // project-identity change, so this stored value must survive the refresh.
    answerMentioned: true,
    answerText: 'Top picks for bike repair:\n- **TuneSpoke**: fast quotes and a long warranty.\n- **Gearloft**: strong reviews.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    createdAt: at,
  }).run()

  return { app, db, auth, runId }
}

test('a competitor alias write refreshes stored competitor fields in run details and exports', async () => {
  const { app, db, auth, runId } = await seedCloud()

  const readStored = () => {
    const row = db.select().from(querySnapshots).all().find(snapshot => snapshot.id === SNAPSHOT_ID)!
    return {
      competitorOverlap: row.competitorOverlap,
      recommendedCompetitors: row.recommendedCompetitors,
      answerMentioned: row.answerMentioned,
    }
  }
  const readSurfaces = async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers: auth })
    expect(detail.statusCode, detail.body).toBe(200)
    const exported = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/results/export?format=json', headers: auth })
    expect(exported.statusCode, exported.body).toBe(200)
    const snapshot = (detail.json() as { snapshots: Array<{ id: string; competitorOverlap: string[]; recommendedCompetitors: string[] }> })
      .snapshots.find(row => row.id === SNAPSHOT_ID)!
    const record = (exported.json() as { records: Array<{ snapshotId: string; competitorOverlap: string[]; recommendedCompetitors: string[] }> })
      .records.find(row => row.snapshotId === SNAPSHOT_ID)!
    return {
      detail: { competitorOverlap: snapshot.competitorOverlap, recommendedCompetitors: snapshot.recommendedCompetitors },
      exported: { competitorOverlap: record.competitorOverlap, recommendedCompetitors: record.recommendedCompetitors },
    }
  }

  // Before any alias, the domain label "spoketuneworks" never matches "TuneSpoke".
  expect(readStored()).toEqual({ competitorOverlap: [], recommendedCompetitors: [], answerMentioned: true })

  const named = await app.inject({ method: 'PUT', url: ALIAS_URL, headers: auth, payload: { aliases: ['TuneSpoke'] } })
  expect(named.statusCode, named.body).toBe(200)
  // No polling: the refresh is part of the request on Cloud.
  expect(readStored()).toEqual({
    competitorOverlap: ['spoketuneworks.example'],
    recommendedCompetitors: ['TuneSpoke'],
    answerMentioned: true,
  })
  expect(await readSurfaces()).toEqual({
    detail: { competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] },
    exported: { competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] },
  })

  // Clearing the alias takes the credit away again.
  const cleared = await app.inject({ method: 'PUT', url: ALIAS_URL, headers: auth, payload: { aliases: [] } })
  expect(cleared.statusCode, cleared.body).toBe(200)
  expect(readStored()).toEqual({ competitorOverlap: [], recommendedCompetitors: [], answerMentioned: true })
  expect(await readSurfaces()).toEqual({
    detail: { competitorOverlap: [], recommendedCompetitors: [] },
    exported: { competitorOverlap: [], recommendedCompetitors: [] },
  })
})

test('a failed refresh is logged and never fails the committed alias write', async () => {
  const { app, db, auth } = await seedCloud()
  const errors: LogEntry[] = []
  const stopListening = addLogListener(entry => {
    if (entry.level === 'error') errors.push(entry)
  })
  onTestFinished(() => { stopListening() })

  // The alias write itself never reads snapshots; only the refresh does.
  db.$client.exec('ALTER TABLE query_snapshots RENAME TO query_snapshots_parked')

  const named = await app.inject({ method: 'PUT', url: ALIAS_URL, headers: auth, payload: { aliases: ['TuneSpoke'] } })
  expect(named.statusCode, named.body).toBe(200)
  expect((named.json() as { aliases: string[] }).aliases).toEqual(['TuneSpoke'])
  expect(db.select({ domain: competitors.domain, aliases: competitors.aliases }).from(competitors).all())
    .toEqual([{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }])

  expect(errors.map(entry => ({ msg: entry.msg, projectName: entry.projectName }))).toEqual([
    { msg: 'competitor-alias-triggered backfill failed: no such table: query_snapshots', projectName: 'rotorwise' },
  ])
})

// A project's own alias change fires onAliasesChanged, not
// onCompetitorAliasesChanged, even when it also drops a competitor alias the
// new project alias now claims. Cloud wires that hook too, so the stored
// competitor columns (and answer_mentioned) follow in the same request.
test.each([
  { writer: 'project PUT', write: (app: Awaited<ReturnType<typeof seedCloud>>['app'], auth: Record<string, string>) => app.inject({
    method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', aliases: ['TuneSpoke'] },
  }) },
  { writer: 'apply', write: (app: Awaited<ReturnType<typeof seedCloud>>['app'], auth: Record<string, string>) => app.inject({
    method: 'POST', url: '/api/v1/apply', headers: auth,
    payload: {
      apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'rotorwise' },
      spec: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', aliases: ['TuneSpoke'], competitors: ['spoketuneworks.example'] },
    },
  }) },
])('a $writer that gives the project a competitor\'s alias refreshes the stored competitor fields', async ({ write }) => {
  const { app, db, auth } = await seedCloud()
  const readStored = () => {
    const row = db.select().from(querySnapshots).all().find(snapshot => snapshot.id === SNAPSHOT_ID)!
    return { competitorOverlap: row.competitorOverlap, recommendedCompetitors: row.recommendedCompetitors, answerMentioned: row.answerMentioned }
  }
  const named = await app.inject({ method: 'PUT', url: ALIAS_URL, headers: auth, payload: { aliases: ['TuneSpoke'] } })
  expect(named.statusCode, named.body).toBe(200)
  expect(readStored()).toEqual({ competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'], answerMentioned: true })

  const response = await write(app, auth)
  expect(response.statusCode, response.body).toBeLessThan(300)
  // The project now owns "TuneSpoke": the competitor loses the alias, and the
  // stored answer stops crediting the competitor in the same request.
  expect(db.select({ domain: competitors.domain, aliases: competitors.aliases }).from(competitors).all())
    .toEqual([{ domain: 'spoketuneworks.example', aliases: [] }])
  expect(readStored()).toEqual({ competitorOverlap: [], recommendedCompetitors: [], answerMentioned: true })
})
