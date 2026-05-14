import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditLog,
  competitors,
  createClient,
  discoveryProbes,
  discoverySessions,
  migrate,
  parseJsonColumn,
  projects,
  queries,
  runs,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import {
  buildCompetitorMap,
  classifyProbeBucket,
  executeDiscovery,
  type DiscoveryDeps,
  type DiscoveryProjectContext,
} from '../src/discovery/index.js'
import type {
  DiscoveryPromoteResult,
  DiscoverySessionDetailDto,
  DiscoverySessionDto,
} from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-discovery-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  return { app, db, tmpDir }
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

function seedProject(db: ReturnType<typeof createClient>, opts: { icpDescription?: string } = {}) {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'demand-iq',
    displayName: 'Demand IQ',
    canonicalDomain: 'demand-iq.com',
    country: 'US',
    language: 'en',
    icpDescription: opts.icpDescription ?? null,
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'aurora-solar.com',
    provenance: 'cli',
    createdAt: now,
  }).run()
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'enerflo.com',
    provenance: 'cli',
    createdAt: now,
  }).run()
  return { projectId }
}

describe('classifyProbeBucket', () => {
  const project: DiscoveryProjectContext = {
    id: 'p',
    name: 'demand-iq',
    canonicalDomains: ['demand-iq.com', 'www.demand-iq.com'],
    competitorDomains: ['aurora-solar.com'],
  }

  it('returns "cited" when any canonical domain is cited (case-insensitive)', () => {
    expect(classifyProbeBucket({
      citationState: 'cited',
      citedDomains: ['Demand-IQ.com'],
      project,
    })).toBe('cited')
  })

  it('returns "wasted-surface" when a tracked competitor is cited but we are not', () => {
    expect(classifyProbeBucket({
      citationState: 'not-cited',
      citedDomains: ['aurora-solar.com', 'random.com'],
      project,
    })).toBe('wasted-surface')
  })

  it('returns "aspirational" when neither we nor a tracked competitor is cited', () => {
    expect(classifyProbeBucket({
      citationState: 'not-cited',
      citedDomains: ['somerando.com'],
      project,
    })).toBe('aspirational')
  })

  it('returns "aspirational" on an empty cited list', () => {
    expect(classifyProbeBucket({
      citationState: 'not-cited',
      citedDomains: [],
      project,
    })).toBe('aspirational')
  })

  it('treats canonical hit as cited even when competitors are also present (cited takes precedence)', () => {
    expect(classifyProbeBucket({
      citationState: 'cited',
      citedDomains: ['demand-iq.com', 'aurora-solar.com'],
      project,
    })).toBe('cited')
  })
})

describe('buildCompetitorMap', () => {
  const project: DiscoveryProjectContext = {
    id: 'p',
    name: 'demand-iq',
    canonicalDomains: ['demand-iq.com'],
    competitorDomains: ['aurora-solar.com'],
  }

  it('counts each domain at most once per probe (within-probe dedup)', () => {
    const probes = [{ citedDomains: ['aurora-solar.com', 'aurora-solar.com', 'enerflo.com'] }]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'aurora-solar.com', hits: 1 },
      { domain: 'enerflo.com', hits: 1 },
    ])
  })

  it('excludes the project canonical from the map', () => {
    const probes = [{ citedDomains: ['demand-iq.com', 'enerflo.com'] }]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'enerflo.com', hits: 1 },
    ])
  })

  it('aggregates and sorts by hits desc, then domain asc', () => {
    const probes = [
      { citedDomains: ['enerflo.com'] },
      { citedDomains: ['aurora-solar.com'] },
      { citedDomains: ['enerflo.com', 'aurora-solar.com'] },
      { citedDomains: ['enerflo.com', 'helioscope.com'] },
    ]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'enerflo.com', hits: 3 },
      { domain: 'aurora-solar.com', hits: 2 },
      { domain: 'helioscope.com', hits: 1 },
    ])
  })

  it('returns an empty array when no probes have citations', () => {
    expect(buildCompetitorMap([], project)).toEqual([])
    expect(buildCompetitorMap([{ citedDomains: [] }, { citedDomains: [] }], project)).toEqual([])
  })

  it('canonical match is case-insensitive', () => {
    const probes = [{ citedDomains: ['Demand-IQ.com', 'enerflo.com'] }]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'enerflo.com', hits: 1 },
    ])
  })
})

