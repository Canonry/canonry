import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs, type DatabaseClient } from '@canonry/canonry-db'
import { RunKinds, RunStatuses, RunTriggers, runsAttentionDtoSchema, type RunKind, type RunStatus, type RunTrigger } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'

/**
 * GET /runs/attention is Overview's Activity for the dashboard, `canonry
 * activity`, `canonry overview --all` and MCP: each job's latest run that
 * failed, finished partly, was cancelled, or is still queued or running. A job
 * is one project, kind, location and source, spot checks apart from sweeps,
 * and every run of the window counts, however many newer runs exist.
 */

let directory: string
let db: DatabaseClient
let app: FastifyInstance

const NOW = Date.now()
const daysAgo = (days: number, minutes = 0) => new Date(NOW - days * 86_400_000 - minutes * 60_000).toISOString()

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-runs-attention-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
  seedProject('proj_acme', 'acme', 'Acme Coatings')
  seedProject('proj_beta', 'beta', 'Beta Roofing')
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

function seedProject(id: string, name: string, displayName: string) {
  db.insert(projects).values({ id, name, displayName, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: daysAgo(60), updatedAt: daysAgo(60) }).run()
}

function seedRun(id: string, fields: {
  projectId?: string
  kind?: RunKind
  status: RunStatus
  trigger?: RunTrigger
  createdAt: string
  location?: string | null
  sourceId?: string | null
  queries?: string[] | null
  error?: string | null
  measurementPlanVersionId?: string | null
  measurementManifest?: Record<string, unknown> | null
}) {
  db.insert(runs).values({
    id,
    projectId: fields.projectId ?? 'proj_acme',
    kind: fields.kind ?? RunKinds['answer-visibility'],
    status: fields.status,
    trigger: fields.trigger ?? RunTriggers.scheduled,
    createdAt: fields.createdAt,
    location: fields.location ?? null,
    sourceId: fields.sourceId ?? null,
    queries: fields.queries ?? null,
    error: fields.error ?? null,
    measurementPlanVersionId: fields.measurementPlanVersionId ?? null,
    measurementManifest: fields.measurementManifest ?? null,
  }).run()
}

async function readAttention(query = '') {
  const response = await app.inject({ method: 'GET', url: `/api/v1/runs/attention${query}` })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as unknown
  return { body: runsAttentionDtoSchema.parse(body), raw: body as { items: Array<{ run: Record<string, unknown> }> } }
}

const ids = (body: { items: Array<{ run: { id: string } }> }) => body.items.map(item => item.run.id)

