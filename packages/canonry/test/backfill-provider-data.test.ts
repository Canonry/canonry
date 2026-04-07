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

    const openAiKeywordId = crypto.randomUUID()
    const claudeKeywordId = crypto.randomUUID()
    const perplexityKeywordId = crypto.randomUUID()
    db.insert(keywords).values([
      { id: openAiKeywordId, projectId, keyword: 'canonry pricing', createdAt: now },
      { id: claudeKeywordId, projectId, keyword: 'canonry audit workflow', createdAt: now },
      { id: perplexityKeywordId, projectId, keyword: 'canonry alternatives', createdAt: now },
    ]).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId: openAiKeywordId,
      provider: 'openai',
      model: 'gpt-5.4',
      citationState: 'cited',
      answerMentioned: false,
      answerText: 'Old answer text',
      citedDomains: '["canonry.ai"]',
      competitorOverlap: '[]',
      recommendedCompetitors: '[]',
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
      keywordId: claudeKeywordId,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: '',
      citedDomains: '[]',
      competitorOverlap: '[]',
      recommendedCompetitors: '[]',
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
      keywordId: perplexityKeywordId,
      provider: 'perplexity',
      model: 'sonar',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Perplexity answer',
      citedDomains: '["competitor.com"]',
      competitorOverlap: '["competitor.com"]',
      recommendedCompetitors: '[]',
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
    expect(JSON.parse(claudeSnapshot!.citedDomains)).toEqual(['canonry.ai'])
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
    const keywordId = crypto.randomUUID()
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

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'answer visibility tools',
      createdAt: now,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId,
      provider: 'gemini',
      model: 'gemini-3-flash',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: '',
      citedDomains: '["retrieved-only.example.com","canonry.ai"]',
      competitorOverlap: '[]',
      recommendedCompetitors: '[]',
      rawResponse: JSON.stringify({
        model: 'gemini-3-flash',
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
    expect(JSON.parse(snapshot.citedDomains)).toEqual(['canonry.ai'])
    expect(JSON.parse(snapshot.rawResponse!)).toMatchObject({
      groundingSources: [{ uri: 'https://canonry.ai/docs', title: 'Canonry Docs' }],
    })
  })

  it('filters to answer-visibility runs, supports direct raw api responses, and leaves unsupported providers unchanged', async () => {
    const projectId = crypto.randomUUID()
    const answerRunId = crypto.randomUUID()
    const auditRunId = crypto.randomUUID()
    const openAiKeywordId = crypto.randomUUID()
    const auditKeywordId = crypto.randomUUID()
    const localKeywordId = crypto.randomUUID()
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

    db.insert(keywords).values([
      { id: openAiKeywordId, projectId, keyword: 'canonry pricing', createdAt: now },
      { id: auditKeywordId, projectId, keyword: 'site audit keyword', createdAt: now },
      { id: localKeywordId, projectId, keyword: 'local visibility', createdAt: now },
    ]).run()

    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(),
        runId: answerRunId,
        keywordId: openAiKeywordId,
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: '',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
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
        keywordId: localKeywordId,
        provider: 'local',
        model: 'llama',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: 'Local answer without provider envelope',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
        rawResponse: JSON.stringify({ foo: 'bar' }),
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        runId: auditRunId,
        keywordId: auditKeywordId,
        provider: 'openai',
        model: 'gpt-5.4',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: '',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
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
})
