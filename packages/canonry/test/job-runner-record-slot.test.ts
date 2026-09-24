import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  CITED_URL_CAPTURE_VERSION,
  measurementPlanV2ChecksumJson,
  canonicalMeasurementPlanV2Json,
  parseRunError,
  type LocationContext,
  type MeasurementPlanV2,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { queueRunFill, queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import {
  competitors,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runFills,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

// Pins every column a recorded answer carries, on each path that records one:
// the plan sweep, a fill, and the planless sweep. The recording code is shared
// between those paths (and will be shared with batch ingest), so a change that
// quietly alters one stored field shows up here as a diff, not as a drifted
// report weeks later.

const NOW = '2026-08-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const ANSWER = [
  'Planned Co is a solid choice for widgets.',
  '- **Rivalry Widgets**: cheaper, see rivalrywidgets.com',
  '- **Planned Co**: local support',
].join('\n')
const SOURCES = [
  { uri: 'https://example.com/property-001/widgets', title: 'Planned Co widgets' },
  { uri: 'https://rivalrywidgets.com/pricing', title: 'Rivalry pricing' },
]

beforeEach(() => {
  resetSharedProviderExecutionGates()
})

function plan(count: number): MeasurementPlanV2 {
  const questions = Array.from({ length: count }, (_, index) => ({ id: `q-${index + 1}`, text: `widget question ${index + 1}` }))
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] } },
    targets: [{
      stableKey: 'property-001',
      label: 'property-001',
      aliases: ['property-001'],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/property-001', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [],
    querySnapshots: questions.map(q => ({ queryId: q.id, queryText: q.text, provenance: { source: 'manual', sourceId: null, capturedAt: NOW } })),
    assignments: questions.map((q, index) => ({ targetKey: 'property-001', queryId: q.id, queryClass: 'non-brand', executionNodeKey: `exec-${index + 1}` })),
    executionNodes: questions.map((q, index) => ({
      stableKey: `exec-${index + 1}`,
      queryId: q.id,
      queryText: q.text,
      context: { providers: ['openai', 'gemini'], models: { openai: 'gpt-planned', gemini: 'gemini-planned' }, location: NORTH },
      expectedSnapshots: 2,
    })),
    usageEdges: questions.map((q, index) => ({ executionNodeKey: `exec-${index + 1}`, targetKey: 'property-001', queryId: q.id })),
    compiledChecksum: '0'.repeat(64),
  }
  return { ...draft, compiledChecksum: crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex') }
}

function seed(options: { planned: boolean; count: number }): { db: DatabaseClient; projectId: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-record-slot-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  // The screenshot branch renames into `os.homedir()/.canonry/screenshots`.
  const savedHome = process.env.HOME
  process.env.HOME = dir
  onTestFinished(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
  })
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'planned', displayName: 'Planned Co', canonicalDomain: 'example.com', aliases: ['Planned Co'],
    country: 'US', language: 'en', providers: ['openai', 'gemini'], locations: [NORTH], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain: 'rivalrywidgets.com', createdAt: NOW }).run()
  const revision = plan(options.count)
  for (const q of revision.querySnapshots) db.insert(queries).values({ id: q.queryId, projectId, query: q.queryText, createdAt: NOW }).run()
  if (options.planned) {
    const canonicalJson = canonicalMeasurementPlanV2Json(revision)
    const versionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
      schemaVersion: 2, compiledChecksum: revision.compiledChecksum, createdAt: NOW,
    }).run()
    db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  }
  return { db, projectId, home: dir }
}

interface AdapterOptions {
  /** Fails every call when true. */
  fails?: () => boolean
  /** Hands back a screenshot file for this query text. */
  screenshotFor?: string
  /** Runs inside the provider call, before it returns. */
  during?: (input: TrackedQueryInput) => void
  /** Makes `captureCitedUrls` throw by handing it something that is not an array. */
  unreadableSources?: boolean
}

function adapter(name: string, options: AdapterOptions = {}): ProviderAdapter {
  return {
    name,
    supportsLocationContext: true,
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult { return { ok: true, provider: name, message: 'ok' } },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> { return { ok: true, provider: name, message: 'ok' } },
    async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
      if (options.fails?.()) throw new Error(`400 ${name} monthly spend limit reached`)
      options.during?.(input)
      let screenshotPath: string | undefined
      if (options.screenshotFor === input.query) {
        screenshotPath = path.join(os.homedir(), `${name}-shot.png`)
        fs.writeFileSync(screenshotPath, 'png-bytes')
      }
      return {
        provider: name,
        rawResponse: { id: `resp-${input.query}` },
        model: config.model ?? 'fake',
        servedModel: `${config.model ?? 'fake'}-2026-07-01`,
        groundingSources: SOURCES,
        searchQueries: [input.query],
        retrievalStatus: 'used',
        retrievalContract: 'search-required-v1',
        ...(screenshotPath ? { screenshotPath } : {}),
      }
    },
    normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: name,
        answerText: ANSWER,
        citedDomains: ['example.com', 'rivalrywidgets.com'],
        groundingSources: (options.unreadableSources ? undefined : SOURCES) as NormalizedQueryResult['groundingSources'],
        searchQueries: raw.searchQueries,
        retrievalStatus: 'used',
      }
    },
    async generateText(): Promise<string> { return 'fake' },
  }
}

