import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  competitors,
  createClient,
  queries,
  migrate,
  projects,
  querySnapshots,
  runs,
  SentimentRepository,
} from '@canonry/canonry-db'
import { refreshSnapshotMentionIdentity, sentimentHash } from '@canonry/canonry-api-routes'
import { eq } from 'drizzle-orm'
import { RunKinds } from '@canonry/canonry-contracts'
import { backfillAnswerVisibilityCommand } from '../src/commands/backfill.js'

describe('backfill answer-visibility provider reparsing', () => {
  let tmpDir: string
  let configDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-provider-'))
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

  it('rebuilds routed mentions and citations from stored OpenRouter annotations while preserving model identity', async () => {
    const projectId = crypto.randomUUID(); const runId = crypto.randomUUID(); const now = new Date().toISOString()
    const route = 'openrouter:google/gemini-3.1-flash-lite'
    db.insert(projects).values({ id: projectId, name: 'router-backfill', displayName: 'Northstar', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: ['gemini', route], createdAt: now, updatedAt: now }).run()
    db.insert(runs).values({ id: runId, projectId, status: 'completed', kind: RunKinds['answer-visibility'], createdAt: now }).run()
    const id = crypto.randomUUID()
    db.insert(querySnapshots).values({ id, runId, provider: route, model: 'google/gemini-3.1-flash-lite', servedModel: 'google/gemini-3.1-flash-lite-served',
      queryText: 'widget suppliers', answerText: 'Stale answer', answerMentioned: true, citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
      rawResponse: JSON.stringify({ apiResponse: { model: 'google/gemini-3.1-flash-lite-served', choices: [{ message: {
        content: 'Several widget suppliers exist. https://uncited.example', annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/widgets' } }],
      } }] } }),
    }).run()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: 'router-backfill', format: 'json' })
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ examined: 1, reparsed: 1, updated: 1, mentioned: 0 })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, id)).get()).toMatchObject({
      provider: route, model: 'google/gemini-3.1-flash-lite', servedModel: 'google/gemini-3.1-flash-lite-served',
      answerMentioned: false, citationState: 'cited', citedDomains: ['example.com'], answerText: 'Several widget suppliers exist. https://uncited.example',
    })
  })

  it('reprocesses stored OpenAI, Claude, and Perplexity snapshot payloads', async () => {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const now = new Date().toISOString()
    const projectName = 'provider-backfill'

    db.insert(projects).values({
      id: projectId,
      name: projectName,
      displayName: 'Canonry',
      canonicalDomain: 'canonry.ai',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '["openai","claude","perplexity"]',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId,
      domain: 'competitor.com',
      createdAt: now,
    }).run()

    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()

    const openAiQueryId = crypto.randomUUID()
    const claudeQueryId = crypto.randomUUID()
    const perplexityQueryId = crypto.randomUUID()
    db.insert(queries).values([
      { id: openAiQueryId, projectId, query: 'canonry pricing', createdAt: now },
      { id: claudeQueryId, projectId, query: 'canonry audit workflow', createdAt: now },
      { id: perplexityQueryId, projectId, query: 'canonry alternatives', createdAt: now },
    ]).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: openAiQueryId,
      provider: 'openai',
      model: 'gpt-5.4',
      citationState: 'cited',
      answerMentioned: false,
      answerText: 'Old answer text',
      citedDomains: ['canonry.ai'],
      competitorOverlap: [],
      recommendedCompetitors: [],
      rawResponse: JSON.stringify({
        model: 'gpt-5.4',
        groundingSources: [{ uri: 'https://canonry.ai/stale', title: 'Stale source' }],
        searchQueries: [],
        apiResponse: {
          output: [
            {
              type: 'web_search_call',
              action: {
                type: 'search',
                query: 'canonry pricing',
                queries: ['canonry pricing', 'canonry alternatives'],
              },
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Canonry offers pricing guides and implementation support.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://canonry.ai/pricing',
                      title: 'Canonry pricing',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      createdAt: now,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: claudeQueryId,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: '',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      rawResponse: JSON.stringify({
        model: 'claude-sonnet-4-6',
        groundingSources: [{ uri: 'https://competitor.com/review', title: 'Competitor review' }],
        searchQueries: [],
        apiResponse: {
          content: [
            {
              type: 'server_tool_use',
              name: 'web_search',
              input: { query: 'canonry audit workflow' },
            },
            {
              type: 'web_search_tool_result',
              content: [
                { type: 'web_search_result', url: 'https://competitor.com/review', title: 'Competitor review' },
              ],
            },
            {
              type: 'text',
              text: 'Canonry publishes audit workflows for answer visibility teams.',
              citations: [
                {
                  type: 'web_search_result_location',
                  url: 'https://canonry.ai/blog/audit-workflow',
                  title: 'Canonry audit workflow',
                },
              ],
            },
          ],
        },
      }),
      createdAt: now,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId: perplexityQueryId,
      provider: 'perplexity',
      model: 'sonar',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Perplexity answer',
      citedDomains: ['competitor.com'],
      competitorOverlap: ['competitor.com'],
      recommendedCompetitors: [],
      rawResponse: JSON.stringify({
        model: 'sonar',
        groundingSources: [{ uri: 'https://competitor.com/alt', title: '' }],
        searchQueries: ['canonry alternatives'],
        apiResponse: {
          choices: [{ message: { content: 'Competitor is often compared with Canonry.' } }],
          citations: ['https://competitor.com/alt'],
        },
      }),
      createdAt: now,
    }).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: projectName, format: 'json' })
    expect(logSpy).toHaveBeenCalled()

    const snapshots = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()

    const openAiSnapshot = snapshots.find(snapshot => snapshot.provider === 'openai')
    expect(openAiSnapshot?.answerMentioned).toBe(true)
    expect(JSON.parse(openAiSnapshot!.rawResponse!)).toMatchObject({
      searchQueries: ['canonry pricing', 'canonry alternatives'],
      groundingSources: [{ uri: 'https://canonry.ai/pricing', title: 'Canonry pricing' }],
    })

    const claudeSnapshot = snapshots.find(snapshot => snapshot.provider === 'claude')
    expect(claudeSnapshot?.citationState).toBe('cited')
    expect(claudeSnapshot?.answerMentioned).toBe(true)
    expect(claudeSnapshot!.citedDomains).toEqual(['canonry.ai'])
    expect(JSON.parse(claudeSnapshot!.rawResponse!)).toMatchObject({
      searchQueries: ['canonry audit workflow'],
      groundingSources: [{ uri: 'https://canonry.ai/blog/audit-workflow', title: 'Canonry audit workflow' }],
    })

    const perplexitySnapshot = snapshots.find(snapshot => snapshot.provider === 'perplexity')
    expect(JSON.parse(perplexitySnapshot!.rawResponse!)).toMatchObject({
      searchQueries: [],
      groundingSources: [{ uri: 'https://competitor.com/alt', title: '' }],
    })
  })

  it('uses Gemini grounding supports during snapshot reprocessing when available', async () => {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const queryId = crypto.randomUUID()
    const now = new Date().toISOString()
    const projectName = 'gemini-backfill'

    db.insert(projects).values({
      id: projectId,
      name: projectName,
      displayName: 'Canonry',
      canonicalDomain: 'canonry.ai',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '["gemini"]',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()

    db.insert(queries).values({
      id: queryId,
      projectId,
      query: 'answer visibility tools',
      createdAt: now,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      queryId,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: '',
      citedDomains: ['retrieved-only.example.com', 'canonry.ai'],
      competitorOverlap: [],
      recommendedCompetitors: [],
      rawResponse: JSON.stringify({
        model: 'gemini-2.5-flash',
        groundingSources: [
          { uri: 'https://retrieved-only.example.com/post', title: 'Retrieved only' },
          { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' },
        ],
        searchQueries: ['answer visibility tools'],
        apiResponse: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Canonry is a strong option for answer visibility monitoring.' }],
              },
              groundingMetadata: {
                webSearchQueries: ['answer visibility tools'],
                groundingChunks: [
                  { web: { uri: 'https://retrieved-only.example.com/post', title: 'Retrieved only' } },
                  { web: { uri: 'https://canonry.ai/docs', title: 'Canonry Docs' } },
                ],
                groundingSupports: [{ groundingChunkIndices: [1] }],
              },
            },
          ],
        },
      }),
      createdAt: now,
    }).run()

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: projectName, format: 'json' })

    const [snapshot] = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()

    expect(snapshot.citationState).toBe('cited')
    expect(snapshot.citedDomains).toEqual(['canonry.ai'])
    expect(JSON.parse(snapshot.rawResponse!)).toMatchObject({
      groundingSources: [{ uri: 'https://canonry.ai/docs', title: 'Canonry Docs' }],
    })
  })

  it('filters to answer-visibility runs, supports direct raw api responses, and leaves unsupported providers unchanged', async () => {
    const projectId = crypto.randomUUID()
    const answerRunId = crypto.randomUUID()
    const auditRunId = crypto.randomUUID()
    const openAiQueryId = crypto.randomUUID()
    const auditQueryId = crypto.randomUUID()
    const localQueryId = crypto.randomUUID()
    const now = new Date().toISOString()
    const projectName = 'mixed-backfill'

    db.insert(projects).values({
      id: projectId,
      name: projectName,
      displayName: 'Canonry',
      canonicalDomain: 'canonry.ai',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '["openai","local"]',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(runs).values([
      {
        id: answerRunId,
        projectId,
        kind: RunKinds['answer-visibility'],
        status: 'completed',
        trigger: 'manual',
        createdAt: now,
      },
      {
        id: auditRunId,
        projectId,
        kind: RunKinds['site-audit'],
        status: 'completed',
        trigger: 'manual',
        createdAt: now,
      },
    ]).run()

    db.insert(queries).values([
      { id: openAiQueryId, projectId, query: 'canonry pricing', createdAt: now },
      { id: auditQueryId, projectId, query: 'site audit query', createdAt: now },
      { id: localQueryId, projectId, query: 'local visibility', createdAt: now },
    ]).run()

    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(),
        runId: answerRunId,
        queryId: openAiQueryId,
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: '',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        rawResponse: JSON.stringify({
          output: [
            {
              type: 'web_search_call',
              action: {
                type: 'search',
                query: 'canonry pricing',
              },
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Canonry publishes pricing guidance.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://canonry.ai/pricing',
                      title: 'Canonry pricing',
                    },
                  ],
                },
              ],
            },
          ],
        }),
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        runId: answerRunId,
        queryId: localQueryId,
        provider: 'local',
        model: 'llama',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: 'Local answer without provider envelope',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        rawResponse: JSON.stringify({ foo: 'bar' }),
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        runId: auditRunId,
        queryId: auditQueryId,
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: '',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        rawResponse: JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'This should not be reparsed because the run kind is not answer-visibility.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://canonry.ai/should-not-change',
                      title: 'Should not change',
                    },
                  ],
                },
              ],
            },
          ],
        }),
        createdAt: now,
      },
    ]).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: projectName, format: 'json' })
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))

    expect(output.examined).toBe(2)
    expect(output.reparsed).toBe(1)

    const answerSnapshots = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, answerRunId))
      .all()
    const auditSnapshots = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, auditRunId))
      .all()

    const openAiSnapshot = answerSnapshots.find(snapshot => snapshot.provider === 'openai')
    expect(openAiSnapshot?.citationState).toBe('cited')
    expect(JSON.parse(openAiSnapshot!.rawResponse!)).toMatchObject({
      apiResponse: {
        output: [
          { type: 'web_search_call' },
          { type: 'message' },
        ],
      },
      groundingSources: [{ uri: 'https://canonry.ai/pricing', title: 'Canonry pricing' }],
    })

    const localSnapshot = answerSnapshots.find(snapshot => snapshot.provider === 'local')
    expect(localSnapshot?.answerMentioned).toBe(false)
    expect(localSnapshot?.rawResponse).toBe(JSON.stringify({ foo: 'bar' }))

    expect(auditSnapshots[0]?.citationState).toBe('not-cited')
    expect(auditSnapshots[0]?.rawResponse).toContain('should-not-change')
  })

  it('drops a sentiment verdict on text the backfill rewrote, so the rewritten answer counts again', async () => {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const snapshotId = crypto.randomUUID()
    const now = new Date().toISOString()
    const oldText = 'A canonry is the office of a canon in a cathedral chapter.'
    db.insert(projects).values({ id: projectId, name: 'stale-verdict', displayName: 'Canonry', canonicalDomain: 'canonry.ai', ownedDomains: '[]', country: 'US', language: 'en', providers: '["openai"]', createdAt: now, updatedAt: now }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: now }).run()
    db.insert(querySnapshots).values({
      id: snapshotId, runId, provider: 'openai', model: 'gpt-5.4', citationState: 'not-cited', answerMentioned: true, answerText: oldText,
      citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
      // The stored payload now parses to a different answer than the stored text.
      rawResponse: JSON.stringify({ model: 'gpt-5.4', groundingSources: [], searchQueries: [], apiResponse: { output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Canonry tracks how answer engines mention a brand.', annotations: [] }] },
      ] } }),
    }).run()
    // The worker's completion of a wrong-subject verdict on the OLD text.
    const repository = new SentimentRepository(db)
    repository.putDefinition({ id: 'definition', contentHash: 'definition-hash', requestedModel: 'jev-1.13.0', definition: {}, createdAt: now })
    repository.configure({ projectId, enabled: true, evaluationDefinitionId: 'definition', configuration: {}, now })
    repository.admitJob({ projectId, action: 'backfill', origin: 'backfill', enablementEpoch: 1, evaluationDefinitionId: 'definition', idempotencyKey: 'verdict', payloadHash: 'verdict', actor: 'test', selection: { runIds: [runId] }, now,
      work: [{ runId, snapshotId, sourceTextHash: sentimentHash(oldText), subjectHash: 'subject', input: {}, edges: [{ propertyKey: projectId }] }] })
    const work = repository.claim({ owner: 'test', now, leaseMs: 30_000 })!
    repository.completeWork({ workItemId: work.id, owner: 'test', outcome: 'wrong-subject', result: {}, returnedModel: 'jev-1.13.0', now },
      (tx, completed) => { refreshSnapshotMentionIdentity(tx, [completed.snapshotId]) })
    const stored = () => db.select({ answerText: querySnapshots.answerText, answerMentioned: querySnapshots.answerMentioned, mentionIdentity: querySnapshots.mentionIdentity })
      .from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).get()
    expect(stored()).toEqual({ answerText: oldText, answerMentioned: false, mentionIdentity: 'wrong-subject' })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: 'stale-verdict' })

    expect(stored()).toEqual({ answerText: 'Canonry tracks how answer engines mention a brand.', answerMentioned: true, mentionIdentity: null })
  })

  it('--dry-run reports would-update counts without writing to the DB', async () => {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const queryId = crypto.randomUUID()
    const snapshotId = crypto.randomUUID()
    const now = new Date().toISOString()
    const projectName = 'dry-run-vis'

    db.insert(projects).values({
      id: projectId, name: projectName, displayName: 'Canonry',
      canonicalDomain: 'canonry.ai', ownedDomains: '[]', country: 'US', language: 'en',
      providers: '["openai"]', createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values({
      id: runId, projectId, kind: RunKinds['answer-visibility'],
      status: 'completed', trigger: 'manual', createdAt: now,
    }).run()
    db.insert(queries).values({
      id: queryId, projectId, query: 'canonry pricing', createdAt: now,
    }).run()

    // An OpenAI snapshot that needs an answerMentioned flip (currently false,
    // text mentions canonry → would flip to true on a real backfill).
    const originalRawResponse = JSON.stringify({
      apiResponse: {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Canonry costs $99/mo.' }] },
        ],
      },
    })
    const originalCitationState = 'not-cited'
    db.insert(querySnapshots).values({
      id: snapshotId,
      runId, queryId,
      provider: 'openai', model: 'gpt-5',
      citationState: originalCitationState, answerMentioned: false,
      answerText: 'Canonry costs $99/mo.',
      citedDomains: [], competitorOverlap: [], recommendedCompetitors: [],
      rawResponse: originalRawResponse, createdAt: now,
    }).run()

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: projectName, dryRun: true, format: 'json' })
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))

    expect(output.dryRun).toBe(true)
    expect(output.examined).toBe(1)
    expect(output.updated).toBe(0)
    expect(output.wouldUpdate).toBeGreaterThanOrEqual(1)

    // Confirm the snapshot row is untouched
    const snapshot = db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()
    expect(snapshot!.answerMentioned).toBe(false)
    expect(snapshot!.citationState).toBe(originalCitationState)
    expect(snapshot!.rawResponse).toBe(originalRawResponse)
  })
})