describe('GET /runs/attention', () => {
  it('lists each job\'s latest run that failed or is still working, newest first, with its project', async () => {
    seedRun('gsc-failed', { kind: RunKinds['gsc-sync'], status: RunStatuses.failed, createdAt: daysAgo(3), error: JSON.stringify({ message: 'Search Console access was revoked.' }) })
    seedRun('gsc-fixed', { kind: RunKinds['gsc-sync'], status: RunStatuses.completed, createdAt: daysAgo(2) })
    seedRun('ga-ok', { kind: RunKinds['ga-sync'], status: RunStatuses.completed, createdAt: daysAgo(3) })
    seedRun('ga-failed', { kind: RunKinds['ga-sync'], status: RunStatuses.failed, createdAt: daysAgo(1), error: JSON.stringify({ message: 'GA4 access expired.' }) })
    seedRun('audit-cancelled', { projectId: 'proj_beta', kind: RunKinds['site-audit'], status: RunStatuses.cancelled, createdAt: daysAgo(4) })
    seedRun('sweep-partial', { projectId: 'proj_beta', status: RunStatuses.partial, createdAt: daysAgo(0, 30) })
    seedRun('sweep-running', { status: RunStatuses.running, createdAt: daysAgo(0, 5) })

    const { body } = await readAttention()
    expect(ids(body)).toEqual(['sweep-running', 'sweep-partial', 'ga-failed', 'audit-cancelled'])
    expect(body.items[2]).toEqual({
      project: { id: 'proj_acme', name: 'acme', displayName: 'Acme Coatings' },
      run: expect.objectContaining({ id: 'ga-failed', kind: 'ga-sync', status: 'failed', error: { message: 'GA4 access expired.' } }),
    })
    expect(body.items[1]!.project).toEqual({ id: 'proj_beta', name: 'beta', displayName: 'Beta Roofing' })
  })

  // `--all-locations` stores one run per location at the same instant with random ids.
  it('keeps every location of a fan-out sweep apart, so no completed sibling hides a failed or queued one', async () => {
    const at = daysAgo(0, 10)
    seedRun('ffff-michigan', { location: 'michigan', status: RunStatuses.completed, createdAt: at })
    seedRun('0000-florida', { location: 'florida', status: RunStatuses.failed, createdAt: at })
    seedRun('8888-texas', { location: 'texas', status: RunStatuses.queued, createdAt: at })

    const { body } = await readAttention()
    expect(ids(body)).toEqual(['8888-texas', '0000-florida'])
    expect(body.items.map(item => item.run.location)).toEqual(['texas', 'florida'])
  })

  it('never lets a spot check or another traffic source stand in for a failed job', async () => {
    seedRun('sweep-failed', { status: RunStatuses.failed, createdAt: daysAgo(2) })
    seedRun('spot-check-ok', { status: RunStatuses.completed, createdAt: daysAgo(1), queries: ['best roof coating'] })
    seedRun('traffic-a-failed', { kind: RunKinds['traffic-sync'], sourceId: 'source-a', status: RunStatuses.failed, createdAt: daysAgo(2, 1) })
    seedRun('traffic-b-ok', { kind: RunKinds['traffic-sync'], sourceId: 'source-b', status: RunStatuses.completed, createdAt: daysAgo(1) })

    const { body } = await readAttention()
    expect(ids(body)).toEqual(['sweep-failed', 'traffic-a-failed'])
  })

  // The old list read the newest 100 runs, so a busy instance pushed failures out of view.
  it('finds a job\'s failure however many newer runs other jobs made', async () => {
    seedRun('audit-failed', { kind: RunKinds['site-audit'], status: RunStatuses.failed, createdAt: daysAgo(5) })
    for (let index = 0; index < 150; index++) {
      seedRun(`sync-${index}`, { projectId: 'proj_beta', kind: RunKinds['gsc-sync'], status: RunStatuses.completed, createdAt: daysAgo(4, -index) })
    }

    const { body } = await readAttention()
    expect(ids(body)).toEqual(['audit-failed'])
  })

  it('leaves out probes and per-URL inspections, and never lets a probe stand in for a real run', async () => {
    seedRun('sweep-failed', { status: RunStatuses.failed, createdAt: daysAgo(2) })
    seedRun('probe-ok', { status: RunStatuses.completed, trigger: RunTriggers.probe, createdAt: daysAgo(1) })
    seedRun('probe-failed', { kind: RunKinds['site-audit'], status: RunStatuses.failed, trigger: RunTriggers.probe, createdAt: daysAgo(1) })
    seedRun('inspect-failed', { kind: RunKinds['bing-inspect'], status: RunStatuses.failed, createdAt: daysAgo(1) })

    const { body } = await readAttention()
    expect(ids(body)).toEqual(['sweep-failed'])
  })

  it('reads the last 30 days by default, or from `since`, and echoes the window', async () => {
    seedRun('old-failure', { kind: RunKinds['site-audit'], status: RunStatuses.failed, createdAt: daysAgo(40) })
    seedRun('recent-failure', { kind: RunKinds['gsc-sync'], status: RunStatuses.failed, createdAt: daysAgo(10) })

    const fallback = await readAttention()
    expect(ids(fallback.body)).toEqual(['recent-failure'])
    expect(Date.parse(fallback.body.since)).toBeGreaterThanOrEqual(NOW - 30 * 86_400_000)
    expect(Date.parse(fallback.body.since)).toBeLessThanOrEqual(Date.now() - 30 * 86_400_000)

    const since = daysAgo(50)
    const wide = await readAttention(`?since=${encodeURIComponent(since)}`)
    expect(ids(wide.body)).toEqual(['recent-failure', 'old-failure'])
    expect(wide.body.since).toBe(since)

    const narrow = await readAttention(`?since=${encodeURIComponent(daysAgo(5))}`)
    expect(narrow.body.items).toEqual([])

    const invalid = await app.inject({ method: 'GET', url: '/api/v1/runs/attention?since=yesterday' })
    expect(invalid.statusCode).toBe(400)
  })

  it('sends a plan run without its measurement manifest', async () => {
    seedRun('plan-sweep-failed', {
      status: RunStatuses.failed, createdAt: daysAgo(1),
      measurementManifest: { slots: Array.from({ length: 50 }, (_, index) => ({ slotId: `slot-${index}` })) },
    })

    const { raw } = await readAttention()
    // The run keeps its measurement provenance block, minus the manifest.
    expect(raw.items[0]!.run).toMatchObject({ id: 'plan-sweep-failed', measurementPlanVersionId: null })
    expect(raw.items[0]!.run).not.toHaveProperty('measurementManifest')
  })

  it('returns an empty list when every job\'s latest run completed', async () => {
    seedRun('sweep-ok', { status: RunStatuses.completed, createdAt: daysAgo(1) })
    const { body } = await readAttention()
    expect(body.items).toEqual([])
  })
})
