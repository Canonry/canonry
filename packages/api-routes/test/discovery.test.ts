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
  type DiscoveryDomainClassification,
  type DiscoveryProjectContext,
} from '../src/discovery/index.js'
import type {
  DiscoveryCompetitorType,
  DiscoveryPromoteResult,
  DiscoverySessionDetailDto,
  DiscoverySessionDto,
  LocationContext,
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

function seedProject(
  db: ReturnType<typeof createClient>,
  opts: { icpDescription?: string; locations?: LocationContext[] } = {},
) {
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
    locations: opts.locations ?? [],
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
      { domain: 'aurora-solar.com', hits: 1, competitorType: 'unknown' },
      { domain: 'enerflo.com', hits: 1, competitorType: 'unknown' },
    ])
  })

  it('excludes the project canonical from the map', () => {
    const probes = [{ citedDomains: ['demand-iq.com', 'enerflo.com'] }]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'enerflo.com', hits: 1, competitorType: 'unknown' },
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
      { domain: 'enerflo.com', hits: 3, competitorType: 'unknown' },
      { domain: 'aurora-solar.com', hits: 2, competitorType: 'unknown' },
      { domain: 'helioscope.com', hits: 1, competitorType: 'unknown' },
    ])
  })

  it('returns an empty array when no probes have citations', () => {
    expect(buildCompetitorMap([], project)).toEqual([])
    expect(buildCompetitorMap([{ citedDomains: [] }, { citedDomains: [] }], project)).toEqual([])
  })

  it('canonical match is case-insensitive', () => {
    const probes = [{ citedDomains: ['Demand-IQ.com', 'enerflo.com'] }]
    expect(buildCompetitorMap(probes, project)).toEqual([
      { domain: 'enerflo.com', hits: 1, competitorType: 'unknown' },
    ])
  })

  it('attaches competitorType from the classification map, defaulting unmapped domains to unknown', () => {
    const probes = [
      { citedDomains: ['enerflo.com'] },
      { citedDomains: ['enerflo.com', 'expedia.com'] },
      { citedDomains: ['timeout.com'] },
    ]
    const classification: DiscoveryDomainClassification = {
      'enerflo.com': 'direct-competitor',
      'expedia.com': 'ota-aggregator',
      // timeout.com intentionally omitted — must fall back to unknown.
    }
    expect(buildCompetitorMap(probes, project, classification)).toEqual([
      { domain: 'enerflo.com', hits: 2, competitorType: 'direct-competitor' },
      { domain: 'expedia.com', hits: 1, competitorType: 'ota-aggregator' },
      { domain: 'timeout.com', hits: 1, competitorType: 'unknown' },
    ])
  })
})

