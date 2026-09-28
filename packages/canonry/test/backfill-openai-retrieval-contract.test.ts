import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { RunKinds } from '@ainyc/canonry-contracts'
import type { RetrievalContract, RetrievalStatus } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { backfillAnswerVisibilityCommand } from '../src/commands/backfill.js'

// Every published canonry release has sent OpenAI tracked queries with
// `tool_choice: "required"` and `web_search` as the only tool, and every release
// that recorded a retrieval contract (4.139.0 through 5.19.0) labelled those
// rows `native-auto-v1`. The label was wrong, not merely old: the model was
// never left to decide whether to search.
//
// Left alone, the store would show OpenAI switching from native-auto-v1 to
// search-required-v1 at the upgrade, a series break where the method never
// changed. `canonry backfill answer-visibility` corrects exactly those rows, and
// re-derives their retrieval status from the stored response, while leaving
// rows that predate the field (NULL) and every other provider alone.

interface SeedRow {
  provider: string
  retrievalContract: RetrievalContract | null
  retrievalStatus: RetrievalStatus | null
  rawResponse: string | null
}

/** A Responses API payload as the SDK serializes it, with caller-supplied output items. */
function apiResponse(output: unknown[], status = 'completed'): Record<string, unknown> {
  return {
    id: 'resp_0e7d62cd783fd44a006a5d830171d48193b9d91617de68aa7a',
    object: 'response',
    status,
    model: 'gpt-5.4-2026-03-05',
    tool_choice: 'required',
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    output,
  }
}

const SEARCH_CALL = {
  id: 'ws_0e7d62cd783fd44a006a5d830677c881938d213e19bc529d27',
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query: 'canonry pricing' },
}

const CITED_MESSAGE = {
  id: 'msg_0e7d62cd783fd44a006a5d830bb0c48193bf0a2f41f7b8d1c2',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [
    {
      type: 'output_text',
      text: 'Canonry publishes pricing guidance.',
      annotations: [{ type: 'url_citation', url: 'https://canonry.ai/pricing', title: 'Canonry pricing' }],
    },
  ],
}

/** The raw_response envelope exactly as the job runner writes it. */
function storedEnvelope(response: Record<string, unknown>): string {
  return JSON.stringify({
    model: 'gpt-5.4',
    servedModel: 'gpt-5.4-2026-03-05',
    groundingSources: [],
    searchQueries: [],
    apiResponse: response,
  })
}

