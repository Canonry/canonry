import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, competitors, runs, querySnapshots } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * GET /api/v1/runs/:id must expose the honesty pair behind a snapshot's
 * `location` — `requestedContext` (what a plan-aware run asked for) and
 * `supportedContext` (whether the provider actually honoured it). Without
 * both, a caller reading `location` alone cannot tell "no location was
 * requested" apart from "one was requested and ignored".
 */

const NORTH = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-detail-geo-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name: 'geo-honesty',
    displayName: 'Geo Honesty Co',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    locations: [NORTH],
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

function insertRun(db: ReturnType<typeof createClient>, projectId: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    location: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  }).run()
  return id
}

let ctx: ReturnType<typeof buildApp>

beforeEach(async () => {
  ctx = buildApp()
  await ctx.app.ready()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/runs/:id snapshot geo honesty', () => {
  it('exposes requestedContext and supportedContext so a caller can tell an unhonoured request apart from none at all', async () => {
    const projectId = insertProject(ctx.db)
    const runId = insertRun(ctx.db, projectId)

    // A provider that did not thread the requested location: the honest
    // write leaves `location` null while `requestedContext` still records
    // what was asked for and `supportedContext` records that it was not
    // honoured.
    const blindId = crypto.randomUUID()
    ctx.db.insert(querySnapshots).values({
      id: blindId,
      runId,
      queryId: null,
      queryText: 'widget pricing',
      provider: 'cdp:chatgpt',
      citationState: 'not-cited',
      answerText: 'a fake answer',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      requestedContext: NORTH,
      supportedContext: null,
      measurementExecutionId: 'node-1',
      createdAt: new Date().toISOString(),
    }).run()

    // A provider that did honour it.
    const threadedId = crypto.randomUUID()
    ctx.db.insert(querySnapshots).values({
      id: threadedId,
      runId,
      queryId: null,
      queryText: 'widget pricing',
      provider: 'openai',
      citationState: 'not-cited',
      answerText: 'a fake answer',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: NORTH.label,
      requestedContext: NORTH,
      supportedContext: { status: 'applied', resolved: NORTH },
      measurementExecutionId: 'node-1',
      createdAt: new Date().toISOString(),
    }).run()

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { snapshots: Array<{ id: string; location: string | null; requestedContext: unknown; supportedContext: unknown }> }

    const blind = body.snapshots.find(s => s.id === blindId)!
    expect(blind.location).toBeNull()
    expect(blind.requestedContext).toEqual(NORTH)
    expect(blind.supportedContext).toBeNull()

    const threaded = body.snapshots.find(s => s.id === threadedId)!
    expect(threaded.location).toBe(NORTH.label)
    expect(threaded.requestedContext).toEqual(NORTH)
    expect(threaded.supportedContext).toEqual({ status: 'applied', resolved: NORTH })
  })

  it('returns independent competitor citation and mention signals while preserving legacy overlap', async () => {
    const projectId = insertProject(ctx.db)
    const runId = insertRun(ctx.db, projectId)
    ctx.db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId,
      domain: 'rival.com',
      createdAt: new Date().toISOString(),
    }).run()

    const mentionOnlyId = crypto.randomUUID()
    ctx.db.insert(querySnapshots).values({
      id: mentionOnlyId,
      runId,
      queryId: null,
      queryText: 'mention only',
      provider: 'gemini',
      citationState: 'not-cited',
      answerText: 'Rival is the recommended option.',
      citedDomains: [],
      competitorOverlap: ['rival.com'],
      createdAt: new Date().toISOString(),
    }).run()

    const citationOnlyId = crypto.randomUUID()
    ctx.db.insert(querySnapshots).values({
      id: citationOnlyId,
      runId,
      queryId: null,
      queryText: 'citation only',
      provider: 'gemini',
      citationState: 'not-cited',
      answerText: 'No tracked brand is named here.',
      citedDomains: ['rival.com'],
      competitorOverlap: ['rival.com'],
      createdAt: new Date().toISOString(),
    }).run()

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      snapshots: Array<{
        id: string
        competitorOverlap: string[]
        citedCompetitorDomains: string[]
        mentionedCompetitorDomains: string[]
      }>
    }

    expect(body.snapshots.find(snapshot => snapshot.id === mentionOnlyId)).toMatchObject({
      competitorOverlap: ['rival.com'],
      citedCompetitorDomains: [],
      mentionedCompetitorDomains: ['rival.com'],
    })
    expect(body.snapshots.find(snapshot => snapshot.id === citationOnlyId)).toMatchObject({
      competitorOverlap: ['rival.com'],
      citedCompetitorDomains: ['rival.com'],
      mentionedCompetitorDomains: [],
    })
  })
})