describe('executeDiscovery', () => {
  function buildDeps(input: {
    candidates: string[]
    probeResults: Array<{ query: string; citationState: 'cited' | 'not-cited'; citedDomains: string[] }>
    classification?: DiscoveryDomainClassification
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
      async classifyDomains({ domains }) {
        // Echo back only the domains present in the supplied classification map;
        // anything else is left for the orchestrator to fall back to unknown.
        const map: DiscoveryDomainClassification = {}
        for (const domain of domains) {
          const type = input.classification?.[domain]
          if (type) map[domain] = type
        }
        return map
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
      competitorMap: [],
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
      classification: {
        'aurora-solar.com': 'direct-competitor',
        'enerflo.com': 'direct-competitor',
        'random.com': 'other',
      },
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
    // The post-probe classification call types every recurring cited domain.
    expect(result.competitorMap).toEqual([
      { domain: 'aurora-solar.com', hits: 2, competitorType: 'direct-competitor' },
      { domain: 'enerflo.com', hits: 1, competitorType: 'direct-competitor' },
      { domain: 'random.com', hits: 1, competitorType: 'other' },
    ])

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('completed')
    expect(sessionRow.seedCount).toBe(4)
    expect(sessionRow.seedCountRaw).toBe(6)
    expect(sessionRow.citedCount).toBe(1)
    expect(sessionRow.aspirationalCount).toBe(1)
    expect(sessionRow.wastedCount).toBe(2)
    expect(sessionRow.competitorMap).toEqual([
      { domain: 'aurora-solar.com', hits: 2, competitorType: 'direct-competitor' },
      { domain: 'enerflo.com', hits: 1, competitorType: 'direct-competitor' },
      { domain: 'random.com', hits: 1, competitorType: 'other' },
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
      competitorMap: [],
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
      competitorMap: [],
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

  it('falls back to unknown competitor types when classifyDomains throws (best-effort)', async () => {
    const { db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const { projectId } = seedProject(db)
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'queued',
      competitorMap: [],
      createdAt: now,
    }).run()

    const deps = buildDeps({
      candidates: ['alpha q', 'beta q'],
      probeResults: [
        { query: 'alpha q', citationState: 'not-cited', citedDomains: ['enerflo.com'] },
        { query: 'beta q', citationState: 'not-cited', citedDomains: ['enerflo.com'] },
      ],
    })
    // Classification outage must degrade the competitor map, not fail the run.
    deps.classifyDomains = async () => {
      throw new Error('classification provider unavailable')
    }

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
      icpDescription: 'classification failure test',
      deps,
    })

    expect(result.competitorMap).toEqual([
      { domain: 'enerflo.com', hits: 2, competitorType: 'unknown' },
    ])
    expect(db.select().from(discoverySessions).get()!.status).toBe('completed')
  })

  it('forwards the session locations to deps.seed (empty array when omitted)', async () => {
    const { db, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)
    const detroit: LocationContext = { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' }

    const project: DiscoveryProjectContext = {
      id: projectId,
      name: 'demand-iq',
      canonicalDomains: ['demand-iq.com'],
      competitorDomains: [],
    }

    function captureSeedLocations(): { deps: DiscoveryDeps; seen: LocationContext[][] } {
      const seen: LocationContext[][] = []
      const deps: DiscoveryDeps = {
        async seed(input) {
          seen.push(input.locations)
          return { candidates: [], provider: 'gemini-test' }
        },
        async embed() {
          return []
        },
        async probe() {
          return { citationState: 'not-cited', citedDomains: [], rawResponse: {} }
        },
        async classifyDomains() {
          return {}
        },
      }
      return { deps, seen }
    }

    // Locations supplied — the exact resolved set reaches the seed dep.
    const withLocations = captureSeedLocations()
    const sessionWith = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionWith,
      projectId,
      status: 'queued',
      competitorMap: [],
      createdAt: new Date().toISOString(),
    }).run()
    await executeDiscovery({
      db,
      runId: crypto.randomUUID(),
      sessionId: sessionWith,
      project,
      icpDescription: 'location forwarding test',
      locations: [detroit],
      deps: withLocations.deps,
    })
    expect(withLocations.seen).toEqual([[detroit]])

    // Locations omitted — the seed dep still receives a (well-typed) empty array.
    const withoutLocations = captureSeedLocations()
    const sessionWithout = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionWithout,
      projectId,
      status: 'queued',
      competitorMap: [],
      createdAt: new Date().toISOString(),
    }).run()
    await executeDiscovery({
      db,
      runId: crypto.randomUUID(),
      sessionId: sessionWithout,
      project,
      icpDescription: 'location forwarding test',
      deps: withoutLocations.deps,
    })
    expect(withoutLocations.seen).toEqual([[]])
  })
})

