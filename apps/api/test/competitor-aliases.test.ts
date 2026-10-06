import { test, expect, onTestFinished, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getPlatformEnv } from '@ainyc/canonry-config'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'

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

test('a competitor alias write refreshes stored competitor fields in run details and exports', async () => {
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
    id: 'cloud-hook-snapshot',
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

  const readStored = () => db.select().from(querySnapshots).all().find(row => row.id === 'cloud-hook-snapshot')!
  const readSurfaces = async () => {
    const detail = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}`, headers: auth })
    expect(detail.statusCode, detail.body).toBe(200)
    const exported = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/results/export?format=json', headers: auth })
    expect(exported.statusCode, exported.body).toBe(200)
    const snapshot = (detail.json() as { snapshots: Array<{ id: string; competitorOverlap: string[]; recommendedCompetitors: string[] }> })
      .snapshots.find(row => row.id === 'cloud-hook-snapshot')!
    const record = (exported.json() as { records: Array<{ snapshotId: string; competitorOverlap: string[]; recommendedCompetitors: string[] }> })
      .records.find(row => row.snapshotId === 'cloud-hook-snapshot')!
    return {
      detail: { competitorOverlap: snapshot.competitorOverlap, recommendedCompetitors: snapshot.recommendedCompetitors },
      exported: { competitorOverlap: record.competitorOverlap, recommendedCompetitors: record.recommendedCompetitors },
    }
  }

  const named = await app.inject({
    method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', headers: auth,
    payload: { aliases: ['TuneSpoke'] },
  })
  expect(named.statusCode, named.body).toBe(200)
  // No polling: the refresh is part of the request on Cloud.
  expect(readStored()).toMatchObject({
    competitorOverlap: ['spoketuneworks.example'],
    recommendedCompetitors: ['TuneSpoke'],
    answerMentioned: true,
  })
  expect(await readSurfaces()).toEqual({
    detail: { competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] },
    exported: { competitorOverlap: ['spoketuneworks.example'], recommendedCompetitors: ['TuneSpoke'] },
  })

  // Clearing the alias takes the credit away again.
  const cleared = await app.inject({
    method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', headers: auth,
    payload: { aliases: [] },
  })
  expect(cleared.statusCode, cleared.body).toBe(200)
  expect(readStored()).toMatchObject({ competitorOverlap: [], recommendedCompetitors: [], answerMentioned: true })
  expect(await readSurfaces()).toEqual({
    detail: { competitorOverlap: [], recommendedCompetitors: [] },
    exported: { competitorOverlap: [], recommendedCompetitors: [] },
  })
})
