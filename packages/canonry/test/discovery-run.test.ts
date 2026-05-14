import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  competitors,
  createClient,
  discoveryProbes,
  discoverySessions,
  insights,
  migrate,
  parseJsonColumn,
  projects,
  runs,
} from '@ainyc/canonry-db'
import type { DiscoveryDeps } from '@ainyc/canonry-api-routes'
import { ProviderRegistry } from '../src/provider-registry.js'
import {
  buildClassificationPrompt,
  executeDiscoveryRun,
  parseClassificationResponse,
} from '../src/discovery-run.js'

function setup(): { db: ReturnType<typeof createClient>; projectId: string; sessionId: string; runId: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-disc-run-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'demand-iq',
    displayName: 'Demand IQ',
    canonicalDomain: 'demand-iq.com',
    country: 'US',
    language: 'en',
    ownedDomains: '[]',
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

  const sessionId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(discoverySessions).values({
    id: sessionId,
    projectId,
    status: 'queued',
    icpDescription: 'AEO test',
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

  return { db, projectId, sessionId, runId }
}

function buildDeps(opts: { probeBuckets: Array<'cited' | 'wasted' | 'aspirational'> }): DiscoveryDeps {
  const queries = opts.probeBuckets.map((_, i) => String.fromCharCode(97 + i) + ' q')
  return {
    async seed() {
      return { candidates: queries, provider: 'gemini-test' }
    },
    async embed(queries) {
      // Different first-letter → each its own cluster (no dedup).
      return queries.map((q) => {
        const vec = new Array(26).fill(0)
        const ch = q.toLowerCase().charCodeAt(0) - 97
        vec[Math.max(0, ch)] = 1
        return vec
      })
    },
    async probe({ query }) {
      const idx = query.toLowerCase().charCodeAt(0) - 97
      const bucket = opts.probeBuckets[idx]
      if (bucket === 'cited') {
        return { citationState: 'cited', citedDomains: ['demand-iq.com'], rawResponse: {} }
      }
      if (bucket === 'wasted') {
        return { citationState: 'not-cited', citedDomains: ['aurora-solar.com'], rawResponse: {} }
      }
      return { citationState: 'not-cited', citedDomains: ['random.com'], rawResponse: {} }
    },
    async classifyDomains({ domains }) {
      const known: Record<string, 'direct-competitor' | 'other'> = {
        'aurora-solar.com': 'direct-competitor',
        'random.com': 'other',
      }
      const map: Record<string, 'direct-competitor' | 'other'> = {}
      for (const domain of domains) {
        const type = known[domain]
        if (type) map[domain] = type
      }
      return map
    },
  }
}

describe('executeDiscoveryRun', () => {
  it('runs the orchestrator, marks run completed, and writes one discovery insight', async () => {
    const { db, projectId, sessionId, runId } = setup()

    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(),
      runId,
      sessionId,
      projectId,
      icpDescription: 'AEO test',
      deps: buildDeps({ probeBuckets: ['cited', 'wasted', 'wasted', 'aspirational'] }),
    })

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('completed')
    expect(sessionRow.citedCount).toBe(1)
    expect(sessionRow.wastedCount).toBe(2)
    expect(sessionRow.aspirationalCount).toBe(1)
    expect(sessionRow.seedProvider).toBe('gemini-test')
    // The orchestrator's classification pass types every recurring cited domain.
    expect(parseJsonColumn(sessionRow.competitorMap, [])).toEqual([
      { domain: 'aurora-solar.com', hits: 2, competitorType: 'direct-competitor' },
      { domain: 'random.com', hits: 1, competitorType: 'other' },
    ])

    const runRow = db.select().from(runs).get()!
    expect(runRow.status).toBe('completed')
    expect(runRow.finishedAt).not.toBeNull()
    expect(runRow.error).toBeNull()

    const probeRows = db.select().from(discoveryProbes).all()
    expect(probeRows).toHaveLength(4)

    const insightRows = db.select().from(insights).all()
    expect(insightRows).toHaveLength(1)
    const insight = insightRows[0]!
    expect(insight.type).toBe('discovery.basket-divergence')
    expect(insight.runId).toBe(runId)
    expect(insight.projectId).toBe(projectId)
    expect(insight.query).toBe(`discovery:${sessionId}`)
    expect(insight.provider).toBe('gemini-test')
    expect(insight.dismissed).toBe(false)
    // 50% wasted-surface → severity 'high'
    expect(insight.severity).toBe('high')
    const recommendation = parseJsonColumn<{ bucketCounts: Record<string, number>; topCompetitors: Array<{ domain: string }> }>(insight.recommendation, { bucketCounts: {}, topCompetitors: [] })
    expect(recommendation.bucketCounts).toEqual({ cited: 1, aspirational: 1, 'wasted-surface': 2 })
    expect(recommendation.topCompetitors.some(c => c.domain === 'aurora-solar.com')).toBe(true)
  })

  it('marks the run failed and writes session.error when the orchestrator throws', async () => {
    const { db, projectId, sessionId, runId } = setup()

    const explodingDeps: DiscoveryDeps = {
      async seed() {
        throw new Error('Gemini said no')
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

    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(),
      runId,
      sessionId,
      projectId,
      icpDescription: 'AEO test',
      deps: explodingDeps,
    })

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('failed')
    expect(sessionRow.error).toBe('Gemini said no')
    expect(sessionRow.finishedAt).not.toBeNull()

    const runRow = db.select().from(runs).get()!
    expect(runRow.status).toBe('failed')
    expect(runRow.error).toBe('Gemini said no')

    // No insight written on failure
    expect(db.select().from(insights).all()).toHaveLength(0)
  })

  it('does not write any insight when zero probes ran (avoids zero-pair garbage signal)', async () => {
    const { db, projectId, sessionId, runId } = setup()

    const emptySeedDeps: DiscoveryDeps = {
      async seed() {
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

    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(),
      runId,
      sessionId,
      projectId,
      icpDescription: 'empty test',
      deps: emptySeedDeps,
    })

    expect(db.select().from(insights).all()).toHaveLength(0)
    // Session is still completed — empty seed is not an error per se.
    expect(db.select().from(discoverySessions).get()!.status).toBe('completed')
  })

  it('throws when the Gemini provider is missing and no deps override is given', async () => {
    const { db, projectId, sessionId, runId } = setup()

    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(), // empty
      runId,
      sessionId,
      projectId,
      icpDescription: 'AEO test',
    })

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('failed')
    expect(sessionRow.error ?? '').toMatch(/Gemini provider/i)

    const runRow = db.select().from(runs).get()!
    expect(runRow.status).toBe('failed')
  })

  it('insight severity downgrades to "low" when wasted is small relative to cited', async () => {
    const { db, projectId, sessionId, runId } = setup()

    // 4 cited, 1 wasted → wasted ratio = 20%, cited ratio = 80% → severity should be 'low'
    // because cited ratio >= 60%.
    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(),
      runId,
      sessionId,
      projectId,
      icpDescription: 'AEO test',
      deps: buildDeps({ probeBuckets: ['cited', 'cited', 'cited', 'cited', 'wasted'] }),
    })

    const insight = db.select().from(insights).get()!
    expect(insight.severity).toBe('low')
  })
})