describe('discovery routes', () => {
  function buildAppWithRoutes(handlerCalls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; dedup?: number; maxProbes?: number; locations?: LocationContext[] }>) {
    const { app, db, tmpDir } = buildApp()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onDiscoveryRunRequested: ({ runId, sessionId, projectId, icpDescription, dedupThreshold, maxProbes, locations }) => {
        handlerCalls.push({ runId, sessionId, projectId, icp: icpDescription, dedup: dedupThreshold, maxProbes, locations })
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

  const MICHIGAN: LocationContext = { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' }
  const FLORIDA: LocationContext = { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' }

  it('POST /discover/run resolves a locations override to the named subset and hands it to the callback', async () => {
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; locations?: LocationContext[] }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'spray foam installers', locations: [MICHIGAN, FLORIDA] })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { locations: ['florida'] },
    })
    expect(response.statusCode).toBe(201)
    expect(calls).toHaveLength(1)
    // Only the requested service area is forwarded — not the whole project set.
    expect(calls[0]!.locations).toEqual([FLORIDA])
  })

  it('POST /discover/run with no locations override forwards every project location', async () => {
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; locations?: LocationContext[] }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'spray foam installers', locations: [MICHIGAN, FLORIDA] })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    expect(response.statusCode).toBe(201)
    expect(calls[0]!.locations).toEqual([MICHIGAN, FLORIDA])
  })

  it('POST /discover/run forwards an empty locations array when the project has none', async () => {
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; locations?: LocationContext[] }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'spray foam installers' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    expect(response.statusCode).toBe(201)
    expect(calls[0]!.locations).toEqual([])
  })

  it('POST /discover/run rejects an unknown location label with 400 and does not fire the handler', async () => {
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string; locations?: LocationContext[] }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'spray foam installers', locations: [MICHIGAN, FLORIDA] })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { locations: ['california'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    // No session/run rows written and the handler never fired.
    expect(calls).toHaveLength(0)
    expect(db.select().from(discoverySessions).all()).toHaveLength(0)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('POST /discover/run reuses an in-flight session with the same ICP (no new rows, no callback)', async () => {
    // The fragmentation bug in issue #498: back-to-back `canonry discover run`
    // commands today fire a fresh Gemini seed each time. Consolidation keeps
    // the in-flight session and tells the caller the existing IDs.
    const calls: Array<{ runId: string; sessionId: string; projectId: string; icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json() as { runId: string; sessionId: string; consolidated?: boolean }
    expect(firstBody.consolidated).toBeFalsy()

    // Simulate the orchestrator picking up the session — the row is now in a
    // non-terminal status, exactly when a second invocation would race in.
    db.update(discoverySessions).set({ status: 'probing' }).run()

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json() as {
      runId: string
      sessionId: string
      status: string
      consolidated: boolean
    }
    expect(secondBody.consolidated).toBe(true)
    expect(secondBody.sessionId).toBe(firstBody.sessionId)
    expect(secondBody.runId).toBe(firstBody.runId)

    // The expensive seed/probe pipeline must not be re-kicked.
    expect(calls).toHaveLength(1)
    expect(db.select().from(discoverySessions).all()).toHaveLength(1)
    expect(db.select().from(runs).all()).toHaveLength(1)
  })

  it('POST /discover/run reuses a queued session (status check covers the pre-orchestrator window)', async () => {
    const calls: Array<{ runId: string; sessionId: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    const firstBody = first.json() as { sessionId: string }

    // Sit it in `queued` — the orchestrator hasn't started yet. A second POST
    // racing in here must still consolidate.
    expect(db.select().from(discoverySessions).get()!.status).toBe('queued')

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    const secondBody = second.json() as { sessionId: string; consolidated: boolean }
    expect(secondBody.consolidated).toBe(true)
    expect(secondBody.sessionId).toBe(firstBody.sessionId)
    expect(calls).toHaveLength(1)
  })

  it('POST /discover/run does NOT consolidate a completed session — that path is for seed-reuse, not consolidation', async () => {
    const calls: Array<{ sessionId: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    db.insert(discoverySessions).values({
      id: 'old_completed',
      projectId,
      status: 'completed',
      icpDescription: 'industrial coatings',
      competitorMap: [],
      createdAt: new Date().toISOString(),
    }).run()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { sessionId: string; consolidated?: boolean }
    expect(body.consolidated).toBeFalsy()
    expect(body.sessionId).not.toBe('old_completed')
    expect(calls).toHaveLength(1)
    expect(db.select().from(discoverySessions).all()).toHaveLength(2)
  })

  it('POST /discover/run does NOT consolidate a failed session', async () => {
    const calls: Array<{ sessionId: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    db.insert(discoverySessions).values({
      id: 'old_failed',
      projectId,
      status: 'failed',
      icpDescription: 'industrial coatings',
      competitorMap: [],
      error: 'gemini quota',
      createdAt: new Date().toISOString(),
    }).run()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(response.statusCode).toBe(201)
    expect((response.json() as { consolidated?: boolean }).consolidated).toBeFalsy()
    expect(calls).toHaveLength(1)
  })

  it('POST /discover/run creates a new session when the ICP differs from the in-flight one', async () => {
    const calls: Array<{ icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)

    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    db.update(discoverySessions).set({ status: 'probing' }).run()

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'aerospace coatings' },
    })
    expect(second.statusCode).toBe(201)
    expect((second.json() as { consolidated?: boolean }).consolidated).toBeFalsy()
    expect(calls).toHaveLength(2)
    expect(db.select().from(discoverySessions).all()).toHaveLength(2)
  })

  it('POST /discover/run consolidates when the second call only differs by surrounding whitespace', async () => {
    // The route already trims; the consolidation key must use the same
    // normalized form so an operator who adds a stray space in a follow-up
    // command doesn't start a duplicate sweep.
    const calls: Array<{ icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db)

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    const firstBody = first.json() as { sessionId: string }
    db.update(discoverySessions).set({ status: 'probing' }).run()

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: '  industrial coatings  ' },
    })
    const secondBody = second.json() as { sessionId: string; consolidated: boolean }
    expect(secondBody.consolidated).toBe(true)
    expect(secondBody.sessionId).toBe(firstBody.sessionId)
    expect(calls).toHaveLength(1)
  })

  it('POST /discover/run consolidates when both calls fall back to project.icpDescription', async () => {
    const calls: Array<{ icp: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    seedProject(db, { icpDescription: 'industrial coatings' })

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    const firstBody = first.json() as { sessionId: string }
    db.update(discoverySessions).set({ status: 'probing' }).run()

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: {},
    })
    const secondBody = second.json() as { sessionId: string; consolidated: boolean }
    expect(secondBody.consolidated).toBe(true)
    expect(secondBody.sessionId).toBe(firstBody.sessionId)
    expect(calls).toHaveLength(1)
  })

  it('POST /discover/run does NOT consolidate onto a zombie session past the staleness threshold', async () => {
    // If the canonry-side handler is killed mid-run before its catch block
    // can call markSessionFailed, the row gets stuck in seeding/probing
    // forever. Without an age guard every subsequent discover-run for the
    // same (project, ICP) would consolidate onto that zombie and never
    // complete. We pick an age comfortably past the 2-hour threshold so
    // this test doesn't flake if the constant nudges later.
    const calls: Array<{ sessionId: string }> = []
    const { app, db, tmpDir } = buildAppWithRoutes(calls as never)
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const longAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    db.insert(discoverySessions).values({
      id: 'zombie_session',
      projectId,
      runId: 'zombie_run',
      status: 'probing',
      icpDescription: 'industrial coatings',
      competitorMap: [],
      createdAt: longAgoIso,
    }).run()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { sessionId: string; consolidated: boolean }
    expect(body.consolidated).toBe(false)
    expect(body.sessionId).not.toBe('zombie_session')
    expect(calls).toHaveLength(1)
    // Stale row is left in place for an operator to inspect — we only
    // refuse to consolidate onto it; the new session is the second row.
    expect(db.select().from(discoverySessions).all()).toHaveLength(2)

    // A follow-up call now consolidates onto the fresh session (orderBy
    // desc + age guard pick the newest non-stale row), not the zombie.
    const followUp = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/demand-iq/discover/run',
      payload: { icpDescription: 'industrial coatings' },
    })
    expect(followUp.statusCode).toBe(200)
    const followUpBody = followUp.json() as { sessionId: string; consolidated: boolean }
    expect(followUpBody.consolidated).toBe(true)
    expect(followUpBody.sessionId).toBe(body.sessionId)
    expect(followUpBody.sessionId).not.toBe('zombie_session')
    expect(calls).toHaveLength(1)
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
        competitorMap: [],
        createdAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'newer',
        projectId,
        status: 'completed',
        competitorMap: [],
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
      competitorMap: [],
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
      competitorMap: [{ domain: 'aurora-solar.com', hits: 1, competitorType: 'unknown' }],
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
        citedDomains: ['demand-iq.com'],
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
        citedDomains: ['aurora-solar.com'],
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
    // A competitor map persisted without competitorType normalizes to unknown.
    expect(detail.competitorMap).toEqual([
      { domain: 'aurora-solar.com', hits: 1, competitorType: 'unknown' },
    ])
  })

  it('GET /discover/sessions/:id/promote returns bucketed queries + suggested new competitors of every type', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes([])
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db) // aurora-solar.com and enerflo.com are already tracked

    const sessionId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'completed',
      competitorMap: [
        { domain: 'aurora-solar.com', hits: 3, competitorType: 'direct-competitor' }, // already tracked
        { domain: 'enerflo.com', hits: 2, competitorType: 'direct-competitor' }, // already tracked
        { domain: 'expedia.com', hits: 3, competitorType: 'ota-aggregator' }, // new + recurring aggregator
        { domain: 'helioscope.com', hits: 2, competitorType: 'direct-competitor' }, // new + recurring
        { domain: 'oneoff.example', hits: 1, competitorType: 'direct-competitor' }, // new but too noisy to suggest
      ],
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
      suggestedCompetitors: Array<{ domain: string; hits: number; competitorType: string }>
    }
    expect(body.queriesByBucket.cited).toEqual(['q1'])
    expect(body.queriesByBucket.aspirational).toEqual(['q2'])
    expect(body.queriesByBucket['wasted-surface']).toEqual(['q3'])
    // Recurring new domains of EVERY type are surfaced (sorted by hits desc) so
    // the operator can see what --competitor-types would unlock — tracked and
    // one-off domains are still skipped.
    expect(body.suggestedCompetitors).toEqual([
      { domain: 'expedia.com', hits: 3, competitorType: 'ota-aggregator' },
      { domain: 'helioscope.com', hits: 2, competitorType: 'direct-competitor' },
    ])
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
      competitorMap?: Array<{ domain: string; hits: number; competitorType?: DiscoveryCompetitorType }>
    } = {},
  ): string {
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    // Default a seeded competitor to `direct-competitor` — the promotable type
    // — so tests that don't exercise the type filter keep their original
    // "recurring competitor → promoted" intent. Tests for the type filter pass
    // explicit competitorType values.
    const competitorMap = (opts.competitorMap ?? []).map(entry => ({
      domain: entry.domain,
      hits: entry.hits,
      competitorType: entry.competitorType ?? ('direct-competitor' as DiscoveryCompetitorType),
    }))
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: opts.status ?? 'completed',
      competitorMap,
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
        citedDomains: [],
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
    // 25 new competitor domains in intentionally unsorted order. The promote
    // route sorts defensively instead of relying on the orchestrator's persisted
    // order before applying the cap.
    const competitorMap = Array.from({ length: 25 }, (_, i) => ({
      domain: `comp-${String(i).padStart(2, '0')}.com`,
      hits: i + 2,
    }))
    const sessionId = seedSession(db, projectId, { competitorMap })

    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
    })
    expect(preview.statusCode).toBe(200)
    expect(
      (preview.json() as { suggestedCompetitors: Array<{ domain: string; hits: number; competitorType: string }> })
        .suggestedCompetitors[0],
    ).toEqual({
      domain: 'comp-24.com',
      hits: 26,
      competitorType: 'direct-competitor',
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    expect(body.promoted.competitors).toHaveLength(20)
    expect(body.promoted.competitors[0]).toBe('comp-24.com') // highest hits
    expect(body.promoted.competitors).not.toContain('comp-04.com') // beyond the cap
    expect(db.select().from(competitors).all()).toHaveLength(22) // 2 seeded + 20 promoted
  })

  it('promotes only direct-competitor domains by default, skipping aggregators / media / unknown', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const sessionId = seedSession(db, projectId, {
      competitorMap: [
        { domain: 'rival-solar.com', hits: 4, competitorType: 'direct-competitor' },
        { domain: 'expedia.com', hits: 5, competitorType: 'ota-aggregator' },
        { domain: 'timeout.com', hits: 3, competitorType: 'editorial-media' },
        { domain: 'gov.example', hits: 2, competitorType: 'other' },
        { domain: 'legacy.example', hits: 2, competitorType: 'unknown' },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    // Only the direct-competitor is adopted; the aggregator, media, other, and
    // legacy-unknown domains are suppressed even though they clear the hit floor.
    expect(body.promoted.competitors).toEqual(['rival-solar.com'])
    expect(db.select().from(competitors).all().map(c => c.domain).sort()).toEqual([
      'aurora-solar.com',
      'enerflo.com',
      'rival-solar.com',
    ])
  })

  it('competitorTypes request field widens the promote to the listed types', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    const sessionId = seedSession(db, projectId, {
      competitorMap: [
        { domain: 'rival-solar.com', hits: 4, competitorType: 'direct-competitor' },
        { domain: 'timeout.com', hits: 3, competitorType: 'editorial-media' },
        { domain: 'expedia.com', hits: 5, competitorType: 'ota-aggregator' },
        { domain: 'legacy.example', hits: 2, competitorType: 'unknown' },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { competitorTypes: ['direct-competitor', 'editorial-media'] },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DiscoveryPromoteResult
    // direct-competitor + editorial-media adopted (sorted by hits desc); the
    // aggregator and legacy-unknown domains stay suppressed.
    expect(body.promoted.competitors).toEqual(['rival-solar.com', 'timeout.com'])
  })

  it('competitorTypes: ["unknown"] recovers a legacy session promoted before classification existed', async () => {
    const { app, db, tmpDir } = buildAppWithRoutes()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
    const { projectId } = seedProject(db)

    // A session whose competitor_map JSON predates classification: entries have
    // no competitorType field at all, so they normalize to `unknown`.
    const sessionId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'completed',
      // Legacy fixture: entries deliberately lack `competitorType` to exercise
      // the unknown-normalization fallback. Cast bypasses the typed schema so
      // we can land malformed JSON like an older row would have.
      competitorMap: [
        { domain: 'helioscope.com', hits: 3 },
        { domain: 'solargraf.com', hits: 2 },
      ] as DiscoveryCompetitorMapEntry[],
      createdAt: new Date().toISOString(),
    }).run()

    const defaultRun = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { buckets: ['cited'] },
    })
    expect((defaultRun.json() as DiscoveryPromoteResult).promoted.competitors).toEqual([])

    const recovered = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/demand-iq/discover/sessions/${sessionId}/promote`,
      payload: { buckets: ['cited'], competitorTypes: ['unknown'] },
    })
    expect((recovered.json() as DiscoveryPromoteResult).promoted.competitors).toEqual([
      'helioscope.com',
      'solargraf.com',
    ])
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
