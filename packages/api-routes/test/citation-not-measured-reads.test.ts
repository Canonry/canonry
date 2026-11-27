import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CitationState, RetrievalStatus } from '@canonry/canonry-contracts'
import { createClient, migrate, projects, queries, querySnapshots, runs } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

// Per-answer reads of an engine that returns no sources (Local). Its answers
// record `not-measured`; rows written before that state existed hold
// `not-cited` with retrieval `not-applicable` and must read the same way. A
// not-measured answer is never a citation miss, never a transition, and never
// stands for a query another engine checked.
//
//   r1  gemini cited (not named)       local not-measured (named)
//   r2                                 local OLD row: not-cited + not-applicable (named)
//   r3  gemini not-cited (not named)   local not-measured (named)
//   probe (excluded from tracking reads): gemini cited, local not-measured

const PROJECT = 'local-reads'
const QUERY = 'best crm for agencies'
const NAMED = 'Acme CRM is a common pick for agencies.'
const NOT_NAMED = 'HubSpot and Pipedrive are common picks for agencies.'

interface Ctx {
  app: ReturnType<typeof Fastify>
  tmpDir: string
  runIds: { r1: string; r2: string; r3: string; probe: string }
  snapshotIds: Record<string, string>
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-not-measured-reads-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: PROJECT,
    displayName: 'Acme CRM',
    canonicalDomain: 'acme.example',
    country: 'US',
    language: 'en',
    providers: ['gemini', 'local'],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }).run()
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: QUERY, createdAt: '2026-10-01T00:00:00.000Z' }).run()

  const runIds = { r1: crypto.randomUUID(), r2: crypto.randomUUID(), r3: crypto.randomUUID(), probe: crypto.randomUUID() }
  const runAt: Record<keyof typeof runIds, string> = {
    r1: '2026-10-02T00:00:00.000Z',
    r2: '2026-10-03T00:00:00.000Z',
    r3: '2026-10-04T00:00:00.000Z',
    probe: '2026-10-05T00:00:00.000Z',
  }
  for (const key of Object.keys(runIds) as Array<keyof typeof runIds>) {
    db.insert(runs).values({
      id: runIds[key],
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: key === 'probe' ? 'probe' : 'manual',
      createdAt: runAt[key],
      finishedAt: runAt[key],
    }).run()
  }

  const snapshotIds: Record<string, string> = {}
  const answer = (run: keyof typeof runIds, provider: string, citationState: CitationState, retrievalStatus: RetrievalStatus, named: boolean) => {
    const id = crypto.randomUUID()
    snapshotIds[`${run}:${provider}`] = id
    db.insert(querySnapshots).values({
      id,
      runId: runIds[run],
      queryId,
      queryText: QUERY,
      provider,
      citationState,
      retrievalStatus,
      answerMentioned: named,
      answerText: named ? NAMED : NOT_NAMED,
      citedDomains: citationState === 'cited' ? ['acme.example'] : [],
      rawResponse: JSON.stringify({ groundingSources: citationState === 'cited' ? [{ uri: 'https://acme.example/crm', title: 'Acme' }] : [] }),
      createdAt: runAt[run],
    }).run()
  }
  answer('r1', 'gemini', 'cited', 'used', false)
  answer('r1', 'local', 'not-measured', 'not-applicable', true)
  answer('r2', 'local', 'not-cited', 'not-applicable', true)
  answer('r3', 'gemini', 'not-cited', 'used', false)
  answer('r3', 'local', 'not-measured', 'not-applicable', true)
  answer('probe', 'gemini', 'cited', 'used', false)
  answer('probe', 'local', 'not-measured', 'not-applicable', true)

  return { app, tmpDir, runIds, snapshotIds }
}

let ctx: Ctx
beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