describe('executeDiscovery', () => {
  function buildDeps(input: {
    candidates: string[]
    probeResults: Array<{ query: string; citationState: 'cited' | 'not-cited'; citedDomains: string[] }>
  }): DiscoveryDeps {
    const probeMap = new Map(input.probeResults.map(r => [r.query, r]))
    return {
      async seed() {
        return { candidates: input.candidates, provider: 'gemini-test' }
      },
      async embed(queries) {
        // Identity-ish embeddings: each query gets a one-hot vector keyed off its
        // first character, so queries starting with the same letter cluster
        // and queries with distinct first letters do not. Predictable for tests.
        return queries.map((q) => {
          const ch = q.toLowerCase().charCodeAt(0) - 97
          const vec = new Array(26).fill(0)
          vec[Math.max(0, ch)] = 1
          return vec
        })
      },
      async probe({ query }) {
        const hit = probeMap.get(query)
        if (!hit) {
          return { citationState: 'not-cited', citedDomains: [], rawResponse: {} }
        }
        return {
          citationState: hit.citationState,
          citedDomains: hit.citedDomains,
          rawResponse: { provider: 'gemini-test', query },
        }
      },
    }
  }

  it('runs end-to-end: seed → embed/cluster → probe → bucket → write rows', async () => {
    const { db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const { projectId } = seedProject(db, { icpDescription: 'solar contractors' })
    const sessionId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'queued',
      icpDescription: 'solar contractors',
      competitorMap: '[]',
      createdAt: now,
    }).run()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'aeo-discover-probe',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    // Two pairs of candidates share their first letter, so the first-char
    // embedding trick produces 4 distinct clusters from 6 raw candidates.
    // Within each multi-candidate cluster, `pickClusterRepresentative` picks
    // the shortest string. The orchestrator therefore probes 4 canonicals.
    const deps = buildDeps({
      candidates: [
        'best solar software for installers', // 'b' cluster
        'best home solar quoting tool', // 'b' cluster — shorter, wins as rep
        'home solar quoting software', // 'h' cluster
        'ai quote tool', // 'a' cluster — shorter
        'aurora solar alternatives', // 'a' cluster
        'compare solar quoting tools', // 'c' cluster
      ],
      probeResults: [
        {
          // 'b' cluster representative — shortest in cluster
          query: 'best home solar quoting tool',
          citationState: 'cited',
          citedDomains: ['demand-iq.com'],
        },
        {
          query: 'home solar quoting software',
          citationState: 'not-cited',
          citedDomains: ['aurora-solar.com'],
        },
        {
          // 'a' cluster representative — shortest in cluster
          query: 'ai quote tool',
          citationState: 'not-cited',
          citedDomains: ['random.com'],
        },
        {
          query: 'compare solar quoting tools',
          citationState: 'not-cited',
          citedDomains: ['enerflo.com', 'aurora-solar.com'],
        },
      ],
    })

    const result = await executeDiscovery({
      db,
      runId,
      sessionId,
      project: {
        id: projectId,
        name: 'demand-iq',
        canonicalDomains: ['demand-iq.com'],
        competitorDomains: ['aurora-solar.com', 'enerflo.com'],
      },
      icpDescription: 'solar contractors',
      deps,
    })

    expect(result.seedCountRaw).toBe(6)
    expect(result.seedCount).toBe(4) // 6 candidates dedupe to 4 clusters via first-letter
    expect(result.buckets).toEqual({ cited: 1, aspirational: 1, 'wasted-surface': 2 })
    expect(result.competitorMap).toEqual([
      { domain: 'aurora-solar.com', hits: 2 },
      { domain: 'enerflo.com', hits: 1 },
      { domain: 'random.com', hits: 1 },
    ])

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('completed')
    expect(sessionRow.seedCount).toBe(4)
    expect(sessionRow.seedCountRaw).toBe(6)
    expect(sessionRow.citedCount).toBe(1)
    expect(sessionRow.aspirationalCount).toBe(1)
    expect(sessionRow.wastedCount).toBe(2)
    expect(parseJsonColumn(sessionRow.competitorMap, [])).toEqual([
      { domain: 'aurora-solar.com', hits: 2 },
      { domain: 'enerflo.com', hits: 1 },
      { domain: 'random.com', hits: 1 },
    ])
    expect(sessionRow.seedProvider).toBe('gemini-test')
    expect(sessionRow.startedAt).not.toBeNull()
    expect(sessionRow.finishedAt).not.toBeNull()

    const probeRows = db.select().from(discoveryProbes).all()
    expect(probeRows).toHaveLength(4)
    // Every probe row is buckets-tagged.
    expect(new Set(probeRows.map(r => r.bucket))).toEqual(new Set(['cited', 'aspirational', 'wasted-surface']))
  })

  it('respects maxProbes cap: candidates beyond the budget are not probed', async () => {
    const { db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const { projectId } = seedProject(db)
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'queued',
      competitorMap: '[]',
      createdAt: now,
    }).run()
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'aeo-discover-probe',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    // Five candidates, each starting with a distinct letter → 5 clusters of 1.
    // Cap is 2, so only 2 probes fire and probeCount is 2.
    const deps = buildDeps({
      candidates: ['alpha q', 'beta q', 'gamma q', 'delta q', 'epsilon q'],
      probeResults: [
        { query: 'alpha q', citationState: 'cited', citedDomains: ['demand-iq.com'] },
        { query: 'beta q', citationState: 'cited', citedDomains: ['demand-iq.com'] },
        { query: 'gamma q', citationState: 'cited', citedDomains: ['demand-iq.com'] },
      ],
    })

    const result = await executeDiscovery({
      db,
      runId: crypto.randomUUID(),
      sessionId,
      project: {
        id: projectId,
        name: 'demand-iq',
        canonicalDomains: ['demand-iq.com'],
        competitorDomains: [],
      },
      icpDescription: 'cap test',
      maxProbes: 2,
      deps,
    })

    expect(result.seedCountRaw).toBe(5)
    expect(result.seedCount).toBe(2)
    expect(result.buckets.cited + result.buckets.aspirational + result.buckets['wasted-surface']).toBe(2)
    expect(db.select().from(discoveryProbes).all()).toHaveLength(2)
  })

  it('deduplicates whitespace and case in raw candidates', async () => {
    const { db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const { projectId } = seedProject(db)
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'queued',
      competitorMap: '[]',
      createdAt: now,
    }).run()

    const deps = buildDeps({
      candidates: ['alpha q', ' alpha q ', 'ALPHA Q', 'beta q'],
      probeResults: [],
    })

    const result = await executeDiscovery({
      db,
      runId: crypto.randomUUID(),
      sessionId,
      project: {
        id: projectId,
        name: 'demand-iq',
        canonicalDomains: ['demand-iq.com'],
        competitorDomains: [],
      },
      icpDescription: 'dedup test',
      deps,
    })

    // 4 raw → 2 after string dedup → 2 after clustering (different first-char)
    expect(result.seedCountRaw).toBe(2)
    expect(result.seedCount).toBe(2)
  })
})