describe('backfill answer-visibility corrects the OpenAI retrieval contract', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-openai-contract-'))
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    const dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      JSON.stringify({ apiUrl: 'http://localhost:4100', database: dbPath, apiKey: 'cnry_test_key', providers: {} }),
      'utf-8',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = originalConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Seed one project + answer-visibility run holding the given snapshots; returns their ids by key. */
  function seed(projectName: string, rows: Record<string, SeedRow>): Record<string, string> {
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const queryId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: projectId,
      name: projectName,
      displayName: 'Canonry',
      canonicalDomain: 'canonry.ai',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '["openai","claude","gemini"]',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: RunKinds['answer-visibility'],
      status: 'completed',
      trigger: 'manual',
      createdAt: now,
    }).run()
    db.insert(queries).values({ id: queryId, projectId, query: 'canonry pricing', createdAt: now }).run()

    const ids: Record<string, string> = {}
    for (const [key, row] of Object.entries(rows)) {
      const id = crypto.randomUUID()
      ids[key] = id
      db.insert(querySnapshots).values({
        id,
        runId,
        queryId,
        provider: row.provider,
        model: 'model',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: '',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        retrievalContract: row.retrievalContract,
        retrievalStatus: row.retrievalStatus,
        rawResponse: row.rawResponse,
        createdAt: now,
      }).run()
    }
    return ids
  }

  function retrievalOf(id: string): { contract: string | null; status: string | null } {
    const row = db.select().from(querySnapshots).where(eq(querySnapshots.id, id)).get()!
    return { contract: row.retrievalContract, status: row.retrievalStatus }
  }

  async function runBackfill(projectName: string, dryRun = false): Promise<Record<string, unknown>> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await backfillAnswerVisibilityCommand({ project: projectName, dryRun, format: 'json' })
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>
    logSpy.mockRestore()
    return output
  }

  const ROWS: Record<string, SeedRow> = {
    // Mislabelled by releases 4.139.0 through 5.19.0.
    searched: {
      provider: 'openai',
      retrievalContract: 'native-auto-v1',
      retrievalStatus: 'unknown',
      rawResponse: storedEnvelope(apiResponse([SEARCH_CALL, CITED_MESSAGE])),
    },
    unsearched: {
      provider: 'openai',
      retrievalContract: 'native-auto-v1',
      retrievalStatus: 'unknown',
      rawResponse: storedEnvelope(apiResponse([CITED_MESSAGE])),
    },
    truncated: {
      provider: 'openai',
      retrievalContract: 'native-auto-v1',
      retrievalStatus: 'unknown',
      rawResponse: storedEnvelope(apiResponse([{ id: 'rs_1', type: 'reasoning', summary: [] }], 'incomplete')),
    },
    noPayload: {
      provider: 'openai',
      retrievalContract: 'native-auto-v1',
      retrievalStatus: 'unknown',
      rawResponse: JSON.stringify({ model: 'gpt-5.4', groundingSources: [], searchQueries: [] }),
    },
    // Predates the field: stays NULL, because pre-4.139.0 requests were not all
    // built the same way (early releases wrapped the query in a search prompt).
    preField: {
      provider: 'openai',
      retrievalContract: null,
      retrievalStatus: null,
      rawResponse: storedEnvelope(apiResponse([SEARCH_CALL, CITED_MESSAGE])),
    },
    // Written by the corrected adapter.
    current: {
      provider: 'openai',
      retrievalContract: 'search-required-v1',
      retrievalStatus: 'used',
      rawResponse: storedEnvelope(apiResponse([SEARCH_CALL, CITED_MESSAGE])),
    },
    // Gemini really is left to decide whether to ground.
    gemini: {
      provider: 'gemini',
      retrievalContract: 'native-auto-v1',
      retrievalStatus: 'unknown',
      rawResponse: JSON.stringify({ apiResponse: { candidates: [{ content: { parts: [{ text: 'Answer' }] } }] } }),
    },
    claude: {
      provider: 'claude',
      retrievalContract: 'search-required-v1',
      retrievalStatus: 'used',
      rawResponse: JSON.stringify({
        apiResponse: {
          content: [
            { type: 'server_tool_use', name: 'web_search', input: { query: 'canonry pricing' } },
            { type: 'text', text: 'Answer' },
          ],
        },
      }),
    },
  }

  it('relabels only the OpenAI rows the adapter mislabelled and re-derives their status from the stored response', async () => {
    const ids = seed('openai-contract', ROWS)

    const output = await runBackfill('openai-contract')
    expect(output.retrievalRelabeled).toBe(4)

    expect(retrievalOf(ids.searched)).toEqual({ contract: 'search-required-v1', status: 'used' })
    // search-required-v1 promised a search; an intact response without one is the breach, made visible.
    expect(retrievalOf(ids.unsearched)).toEqual({ contract: 'search-required-v1', status: 'not-used' })
    // A response that never finished proves nothing about retrieval.
    expect(retrievalOf(ids.truncated)).toEqual({ contract: 'search-required-v1', status: 'unknown' })
    // The contract is a declaration about the request and holds without a payload;
    // the status is an observation and stays unobserved.
    expect(retrievalOf(ids.noPayload)).toEqual({ contract: 'search-required-v1', status: 'unknown' })

    expect(retrievalOf(ids.preField)).toEqual({ contract: null, status: null })
    expect(retrievalOf(ids.current)).toEqual({ contract: 'search-required-v1', status: 'used' })
    expect(retrievalOf(ids.gemini)).toEqual({ contract: 'native-auto-v1', status: 'unknown' })
    expect(retrievalOf(ids.claude)).toEqual({ contract: 'search-required-v1', status: 'used' })
  })

  it('leaves one OpenAI contract across old and new rows, so grouping by contract shows no series break', async () => {
    seed('openai-series', ROWS)
    await runBackfill('openai-series')

    const recorded = db.select().from(querySnapshots).all()
      .filter(row => row.provider === 'openai' && row.retrievalContract !== null)
      .map(row => row.retrievalContract)
    expect(recorded).toHaveLength(5)
    expect(new Set(recorded)).toEqual(new Set(['search-required-v1']))
  })

  it('is idempotent: a second run relabels nothing and changes nothing', async () => {
    const ids = seed('openai-idempotent', ROWS)
    await runBackfill('openai-idempotent')
    const afterFirst = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, retrievalOf(id)]))

    const second = await runBackfill('openai-idempotent')
    expect(second.retrievalRelabeled).toBe(0)
    expect(second.updated).toBe(0)
    const afterSecond = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, retrievalOf(id)]))
    expect(afterSecond).toEqual(afterFirst)
  })

  it('--dry-run counts the relabel without writing it', async () => {
    const ids = seed('openai-dry-run', ROWS)

    const output = await runBackfill('openai-dry-run', true)
    expect(output.dryRun).toBe(true)
    expect(output.retrievalRelabeled).toBe(4)
    expect(output.updated).toBe(0)

    expect(retrievalOf(ids.searched)).toEqual({ contract: 'native-auto-v1', status: 'unknown' })
    expect(retrievalOf(ids.noPayload)).toEqual({ contract: 'native-auto-v1', status: 'unknown' })
  })
})