describe('buildClassificationPrompt', () => {
  const project = {
    id: 'p',
    name: 'Demand IQ',
    canonicalDomains: ['demand-iq.com'],
    competitorDomains: ['aurora-solar.com', 'enerflo.com'],
  }

  it('includes project context, the ICP, tracked competitors, every domain, and every category', () => {
    const prompt = buildClassificationPrompt({
      project,
      icpDescription: 'solar installers shopping for quoting software',
      domains: ['helioscope.com', 'expedia.com', 'timeout.com'],
    })
    expect(prompt).toContain('Demand IQ')
    expect(prompt).toContain('demand-iq.com')
    expect(prompt).toContain('solar installers shopping for quoting software')
    expect(prompt).toContain('aurora-solar.com, enerflo.com')
    for (const domain of ['helioscope.com', 'expedia.com', 'timeout.com']) {
      expect(prompt).toContain(domain)
    }
    // The full category menu must be spelled out for the model.
    for (const category of ['direct-competitor', 'ota-aggregator', 'editorial-media', 'other']) {
      expect(prompt).toContain(category)
    }
  })

  it('says "none" when the project tracks no competitors yet', () => {
    const prompt = buildClassificationPrompt({
      project: { ...project, competitorDomains: [] },
      icpDescription: 'x',
      domains: ['a.com'],
    })
    expect(prompt).toContain('Already-tracked competitors: none')
  })
})