describe('discovery routes', () => {
  function buildAppWithRoutes(handlerCalls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; dedup?: number; maxProbes?: number }>) {
    const { app, db, tmpDir } = buildApp()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onDiscoveryRunRequested: ({ runId, sessionId, projectId, icpDescription, dedupThreshold, maxProbes }) => {
        handlerCalls.push({ runId, sessionId, projectId, icp: icpDescription, dedup: dedupThreshold, maxProbes })
      },
    } satisfies ApiRoutesOptions)
    return { app, db, tmpDir }
  }

  it('POST /discover/run inserts session + run rows and fires the callback', async () => {
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'Boutique hotels in Williamsburg' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { runId: string; sessionId: string; status: string }
    expect(body.status).toBe('running')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.projectId).toBe(projectId)
    expect(calls[0]!.icp).toBe('Boutique hotels in Williamsburg')
    expect(calls[0]!.runId).toBe(body.runId)
    expect(calls[0]!.sessionId).toBe(body.sessionId)

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.icpDescription).toBe('Boutique hotels in Williamsburg')
    expect(sessionRow.status).toBe('queued')
    // The session row must carry the run ID so the run-coordinator can find
    // the right session when two discovery runs overlap on the same project.
    expect(sessionRow.runId).toBe(body.runId)

    const runRow = db.select().from(runs).get()!
    expect(runRow.kind).toBe('aeo-discover-probe')
    expect(runRow.status).toBe('queued')
  })

  it('POST /discover/run falls back to project.icpDescription when body omits it', async () => {
    const calls: Array<{ icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'AEO analyst tooling' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    expect(response.statusCode).toBe(201)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.icp).toBe('AEO analyst tooling')
  })

  it('POST /discover/run rejects when no ICP is available anywhere', async () => {
    const calls: Array<unknown> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    })
    expect(calls).toHaveLength(0)
  })

  it('POST /discover/run rejects when no handler is registered', async () => {
    const { app, db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)
    seedProject(db, { icpDescription: 'test' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.details?.reason).toBe('no-discovery-handler')
  })

  it('GET /discover/sessions returns sessions newest-first', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes([])
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    db.insert(discoverySessions).values([
      {
        id: 'older',
        projectId,
        status: 'completed',
        competitorMap: '[]',
        createdAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'newer',
        projectId,
        status: 'completed',
        competitorMap: '[]',
        createdAt: '2026-05-10T00:00:00Z',
      },
    ]).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/discover/sessions',
    })
    expect(response.statusCode).toBe(200)
    const sessions = response.json() as DiscoverySessionDto[]
    expect(sessions.map(s => s.id)).toEqual(['newer', 'older'])
  })

  it('GET /discover/sessions/:id 404s for a session that does not belong to the project', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes([])
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    // Wrong project — create a session for a different project ID
    const otherProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: otherProjectId,
      name: 'other',
      displayName: 'Other',
      canonicalDomain: 'other.com',
      country: 'US',
      language: 'en',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()
    db.insert(discoverySessions).values({
      id: 'sess_other',
      projectId: otherProjectId,
      status: 'completed',
      competitorMap: '[]',
      createdAt: new Date().toISOString(),
    }).run()
    // Use the wrong project to look up the session
    expect(projectId).not.toBe(otherProjectId)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/demand-iq/discover/sessions/sess_other',
    })
    expect(response.statusCode).toBe(404)
  })

  it('GET /discover/sessions/:id returns session + probe rows', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes([])
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const sessionId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'completed',
      seedProvider: 'gemini',
      seedCount: 2,
      seedCountRaw: 3,
      probeCount: 2,
      citedCount: 1,
      aspirationalCount: 0,
      wastedCount: 1,
      competitorMap: JSON.stringify([{ domain: 'aurora-solar.com', hits: 1 }]),
      createdAt: new Date().toISOString(),
    }).run()
    db.insert(discoveryProbes).values([
      {
        id: 'probe_1',
        sessionId,
        projectId,
        query: 'best solar quoting',
        bucket: 'cited',
        citationState: 'cited',
        citedDomains: JSON.stringify(['demand-iq.com']),
        rawResponse: '{}',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'probe_2',
        sessionId,
        projectId,
        query: 'aurora alternatives',
        bucket: 'wasted-surface',
        citationState: 'not-cited',
        citedDomains: JSON.stringify(['aurora-solar.com']),
        rawResponse: '{}',
        createdAt: new Date().toISOString(),
      },
    ]).run()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}`,
    })
    expect(response.statusCode).toBe(200)
    const detail = response.json() as DiscoverySessionDetailDto
    expect(detail.probes).toHaveLength(2)
    expect(detail.probes!.map(p => p.bucket)).toEqual(expect.arrayContaining(['cited', 'wasted-surface']))
    expect(detail.competitorMap).toEqual([{ domain: 'aurora-solar.com', hits: 1 }])
  })

  it('GET /discover/sessions/:id/promote returns bucketed queries + suggested new competitors', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes([])
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db) // aurora-solar.com and enerflo.com are already tracked

    const sessionId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'completed',
      competitorMap: JSON.stringify([
        { domain: 'aurora-solar.com', hits: 3 }, // already tracked
        { domain: 'enerflo.com', hits: 2 }, // already tracked
        { domain: 'helioscope.com', hits: 2 }, // new + recurring
        { domain: 'oneoff.example', hits: 1 }, // new but too noisy to suggest
      ]),
      createdAt: new Date().toISOString(),
    }).run()
    db.insert(discoveryProbes).values([
      {
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: 'q1',
        bucket: 'cited',
        citationState: 'cited',
        citedDomains: '[]',
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: 'q2',
        bucket: 'aspirational',
        citationState: 'not-cited',
        citedDomains: '[]',
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: 'q3',
        bucket: 'wasted-surface',
        citationState: 'not-cited',
        citedDomains: '[]',
        createdAt: new Date().toISOString(),
      },
    ]).run()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      queriesByBucket: { cited: string[]; aspirational: string[]; 'wasted-surface': string[] }
      suggestedCompetitors: Array<{ domain: string; hits: number }>
    }
    expect(body.queriesByBucket.cited).toEqual(['q1'])
    expect(body.queriesByBucket.aspirational).toEqual(['q2'])
    expect(body.queriesByBucket['wasted-surface']).toEqual(['q3'])
    // Only recurring new domains are suggested — tracked and one-off domains are skipped.
    expect(body.suggestedCompetitors).toEqual([{ domain: 'helioscope.com', hits: 2 }])
  })
})

describe('queries.provenance is unaffected by route registration', () => {
  // Regression: discovery hooks must NOT silently set provenance on existing
  // writers. The `promote` route is what writes provenance='discovery:<id>';
  // merely registering the discovery routes must not change `queries` writes.
  it('inserting a query through POST /queries still records provenance="cli"', async () => {
    const { app, db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    app.register(apiRoutes, { db, skipAuth: true, onDiscoveryRunRequested: () => {} } satisfies ApiRoutesOptions)
    const { projectId } = seedProject(db)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/queries',
      payload: { queries: ['probe sanity check'] },
    })
    expect(response.statusCode).toBeLessThan(300)

    const rows = db.select().from(queries).all()
    const inserted = rows.find(r => r.projectId === projectId && r.query === 'probe sanity check')
    expect(inserted?.provenance).toBe('cli')
  })
})

describe('POST /discover/sessions/:id/promote', () => {
  function buildAppWithRoutes() {
    const { app, db, tmpDir } = buildApp()
    app.register(apiRoutes, { db, skipAuth: true, onDiscoveryRunRequested: () => {} } satisfies ApiRoutesOptions)
    return { app, db, tmpDir }
  }

  function seedSession(
    db: ReturnType<typeof createClient>,
    projectId: string,
    opts: {
      status?: string
      probes?: Array<{ query: string; bucket: string }>
      competitorMap?: Array<{ domain: string; hits: number }>
    } = {},
  ): string {
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: opts.status ?? 'completed',
      competitorMap: JSON.stringify(opts.competitorMap ?? []),
      createdAt: now,
    }).run()
    for (const p of opts.probes ?? []) {
      db.insert(discoveryProbes).values({
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: p.query,
        bucket: p.bucket,
        citationState: p.bucket === 'cited' ? 'cited' : 'not-cited',
        citedDomains: '[]',
        createdAt: now,
      }).run()
    }
    return sessionId
  }

  it('promotes cited + aspirational by default, tags discovery provenance, and writes one audit log row', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db) // tracks aurora-solar.com, enerflo.com

    const sessionId = seedSession(db, projectId, {
      probes: [
        { query: 'best solar quoting tool', bucket: 'cited' },
        { query: 'solar crm for installers', bucket: 'aspirational' },
        { query: 'aurora solar alternatives', bucket: 'wasted-surface' },
      ],
      competitorMap: [
        { domain: 'aurora-solar.com', hits: 3 }, // already tracked
        { domain: 'helioscope.com', hits: 2 }, // recurring new
        { domain: 'solargraf.com', hits: 1 }, // one-off new
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    expect(body.promoted.queries).toEqual([
      'best solar quoting tool',
      'solar crm for installers',
    ])
    expect(body.promoted.competitors).toEqual(['helioscope.com'])
    expect(body.skipped.queries).toEqual([])
    expect(body.skipped.competitors).toEqual(['aurora-solar.com'])

    // Every promoted query carries discovery provenance.
    const queryRows = db.select().from(queries).all()
    expect(queryRows).toHaveLength(2)
    expect(new Set(queryRows.map(r => r.provenance))).toEqual(new Set([`discovery:${sessionId}`]))

    // Competitors: 2 seeded ('cli') + 1 promoted ('discovery:<id>').
    const compRows = db.select().from(competitors).all()
    expect(compRows).toHaveLength(3)
    const promotedComps = compRows.filter(c => c.provenance === `discovery:${sessionId}`)
    expect(promotedComps.map(c => c.domain).sort()).toEqual(['helioscope.com'])

    // Exactly one discovery.promoted audit row, pointed at the session.
    const promoteAudits = db.select().from(auditLog).all().filter(a => a.action === 'discovery.promoted')
    expect(promoteAudits).toHaveLength(1)
    expect(promoteAudits[0]!.entityId).toBe(sessionId)
  })

  it('promotes only the requested buckets, including wasted-surface when explicit, and skips competitors when includeCompetitors is false', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const sessionId = seedSession(db, projectId, {
      probes: [
        { query: 'cited query', bucket: 'cited' },
        { query: 'aspirational query', bucket: 'aspirational' },
        { query: 'wasted query', bucket: 'wasted-surface' },
      ],
      competitorMap: [{ domain: 'helioscope.com', hits: 1 }],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { buckets: ['wasted-surface'], includeCompetitors: false },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    expect(body.promoted.queries).toEqual(['wasted query'])
    expect(body.promoted.competitors).toEqual([])

    // Only the explicitly requested wasted-surface query landed.
    expect(db.select().from(queries).all().map(r => r.query)).toEqual(['wasted query'])
    // includeCompetitors=false → helioscope.com was not merged.
    expect(db.select().from(competitors).all()).toHaveLength(2)
  })

  it('is idempotent — a second promote skips already-tracked rows and writes no audit log', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const sessionId = seedSession(db, projectId, {
      probes: [{ query: 'best solar quoting tool', bucket: 'cited' }],
      competitorMap: [{ domain: 'helioscope.com', hits: 2 }],
    })
    const url = `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`

    const first = await app.inject({ method: 'POST', url, payload: {} })
    expect(first.statusCode).toBe(200)
    expect((first.json() as DiscoveryPromoteResult).promoted).toEqual({
      queries: ['best solar quoting tool'],
      competitors: ['helioscope.com'],
    })

    const second = await app.inject({ method: 'POST', url, payload: {} })
    expect(second.statusCode).toBe(200)
    const body = second.json() as DiscoveryPromoteResult
    expect(body.promoted).toEqual({ queries: [], competitors: [] })
    expect(body.skipped).toEqual({
      queries: ['best solar quoting tool'],
      competitors: ['helioscope.com'],
    })

    // No duplicate rows from the re-run.
    expect(db.select().from(queries).all()).toHaveLength(1)
    expect(db.select().from(competitors).all()).toHaveLength(3) // 2 seeded + 1 promoted
    // The empty second run must not write an audit row.
    expect(db.select().from(auditLog).all().filter(a => a.action === 'discovery.promoted')).toHaveLength(1)
  })

  it('dedupes case-insensitively against the existing basket', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)
    // Existing tracked query — same text, different casing from the probe.
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: 'Best Solar Quoting Tool',
      provenance: 'cli',
      createdAt: new Date().toISOString(),
    }).run()

    const sessionId = seedSession(db, projectId, {
      probes: [{ query: 'best solar quoting tool', bucket: 'cited' }],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { includeCompetitors: false },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    expect(body.promoted.queries).toEqual([])
    expect(body.skipped.queries).toEqual(['best solar quoting tool'])
    // No near-duplicate row added.
    expect(db.select().from(queries).all()).toHaveLength(1)
  })

  it('caps promoted competitors at the preview cap (20), highest-hit first', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)
    // 25 new competitor domains, already sorted by hits desc (as the
    // orchestrator persists the competitor map).
    const competitorMap = Array.from({ length: 25 }, (_, i) => ({
      domain: `comp-${String(i).padStart(2, '0')}.com`,
      hits: 25 - i,
    }))
    const sessionId = seedSession(db, projectId, { competitorMap })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    expect(body.promoted.competitors).toHaveLength(20)
    expect(body.promoted.competitors[0]).toBe('comp-00.com') // highest hits
    expect(body.promoted.competitors).not.toContain('comp-20.com') // beyond the cap
    expect(db.select().from(competitors).all()).toHaveLength(22) // 2 seeded + 20 promoted
  })

  it('rejects promotion of a session that is not completed', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    for (const status of ['queued', 'seeding', 'probing', 'failed']) {
      const sessionId = seedSession(db, projectId, {
        status,
        probes: [{ query: `q-${status}`, bucket: 'cited' }],
      })
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
        payload: {},
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    }
    // Nothing promoted from any of the non-completed sessions.
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('rejects an invalid bucket value', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)
    const sessionId = seedSession(db, projectId, {
      probes: [{ query: 'q', bucket: 'cited' }],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { buckets: ['not-a-bucket'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })

  it('404s for a session that does not belong to the project', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)
    const otherProjectId = crypto.randomUUID()
    db.insert(projects).values({
      id: otherProjectId,
      name: 'other',
      displayName: 'Other',
      canonicalDomain: 'other.com',
      country: 'US',
      language: 'en',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()
    const sessionId = seedSession(db, otherProjectId, {
      probes: [{ query: 'q', bucket: 'cited' }],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })
})