function registry(adapters: readonly ProviderAdapter[]): ProviderRegistry {
  const r = new ProviderRegistry()
  for (const a of adapters) {
    r.register(a, { provider: a.name, apiKey: 'test-key', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 6000, maxRequestsPerDay: 1000 } })
  }
  return r
}

const rowsFor = (db: DatabaseClient, runId: string) =>
  db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
    .sort((left, right) => `${left.provider}:${left.queryText}`.localeCompare(`${right.provider}:${right.queryText}`))

/** Everything but the generated id and write time, which a pin cannot know. */
function stored(row: typeof querySnapshots.$inferSelect) {
  const { id: _id, createdAt, screenshotPath, ...rest } = row
  expect(Number.isNaN(Date.parse(createdAt))).toBe(false)
  return { ...rest, screenshotPath: screenshotPath ? screenshotPath.replace(row.id, '<id>') : null }
}

function expectedPlanRow(runId: string, provider: string, model: string, queryNumber: number, overrides: Record<string, unknown> = {}) {
  const queryText = `widget question ${queryNumber}`
  return {
    runId,
    queryId: `q-${queryNumber}`,
    queryText,
    provider,
    model,
    servedModel: `${model}-2026-07-01`,
    citationState: 'cited',
    answerMentioned: true,
    answerText: ANSWER,
    citedDomains: ['example.com', 'rivalrywidgets.com'],
    citedUrls: provider === 'openai' || provider === 'gemini' ? SOURCES.map(source => source.uri) : null,
    captureStatus: 'complete',
    sourceCount: 2,
    resolvedCount: 2,
    captureVersion: CITED_URL_CAPTURE_VERSION,
    retrievalStatus: 'used',
    retrievalContract: 'search-required-v1',
    competitorOverlap: ['rivalrywidgets.com'],
    recommendedCompetitors: ['Rivalry Widgets'],
    location: 'north-city',
    measurementExecutionId: `exec-${queryNumber}`,
    requestedContext: NORTH,
    supportedContext: { status: 'applied', resolved: NORTH },
    screenshotPath: null,
    dispatchMode: null,
    providerBatchId: null,
    stopReason: null,
    usage: null,
    rawResponse: JSON.stringify({
      model,
      servedModel: `${model}-2026-07-01`,
      groundingSources: SOURCES,
      searchQueries: [queryText],
      apiResponse: { id: `resp-${queryText}` },
    }),
    ...overrides,
  }
}

describe('recorded plan answers', () => {
  it('a sweep stores every field of each slot, screenshot included', async () => {
    const { db, projectId, home } = seed({ planned: true, count: 2 })
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')

    await new JobRunner(db, registry([
      adapter('openai', { screenshotFor: 'widget question 2' }),
      adapter('gemini'),
    ])).executeRun(queued.runId, projectId)

    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()?.status).toBe('completed')
    const rows = rowsFor(db, queued.runId)
    expect(rows.map(stored)).toEqual([
      expectedPlanRow(queued.runId, 'gemini', 'gemini-planned', 1),
      expectedPlanRow(queued.runId, 'gemini', 'gemini-planned', 2),
      expectedPlanRow(queued.runId, 'openai', 'gpt-planned', 1),
      expectedPlanRow(queued.runId, 'openai', 'gpt-planned', 2, { screenshotPath: `${queued.runId}/<id>.png` }),
    ])
    // The screenshot was moved under the run, named for the row that owns it.
    const shot = rows.find(row => row.screenshotPath)!
    expect(fs.readFileSync(path.join(home, '.canonry', 'screenshots', shot.screenshotPath!), 'utf8')).toBe('png-bytes')
    expect(fs.existsSync(path.join(home, 'openai-shot.png'))).toBe(false)
  })

  it('records a failed cited-URL capture as failed rather than failing the answer', async () => {
    const { db, projectId } = seed({ planned: true, count: 1 })
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')

    await new JobRunner(db, registry([adapter('openai', { unreadableSources: true }), adapter('gemini')])).executeRun(queued.runId, projectId)

    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()?.status).toBe('completed')
    const openai = rowsFor(db, queued.runId).find(row => row.provider === 'openai')!
    expect(stored(openai)).toEqual(expectedPlanRow(queued.runId, 'openai', 'gpt-planned', 1, {
      citedUrls: [],
      captureStatus: 'failed',
      sourceCount: 0,
      resolvedCount: 0,
      // With no readable sources the citation and overlap rest on the cited domains alone.
      rawResponse: JSON.stringify({
        model: 'gpt-planned',
        servedModel: 'gpt-planned-2026-07-01',
        groundingSources: [],
        searchQueries: ['widget question 1'],
        apiResponse: { id: 'resp-widget question 1' },
      }),
    }))
  })

  it('a sweep that finds its slot already written fails that answer instead of skipping it', async () => {
    const { db, projectId } = seed({ planned: true, count: 1 })
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')
    const competing = crypto.randomUUID()

    await new JobRunner(db, registry([
      adapter('openai', {
        during: () => {
          db.insert(querySnapshots).values({
            id: competing, runId: queued.runId, provider: 'openai', queryText: 'widget question 1',
            citationState: 'not-cited', measurementExecutionId: 'exec-1', createdAt: NOW,
          }).run()
        },
      }),
      adapter('gemini'),
    ])).executeRun(queued.runId, projectId)

    const run = db.select().from(runs).where(eq(runs.id, queued.runId)).get()!
    expect(run.status).toBe('partial')
    expect(parseRunError(run.error)?.providers?.openai?.message).toMatch(/UNIQUE constraint failed/)
    expect(rowsFor(db, queued.runId).filter(row => row.provider === 'openai').map(row => row.id)).toEqual([competing])
  })
})

