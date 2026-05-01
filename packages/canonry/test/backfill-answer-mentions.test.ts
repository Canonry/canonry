import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  competitors,
  createClient,
  keywords,
  migrate,
  projects,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { RunKinds } from '@ainyc/canonry-contracts'
import { backfillAnswerMentionsCommand } from '../src/commands/backfill.js'

describe('backfill answer-mentions', () => {
  let tmpDir: string
  let configDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-mentions-'))
    configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      JSON.stringify({
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: 'cnry_test_key',
        providers: {},
      }),
      'utf-8',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedAnswerVisibilityRun(opts: {
    projectName: string
    competitorDomains: string[]
  }): { projectId: string; runId: string; keywordId: string } {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()
    const now = new Date().toISOString()

    db.insert(projects).values({
      id: projectId,
      name: opts.projectName,
      displayName: 'Demand IQ',
      canonicalDomain: 'demand-iq.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '["openai"]',
      createdAt: now,
      updatedAt: now,
    }).run()

    for (const domain of opts.competitorDomains) {
      db.insert(competitors).values({
        id: crypto.randomUUID(),
        projectId,
        domain,
        createdAt: now,
      }).run()
    }

    db.insert(runs).values({
      id: runId,
      projectId,
      kind: RunKinds['answer-visibility'],
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'instant roof estimate',
      createdAt: now,
    }).run()

    return { projectId, runId, keywordId }
  }

  it('clears stale competitorOverlap when a stored subdomained competitor caused a brand-token false match', async () => {
    // Pre-fix data: stored competitor `offers.roofle.com`, the original code
    // pulled `offers` as the brand label and word-boundary matched it against
    // the prose word "offers", marking the snapshot as having competitor
    // overlap when in fact Roofle isn't mentioned at all.
    const { runId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'demand-iq',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    const snapshotId = crypto.randomUUID()
    db.insert(querySnapshots).values({
      id: snapshotId,
      runId,
      keywordId,
      provider: 'openai',
      model: 'gpt-5',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Energy Design Systems offers a white-label lead generation tool. Demand IQ uses AI-driven estimates.',
      citedDomains: '[]',
      competitorOverlap: '["offers.roofle.com"]',
      recommendedCompetitors: '[]',
      rawResponse: JSON.stringify({ groundingSources: [], searchQueries: [] }),
      createdAt: now,
    }).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerMentionsCommand({ project: 'demand-iq', format: 'json' })
    const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))

    expect(result.examined).toBe(1)
    expect(result.updated).toBe(1)

    const snapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()
    expect(JSON.parse(snapshot!.competitorOverlap)).toEqual([])
    expect(snapshot!.answerMentioned).toBe(true)
  })

  it('still flags overlap when the answer text mentions the registrable brand', async () => {
    const { runId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'demand-iq-positive',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    const snapshotId = crypto.randomUUID()
    db.insert(querySnapshots).values({
      id: snapshotId,
      runId,
      keywordId,
      provider: 'openai',
      model: 'gpt-5',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Brokers turn to Roofle when they need quick install quotes.',
      citedDomains: '[]',
      competitorOverlap: '[]',
      recommendedCompetitors: '[]',
      rawResponse: JSON.stringify({ groundingSources: [], searchQueries: [] }),
      createdAt: now,
    }).run()

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerMentionsCommand({ project: 'demand-iq-positive', format: 'json' })

    const snapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()
    expect(JSON.parse(snapshot!.competitorOverlap)).toEqual(['offers.roofle.com'])
  })

  it('updates snapshots from providers without a reparse adapter (covers the gap left by answer-visibility backfill)', async () => {
    // CDP/local providers don't have a reparse adapter, so the existing
    // `backfill answer-visibility` command would skip recomputing
    // competitorOverlap/recommendedCompetitors for them. This lighter
    // backfill works off stored data and patches that gap.
    const { runId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'cdp-project',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    const snapshotId = crypto.randomUUID()
    db.insert(querySnapshots).values({
      id: snapshotId,
      runId,
      keywordId,
      provider: 'cdp',
      model: 'chrome',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Energy Design Systems offers a white-label lead generation tool.',
      citedDomains: '[]',
      competitorOverlap: '["offers.roofle.com"]',
      recommendedCompetitors: '[]',
      rawResponse: '{}',
      createdAt: now,
    }).run()

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerMentionsCommand({ project: 'cdp-project', format: 'json' })

    const snapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()
    expect(JSON.parse(snapshot!.competitorOverlap)).toEqual([])
    // answerMentioned remains false — the answer doesn't mention Demand IQ.
    expect(snapshot!.answerMentioned).toBe(false)
  })

  it('is idempotent — a second run reports zero updates', async () => {
    const { runId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'idempotent-project',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId,
      provider: 'openai',
      model: 'gpt-5',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Energy Design Systems offers a white-label lead generation tool. Demand IQ uses AI-driven estimates.',
      citedDomains: '[]',
      competitorOverlap: '["offers.roofle.com"]',
      recommendedCompetitors: '[]',
      rawResponse: JSON.stringify({ groundingSources: [], searchQueries: [] }),
      createdAt: now,
    }).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await backfillAnswerMentionsCommand({ project: 'idempotent-project', format: 'json' })
    const first = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))
    expect(first.updated).toBe(1)

    await backfillAnswerMentionsCommand({ project: 'idempotent-project', format: 'json' })
    const second = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))
    expect(second.examined).toBe(1)
    expect(second.updated).toBe(0)
  })

  it('does not touch citationState, citedDomains, or rawResponse', async () => {
    // The PR fixed only brand-token matching; the citation path is unchanged.
    // This backfill must not modify those columns even if it could.
    const { runId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'preserves-citation-state',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    const snapshotId = crypto.randomUUID()
    const originalRawResponse = JSON.stringify({
      groundingSources: [{ uri: 'https://demand-iq.com/docs', title: 'Demand IQ Docs' }],
      searchQueries: ['instant roof estimate'],
      apiResponse: { foo: 'bar' },
    })
    db.insert(querySnapshots).values({
      id: snapshotId,
      runId,
      keywordId,
      provider: 'openai',
      model: 'gpt-5',
      citationState: 'cited',
      answerMentioned: false,
      answerText: 'Energy Design Systems offers a white-label lead generation tool.',
      citedDomains: '["demand-iq.com"]',
      competitorOverlap: '["offers.roofle.com"]',
      recommendedCompetitors: '[]',
      rawResponse: originalRawResponse,
      createdAt: now,
    }).run()

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerMentionsCommand({ project: 'preserves-citation-state', format: 'json' })

    const snapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()
    expect(snapshot!.citationState).toBe('cited')
    expect(snapshot!.citedDomains).toBe('["demand-iq.com"]')
    expect(snapshot!.rawResponse).toBe(originalRawResponse)
  })

  it('only processes answer-visibility runs', async () => {
    const { projectId, keywordId } = seedAnswerVisibilityRun({
      projectName: 'mixed-runs',
      competitorDomains: ['offers.roofle.com'],
    })
    const now = new Date().toISOString()

    const auditRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: auditRunId,
      projectId,
      kind: RunKinds['site-audit'],
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()

    const auditSnapshotId = crypto.randomUUID()
    db.insert(querySnapshots).values({
      id: auditSnapshotId,
      runId: auditRunId,
      keywordId,
      provider: 'openai',
      model: 'gpt-5',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Energy Design Systems offers a white-label lead generation tool.',
      citedDomains: '[]',
      competitorOverlap: '["offers.roofle.com"]',
      recommendedCompetitors: '[]',
      rawResponse: '{}',
      createdAt: now,
    }).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerMentionsCommand({ project: 'mixed-runs', format: 'json' })
    const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))

    // The site-audit snapshot was not touched.
    expect(result.examined).toBe(0)

    const auditSnapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, auditSnapshotId))
      .get()
    expect(JSON.parse(auditSnapshot!.competitorOverlap)).toEqual(['offers.roofle.com'])
  })
})