describe('parseClassificationResponse', () => {
  it('parses the domain => category line format', () => {
    const text = [
      'helioscope.com => direct-competitor',
      'expedia.com => ota-aggregator',
      'timeout.com => editorial-media',
      'sec.gov => other',
    ].join('\n')
    expect(
      parseClassificationResponse(text, ['helioscope.com', 'expedia.com', 'timeout.com', 'sec.gov']),
    ).toEqual({
      'helioscope.com': 'direct-competitor',
      'expedia.com': 'ota-aggregator',
      'timeout.com': 'editorial-media',
      'sec.gov': 'other',
    })
  })

  it('is case-insensitive and tolerates surrounding markdown / numbering', () => {
    const text = ['```', '1. HelioScope.com => Direct-Competitor', '- EXPEDIA.COM  =>  ota-aggregator', '```'].join(
      '\n',
    )
    expect(parseClassificationResponse(text, ['helioscope.com', 'expedia.com'])).toEqual({
      'helioscope.com': 'direct-competitor',
      'expedia.com': 'ota-aggregator',
    })
  })

  it('omits domains the model skipped or labeled with an unrecognized category', () => {
    const text = ['helioscope.com => direct-competitor', 'mystery.com => partner'].join('\n')
    expect(
      parseClassificationResponse(text, ['helioscope.com', 'mystery.com', 'notmentioned.com']),
    ).toEqual({ 'helioscope.com': 'direct-competitor' })
  })

  it('reads the category from the right of => so a category word in the hostname does not pollute', () => {
    expect(parseClassificationResponse('competitor-news.com => other', ['competitor-news.com'])).toEqual({
      'competitor-news.com': 'other',
    })
  })

  it('does not let a shorter domain match a longer domain\'s line', () => {
    const text = ['mysolar.com => editorial-media', 'solar.com => direct-competitor'].join('\n')
    expect(parseClassificationResponse(text, ['solar.com', 'mysolar.com'])).toEqual({
      'solar.com': 'direct-competitor',
      'mysolar.com': 'editorial-media',
    })
  })

  it('keeps the shorter-domain guard when numbering pushes the domain off the line start', () => {
    // `startsWith` fails on every numbered line, so the lookup falls through to
    // the token scan — which must still not let `solar.com` pick up
    // `mysolar.com`'s line.
    const text = ['1. mysolar.com => editorial-media', '2. solar.com => direct-competitor'].join('\n')
    expect(parseClassificationResponse(text, ['solar.com', 'mysolar.com'])).toEqual({
      'solar.com': 'direct-competitor',
      'mysolar.com': 'editorial-media',
    })
  })

  it('does not let a domain match the line of a longer domain it prefixes', () => {
    const text = ['solar.com.au => editorial-media', 'solar.com => direct-competitor'].join('\n')
    expect(parseClassificationResponse(text, ['solar.com', 'solar.com.au'])).toEqual({
      'solar.com': 'direct-competitor',
      'solar.com.au': 'editorial-media',
    })
  })

  it('does not match `other` inside a hostname on an arrow-less line', () => {
    // No `=>` forces the whole-line category scan; `other` must match as a
    // whole token, not inside `brothersolar.com`.
    expect(parseClassificationResponse('brothersolar.com', ['brothersolar.com'])).toEqual({})
    expect(
      parseClassificationResponse('brothersolar.com => direct-competitor', ['brothersolar.com']),
    ).toEqual({ 'brothersolar.com': 'direct-competitor' })
  })

  it('returns an empty map for empty input', () => {
    expect(parseClassificationResponse('', [])).toEqual({})
    expect(parseClassificationResponse('helioscope.com => direct-competitor', [])).toEqual({})
  })
})
