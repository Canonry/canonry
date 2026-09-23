import crypto from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  buildMeasurementRunManifestV1,
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
} from '@ainyc/canonry-contracts'
import { buildMeasurementRunManifest } from '@ainyc/canonry-api-routes'
import {
  createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs,
} from '@ainyc/canonry-db'
import { museAdapter } from '@ainyc/canonry-provider-muse'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

afterEach(() => vi.unstubAllGlobals())

function responseFor(query: string) {
  const mentions = query === 'best widgets'
  return {
    id: crypto.randomUUID(), status: 'completed', model: 'muse-spark-1.3',
    output: [
      { type: 'web_search_call', status: 'completed', results: [
        { type: 'text_result', url: 'https://example.com/retrieved-only', title: 'Retrieved only' },
      ] },
      { type: 'message', status: 'completed', content: [{
        type: 'output_text',
        text: mentions ? 'Northstar offers widgets.' : 'Several widget options exist.',
        annotations: [{
          type: 'url_citation',
          url: mentions ? 'https://rival.example/widgets' : 'https://example.com/widgets',
          title: 'A cited page', start_index: 0, end_index: 7,
        }],
      }] },
    ],
  }
}

type MuseRequest = { input: string; tools: Array<{ type: string; user_location?: unknown }>; model: string; include?: string[]; tool_choice?: unknown }

async function runMuse(kind: 'Simple' | 'Advanced', respond: (query: string) => unknown) {
  resetSharedProviderExecutionGates()
  const requests: MuseRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as MuseRequest
    requests.push(body)
    return new Response(JSON.stringify(respond(body.input)), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))

  const db = createClient(':memory:')
  migrate(db)
  try {
    const now = '2026-09-23T00:00:00.000Z'
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const queryRows = ['best widgets', 'widget options'].map(query => ({
      id: crypto.randomUUID(), projectId, query, createdAt: now,
    }))
    const location = { label: 'New York', city: 'New York', region: 'NY', country: 'US' }
    db.insert(projects).values({
      id: projectId, name: 'northstar', displayName: 'Northstar', aliases: ['Northstar'],
      canonicalDomain: 'example.com', country: 'US', language: 'en', providers: ['muse'],
      locations: [location], defaultLocation: location.label, createdAt: now, updatedAt: now,
    }).run()
    db.insert(queries).values(queryRows).run()

    if (kind === 'Advanced') {
      const plan = compileMeasurementPlan({
        schemaVersion: 1,
        targets: [{ stableKey: 'widgets', label: 'Widgets', aliases: ['Widgets'], urls: [{
          kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive',
        }] }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['widgets'] }],
        targetQuerySelections: [{ targetKey: 'widgets', queryIds: queryRows.map(row => row.id) }],
      }, {
        canonicalDomain: 'example.com', ownedDomains: [], brandNames: ['Northstar'],
        defaultContext: location, locations: [location],
        trackedQueries: queryRows.map(row => ({ id: row.id, query: row.query })),
        expectedSnapshots: 1,
      })
      const canonicalJson = canonicalMeasurementPlanJson(plan)
      const versionId = crypto.randomUUID()
      db.insert(measurementPlanVersions).values({
        id: versionId, projectId, revision: 1, canonicalJson,
        checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: now,
      }).run()
      db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()
      db.insert(runs).values({
        id: runId, projectId, status: 'queued', measurementPlanVersionId: versionId,
        measurementManifest: buildMeasurementRunManifestV1({
          expectedSlots: buildMeasurementRunManifest(plan, ['muse']).expectedSlots,
        }), createdAt: now,
      }).run()
    } else {
      db.insert(runs).values({ id: runId, projectId, status: 'queued', createdAt: now }).run()
    }

    const registry = new ProviderRegistry()
    registry.register(museAdapter, {
      provider: 'muse', apiKey: 'test-key', baseUrl: 'https://api.meta.ai/v1',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 },
    })
    await new JobRunner(db, registry).executeRun(runId, projectId)
    return { requests, rows: db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all() }
  } finally {
    db.$client.close()
  }
}

test.each(['Simple', 'Advanced'] as const)('Muse persists independent mention, citation, and search evidence in %s', async (kind) => {
  const { requests, rows } = await runMuse(kind, responseFor)
  expect(requests).toHaveLength(2)
  expect(requests.map(request => request.input).sort()).toEqual(['best widgets', 'widget options'])
  expect(requests.every(request => request.model === 'muse-spark-1.3')).toBe(true)
  expect(requests.every(request => request.include === undefined)).toBe(true)
  expect(requests.every(request => request.tool_choice === undefined)).toBe(true)
  expect(requests.every(request => request.tools.length === 1)).toBe(true)
  expect(requests.every(request => request.tools[0]?.type === 'web_search')).toBe(true)
  expect(requests.every(request => JSON.stringify(request.tools[0]?.user_location).includes('New York'))).toBe(true)
  expect(rows).toHaveLength(2)
  const byQuery = Object.fromEntries(rows.map(row => [row.queryText, row]))
  expect(byQuery['best widgets']).toMatchObject({
    answerMentioned: true, citationState: 'not-cited', citedDomains: ['rival.example'],
    retrievalStatus: 'used', retrievalContract: 'native-auto-v1',
    citedUrls: ['https://rival.example/widgets'],
  })
  expect(byQuery['widget options']).toMatchObject({
    answerMentioned: false, citationState: 'cited', citedDomains: ['example.com'],
    retrievalStatus: 'used', retrievalContract: 'native-auto-v1',
    citedUrls: ['https://example.com/widgets'],
  })
  expect(rows.every(row => row.servedModel === 'muse-spark-1.3')).toBe(true)
  expect(rows.every(row => row.location === 'New York')).toBe(true)
  expect(rows.every(row => kind === 'Advanced' ? Boolean(row.measurementExecutionId) : !row.measurementExecutionId)).toBe(true)
  expect(rows.every(row => kind === 'Advanced' ? row.supportedContext?.status === 'applied' : row.supportedContext === null)).toBe(true)
})

test('an Advanced Muse answer that never searched does not claim the requested location', async () => {
  const { requests, rows } = await runMuse('Advanced', query => ({
    id: crypto.randomUUID(), status: 'completed', model: 'muse-spark-1.3',
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: `About ${query}.` }] }],
  }))
  expect(requests.every(request => JSON.stringify(request.tools[0]?.user_location).includes('New York'))).toBe(true)
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row.retrievalStatus).toBe('not-used')
    expect(row.supportedContext).toEqual({ status: 'ignored' })
    expect(row.location).toBeNull()
  }
})
