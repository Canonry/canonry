import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs, keywords, querySnapshots } from '@ainyc/canonry-db'
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
    const keywordId = crypto.randomUUID()

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
    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'answer engine optimization',
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
      keywordId,
      provider: 'gemini',
      citationState: 'cited',
      answerMentioned: true,
      citedDomains: '["example.com"]',
      competitorOverlap: '[]',
      recommendedCompetitors: '[]',
      createdAt: '2026-04-18T14:20:00.000Z',
    }).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/runs/latest' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as {
      totalRuns: number
      run: { id: string; snapshots: Array<{ keyword: string; citedDomains: string[] }> }
    }
    expect(body.totalRuns).toBe(2)
    expect(body.run.id).toBe(latestRunId)
    expect(body.run.snapshots).toHaveLength(1)
    expect(body.run.snapshots[0]?.keyword).toBe('answer engine optimization')
    expect(body.run.snapshots[0]?.citedDomains).toEqual(['example.com'])

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