async function get<T>(url: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1${url}` })
  expect(res.statusCode).toBe(200)
  return res.json() as T
}

interface TimelineRun { runId: string; citationState: string; transition: string; answerMentioned: boolean; mentionTransition: string }
type Timeline = Array<{ query: string; runs: TimelineRun[]; providerRuns: Record<string, TimelineRun[]> }>

describe('timeline', () => {
  it('combines engines per run, so an engine without sources never stands for a query another engine checked', async () => {
    const [entry] = await get<Timeline>(`/projects/${PROJECT}/timeline`)
    expect(entry!.runs.map(run => [run.runId, run.citationState, run.transition])).toEqual([
      // Local named the project here, but Gemini's sources cited it: cited.
      [ctx.runIds.r1, 'cited', 'new'],
      // Only the old Local row: nothing measured, so no loss.
      [ctx.runIds.r2, 'not-measured', 'not-measured'],
      // Compared with r1, the last measured run: the citation was lost.
      [ctx.runIds.r3, 'not-cited', 'lost'],
    ])
    // Mention is combined on its own: Local named the project in every run.
    expect(entry!.runs.map(run => [run.answerMentioned, run.mentionTransition])).toEqual([
      [true, 'new'],
      [true, 'mentioned'],
      [true, 'mentioned'],
    ])
  })

  it('gives an engine without sources only not-measured entries, and its peer a gap-free history', async () => {
    const [entry] = await get<Timeline>(`/projects/${PROJECT}/timeline`)
    expect(entry!.providerRuns.local!.map(run => [run.citationState, run.transition])).toEqual([
      ['not-measured', 'not-measured'],
      ['not-measured', 'not-measured'],
      ['not-measured', 'not-measured'],
    ])
    expect(entry!.providerRuns.gemini!.map(run => [run.runId, run.transition])).toEqual([
      [ctx.runIds.r1, 'new'],
      [ctx.runIds.r3, 'lost'],
    ])
  })
})

interface Diff { diff: Array<{ run1State: string | null; run2State: string | null; changed: boolean; visibilityChanged: boolean }> }

describe('snapshot diff', () => {
  it.each([
    { name: 'cited, then only answers without sources', from: 'r1', to: 'r2', states: ['cited', 'not-measured'], changed: false },
    { name: 'only answers without sources, then a checked miss', from: 'r2', to: 'r3', states: ['not-measured', 'not-cited'], changed: false },
    { name: 'cited, then a checked miss beside an answer without sources', from: 'r1', to: 'r3', states: ['cited', 'not-cited'], changed: true },
  ] as const)('$name', async ({ from, to, states, changed }) => {
    const { diff } = await get<Diff>(`/projects/${PROJECT}/snapshots/diff?run1=${ctx.runIds[from]}&run2=${ctx.runIds[to]}`)
    expect(diff).toHaveLength(1)
    expect([diff[0]!.run1State, diff[0]!.run2State]).toEqual(states)
    expect(diff[0]!.changed).toBe(changed)
    // Local named the project in every run.
    expect(diff[0]!.visibilityChanged).toBe(false)
  })
})

describe('per-answer reads', () => {
  it('lists every tracked answer with its read state and leaves out the probe', async () => {
    const { snapshots, total } = await get<{ snapshots: Array<{ id: string; citationState: string }>; total: number }>(`/projects/${PROJECT}/snapshots`)
    expect(total).toBe(5)
    const states = Object.fromEntries(snapshots.map(snapshot => [snapshot.id, snapshot.citationState]))
    expect(states).toEqual({
      [ctx.snapshotIds['r1:gemini']!]: 'cited',
      [ctx.snapshotIds['r1:local']!]: 'not-measured',
      [ctx.snapshotIds['r2:local']!]: 'not-measured',
      [ctx.snapshotIds['r3:gemini']!]: 'not-cited',
      [ctx.snapshotIds['r3:local']!]: 'not-measured',
    })
  })

  it('counts a query only an engine without sources answered as not measured in the run detail', async () => {
    const onlyLocal = await get<{ snapshots: Array<{ citationState: string }>; queryCounts: unknown }>(`/runs/${ctx.runIds.r2}`)
    expect(onlyLocal.snapshots.map(snapshot => snapshot.citationState)).toEqual(['not-measured'])
    expect(onlyLocal.queryCounts).toEqual({ totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 1 })

    // Gemini checked the query's sources, so the query is a measured miss.
    const mixed = await get<{ queryCounts: unknown }>(`/runs/${ctx.runIds.r3}`)
    expect(mixed.queryCounts).toEqual({ totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 0 })
  })

  it('returns the read state on search hits', async () => {
    const { hits } = await get<{ hits: Array<{ kind: string; id: string; citationState?: string }> }>(`/projects/${PROJECT}/search?q=agencies&limit=20`)
    const states = Object.fromEntries(hits.filter(hit => hit.kind === 'snapshot').map(hit => [hit.id, hit.citationState]))
    expect(states[ctx.snapshotIds['r2:local']!]).toBe('not-measured')
    expect(states[ctx.snapshotIds['r1:gemini']!]).toBe('cited')
  })
})

describe('results export', () => {
  it('exports an answer without sources as not measured with a null cited, never a miss', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT}/results/export` })
    expect(res.statusCode).toBe(200)
    const { records } = JSON.parse(res.body) as { records: Array<{ snapshotId: string; citationState: string; cited: boolean | null }> }
    // The probe run is excluded by default.
    expect(records).toHaveLength(5)
    const byId = Object.fromEntries(records.map(record => [record.snapshotId, [record.citationState, record.cited]]))
    expect(byId).toEqual({
      [ctx.snapshotIds['r1:gemini']!]: ['cited', true],
      [ctx.snapshotIds['r1:local']!]: ['not-measured', null],
      [ctx.snapshotIds['r2:local']!]: ['not-measured', null],
      [ctx.snapshotIds['r3:gemini']!]: ['not-cited', false],
      [ctx.snapshotIds['r3:local']!]: ['not-measured', null],
    })
  })

  it('leaves the CSV cited cell empty for an answer without sources', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT}/results/export?format=csv` })
    expect(res.statusCode).toBe(200)
    const [header, ...lines] = res.body.trim().split('\r\n')
    const columns = header!.split(',')
    const at = (line: string, column: string) => line.split(',')[columns.indexOf(column)]
    const rows = lines.map(line => [at(line, 'snapshot_id'), at(line, 'citation_state'), at(line, 'cited')])
    expect(rows).toContainEqual([ctx.snapshotIds['r2:local'], 'not-measured', ''])
    expect(rows).toContainEqual([ctx.snapshotIds['r3:gemini'], 'not-cited', 'false'])
  })
})
