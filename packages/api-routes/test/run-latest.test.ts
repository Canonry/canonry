import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs, queries, querySnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-latest-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)

  return { app, db, tmpDir }
}

describe('GET /api/v1/projects/:name/runs/latest', () => {
  it('returns the latest run with total count and snapshots', async () => {
    const { app, db, tmpDir } = buildApp()
    await app.ready()

    const projectId = crypto.randomUUID()
    const olderRunId = crypto.randomUUID()
    const latestRunId = crypto.randomUUID()
    const queryId = crypto.randomUUID()

    db.insert(projects).values({
      id: projectId,
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      createdAt: '2026-04-18T14:00:00.000Z',
      updatedAt: '2026-04-18T14:00:00.000Z',
    }).run()
    db.insert(queries).values({
      id: queryId,
      projectId,
      query: 'answer engine optimization',
      createdAt: '2026-04-18T14:05:00.000Z',
    }).run()
    db.insert(runs).values([
      {
        id: olderRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: '2026-04-18T14:10:00.000Z',
        finishedAt: '2026-04-18T14:11:00.000Z',
      },
      {
        id: latestRunId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: '2026-04-18T14:20:00.000Z',
        finishedAt: '2026-04-18T14:21:00.000Z',
      },
    ]).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: latestRunId,
      queryId,
      provider: 'gemini',
      citationState: 'cited',
      answerMentioned: true,
      citedDomains: ['example.com'],
      competitorOverlap: [],
      recommendedCompetitors: [],
      createdAt: '2026-04-18T14:20:00.000Z',
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/runs/latest' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as {
      totalRuns: number
      run: { id: string; snapshots: Array<{ query: string; citedDomains: string[] }> }
    }
    expect(body.totalRuns).toBe(2)
    expect(body.run.id).toBe(latestRunId)
    expect(body.run.snapshots).toHaveLength(1)
    expect(body.run.snapshots[0]?.query).toBe('answer engine optimization')
    expect(body.run.snapshots[0]?.citedDomains).toEqual(['example.com'])

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('breaks ties deterministically when runs share the same createdAt (multi-location fan-out)', async () => {
    const { app, db, tmpDir } = buildApp()
    await app.ready()

    const projectId = crypto.randomUUID()
    // IDs deliberately set so that lexicographically-greater id wins the tiebreak,
    // not whatever the DB happens to return first.
    const runAId = '00000000-0000-0000-0000-000000000001'
    const runBId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const sharedCreatedAt = '2026-05-13T17:23:20.060Z'

    db.insert(projects).values({
      id: projectId,
      name: 'azcoatings',
      displayName: 'AZ Coatings',
      canonicalDomain: 'azcoatings.example',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
    }).run()
    db.insert(runs).values([
      {
        id: runAId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: 'florida',
        createdAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
      },
      {
        id: runBId,
        projectId,
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: 'michigan',
        createdAt: sharedCreatedAt,
        finishedAt: sharedCreatedAt,
      },
    ]).run()

    // The same call should yield the same run id every time — no
    // insertion-order or storage-order influence.
    const first = await app.inject({ method: 'GET', url: '/api/v1/projects/azcoatings/runs/latest' })
    const second = await app.inject({ method: 'GET', url: '/api/v1/projects/azcoatings/runs/latest' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const firstBody = JSON.parse(first.payload) as { run: { id: string } }
    const secondBody = JSON.parse(second.payload) as { run: { id: string } }
    expect(firstBody.run.id).toBe(secondBody.run.id)
    // With desc(id) as tiebreak, the lexicographically-greater id wins.
    expect(firstBody.run.id).toBe(runBId)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when a project has no runs', async () => {
    const { app, db, tmpDir } = buildApp()
    await app.ready()

    db.insert(projects).values({
      id: crypto.randomUUID(),
      name: 'empty',
      displayName: 'Empty',
      canonicalDomain: 'empty.example.com',
      country: 'US',
      language: 'en',
      ownedDomains: '[]',
      tags: '[]',
      providers: '[]',
      createdAt: '2026-04-18T14:00:00.000Z',
      updatedAt: '2026-04-18T14:00:00.000Z',
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/empty/runs/latest' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({
      totalRuns: 0,
      run: null,
    })

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