describe('recorded fill answers', () => {
  async function partialSweep(count: number) {
    const seeded = seed({ planned: true, count })
    const queued = queueRunIfProjectIdle(seeded.db, { projectId: seeded.projectId })
    if (queued.conflict) throw new Error('unexpected conflict')
    await new JobRunner(seeded.db, registry([adapter('openai', { fails: () => true }), adapter('gemini')]))
      .executeRun(queued.runId, seeded.projectId)
    expect(seeded.db.select().from(runs).where(eq(runs.id, queued.runId)).get()?.status).toBe('partial')
    return { ...seeded, runId: queued.runId }
  }

  it('a filled answer is stored exactly like one the sweep recorded', async () => {
    const { db, runId } = await partialSweep(2)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)

    await new JobRunner(db, registry([adapter('openai'), adapter('gemini')])).executeRunFill(admitted.fill.id)

    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
    expect(rowsFor(db, runId).filter(row => row.provider === 'openai').map(stored)).toEqual([
      expectedPlanRow(runId, 'openai', 'gpt-planned', 1),
      expectedPlanRow(runId, 'openai', 'gpt-planned', 2),
    ])
  })

  it('a fill that loses a slot to another writer records nothing for it and does not count it', async () => {
    const { db, runId } = await partialSweep(2)
    const admitted = queueRunFill(db, runId)
    if (admitted.kind !== 'queued') throw new Error(admitted.kind)
    const competing = crypto.randomUUID()

    await new JobRunner(db, registry([
      adapter('openai', {
        during: (input) => {
          if (input.query !== 'widget question 1') return
          db.insert(querySnapshots).values({
            id: competing, runId, provider: 'openai', queryText: 'widget question 1',
            citationState: 'not-cited', measurementExecutionId: 'exec-1', createdAt: NOW,
          }).run()
        },
      }),
      adapter('gemini'),
    ])).executeRunFill(admitted.fill.id)

    const openai = rowsFor(db, runId).filter(row => row.provider === 'openai')
    expect(openai.map(row => row.measurementExecutionId)).toEqual(['exec-1', 'exec-2'])
    expect(openai.find(row => row.measurementExecutionId === 'exec-1')?.id).toBe(competing)
    expect(db.select().from(runFills).where(eq(runFills.id, admitted.fill.id)).get()).toMatchObject({ status: 'completed', filled: 1, error: null })
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()?.status).toBe('completed')
  })
})

describe('recorded planless answers', () => {
  it('a planless sweep stores every field of each answer', async () => {
    const { db, projectId, home } = seed({ planned: false, count: 1 })
    const queued = queueRunIfProjectIdle(db, { projectId })
    if (queued.conflict) throw new Error('unexpected conflict')

    await new JobRunner(db, registry([adapter('openai', { screenshotFor: 'widget question 1' }), adapter('gemini')]))
      .executeRun(queued.runId, projectId)

    expect(db.select().from(runs).where(eq(runs.id, queued.runId)).get()?.status).toBe('completed')
    const rows = rowsFor(db, queued.runId)
    const planless = (provider: string, model: string, overrides: Record<string, unknown> = {}) => expectedPlanRow(queued.runId, provider, model, 1, {
      // Planless answers carry no execution identity, and the location is the
      // run's (none here) regardless of what the provider supports.
      location: null,
      measurementExecutionId: null,
      requestedContext: null,
      supportedContext: null,
      ...overrides,
    })
    expect(rows.map(stored)).toEqual([
      planless('gemini', 'fake'),
      planless('openai', 'fake', { screenshotPath: `${queued.runId}/<id>.png` }),
    ])
    const shot = rows.find(row => row.screenshotPath)!
    expect(fs.readFileSync(path.join(home, '.canonry', 'screenshots', shot.screenshotPath!), 'utf8')).toBe('png-bytes')
  })
})
