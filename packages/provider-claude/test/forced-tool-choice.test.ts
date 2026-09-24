import { describe, test, expect, vi, afterEach } from 'vitest'
import { RetrievalContracts } from '@ainyc/canonry-contracts'

import { claudeAdapter } from '../src/adapter.js'
import {
  CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE,
  CLAUDE_RETRIEVAL_CONTRACT,
  claudeModelRejectsForcedToolChoice,
  claudeRetrievalContractForModel,
  executeTrackedQuery,
  normalizeResult,
  validateConfig,
} from '../src/normalize.js'

// Anthropic documents that Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos
// 5.1 reject forced tool use: `tool_choice` `any` / `tool` returns HTTP 400
// ("tool_choice: type "tool" and "any" are not supported for this model.").
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use
// https://platform.claude.com/docs/en/api/errors#forced-tool-use-not-supported
//
// search-required-v1 guarantees retrieval by forcing `web_search`, so on those
// models it would fail every tracked query. They run under native-auto-v1
// instead (tool offered, Claude decides), and each snapshot records that
// contract so nothing reads the weaker guarantee as the stronger one.

const REJECTS_FORCING = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1'] as const

// The nearest neighbours matter most: each rejecting id extends one of these
// as a string prefix (`claude-opus-5` / `claude-opus-5-5`), and Anthropic
// documents that Claude Fable 5 and Claude Opus 5 still accept forcing.
const ACCEPTS_FORCING = [
  'claude-opus-5',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
] as const

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }
const QUERY = { query: 'commercial roof restoration', canonicalDomains: ['example.com'], competitorDomains: [] }

const FORCED = { type: 'tool', name: 'web_search' }
const AUTO = { type: 'auto' }

/** Stub the Messages API and capture the request body the SDK sent. */
function captureRequest(content: unknown[]): () => Record<string, unknown> {
  let sent: Record<string, unknown> = {}
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    sent = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: typeof sent.model === 'string' ? sent.model : 'unknown',
        content,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return () => sent
}

const searchCall = {
  type: 'server_tool_use',
  id: 'srvtoolu_1',
  name: 'web_search',
  input: { query: 'commercial roof restoration' },
}
const searchResult = {
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: [{ type: 'web_search_result', url: 'https://roofingcontractor.example/guide', title: 'Guide' }],
}
const SEARCHED = [
  searchCall,
  searchResult,
  {
    type: 'text',
    text: 'Restoration coats an existing roof.',
    citations: [
      {
        type: 'web_search_result_location',
        url: 'https://roofingcontractor.example/guide',
        title: 'Guide',
        cited_text: 'Restoration coats an existing roof',
      },
    ],
  },
]
const UNSEARCHED = [{ type: 'text', text: 'Restoration coats an existing roof.' }]

function inputFor(model: string | undefined) {
  return { ...QUERY, config: { apiKey: 'k', quotaPolicy, ...(model === undefined ? {} : { model }) } }
}

function adapterConfigFor(model: string) {
  return { provider: 'claude' as const, apiKey: 'k', model, quotaPolicy }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('which models reject forced tool_choice', () => {
  test('the table names exactly the models Anthropic documents, and nothing guessed', () => {
    expect([...CLAUDE_MODELS_REJECTING_FORCED_TOOL_CHOICE].sort()).toEqual([...REJECTS_FORCING].sort())
  })

  test.each(REJECTS_FORCING)('%s rejects forced tool_choice', (model) => {
    expect(claudeModelRejectsForcedToolChoice(model)).toBe(true)
  })

  test.each(ACCEPTS_FORCING)('%s accepts forced tool_choice', (model) => {
    expect(claudeModelRejectsForcedToolChoice(model)).toBe(false)
  })

  test('matching tolerates the case and whitespace a hand-edited config can carry', () => {
    expect(claudeModelRejectsForcedToolChoice('  Claude-Opus-5-5\n')).toBe(true)
    expect(claudeModelRejectsForcedToolChoice('')).toBe(false)
  })
})

describe('the retrieval contract each model runs under', () => {
  test.each(REJECTS_FORCING)('%s runs native-auto-v1', (model) => {
    expect(claudeRetrievalContractForModel(model)).toBe(RetrievalContracts['native-auto-v1'])
  })

  test.each(ACCEPTS_FORCING)('%s keeps search-required-v1', (model) => {
    expect(claudeRetrievalContractForModel(model)).toBe(RetrievalContracts['search-required-v1'])
    expect(claudeRetrievalContractForModel(model)).toBe(CLAUDE_RETRIEVAL_CONTRACT)
  })
})

describe('model validation', () => {
  test.each(REJECTS_FORCING)('%s is accepted, and validation says retrieval is not guaranteed', (model) => {
    const direct = validateConfig({ apiKey: 'k', quotaPolicy, model })
    expect(direct.ok).toBe(true)
    expect(direct.model).toBe(model)
    expect(direct.message).toBe(
      `config valid (${model} rejects forced tool_choice, so tracked queries run under ` +
        'native-auto-v1: web_search is offered but retrieval is not guaranteed)',
    )

    const viaAdapter = claudeAdapter.validateConfig(adapterConfigFor(model))
    expect(viaAdapter).toEqual({ ok: true, provider: 'claude', message: direct.message, model })
    expect(claudeAdapter.modelRegistry?.validationPattern.test(model)).toBe(true)
  })

  test.each(ACCEPTS_FORCING)('%s is accepted with no caveat', (model) => {
    const viaAdapter = claudeAdapter.validateConfig(adapterConfigFor(model))
    expect(viaAdapter).toEqual({ ok: true, provider: 'claude', message: 'config valid', model })
  })
})

describe('the request each model is sent', () => {
  test.each(REJECTS_FORCING)('%s is sent tool_choice auto, with the search tool still offered', async (model) => {
    const sent = captureRequest(SEARCHED)
    await claudeAdapter.executeTrackedQuery(QUERY, adapterConfigFor(model))

    expect(sent().model).toBe(model)
    expect(sent().tool_choice).toEqual(AUTO)
    expect(sent().tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    // Dropping the forced call must not smuggle in a system prompt to coax the
    // search: native-auto-v1 is the unmodified query, provider left to decide.
    expect(sent().system).toBeUndefined()
    expect(sent().messages).toEqual([{ role: 'user', content: 'commercial roof restoration' }])
  })

  test.each(ACCEPTS_FORCING)('%s is still forced to search', async (model) => {
    const sent = captureRequest(SEARCHED)
    await claudeAdapter.executeTrackedQuery(QUERY, adapterConfigFor(model))

    expect(sent().model).toBe(model)
    expect(sent().tool_choice).toEqual(FORCED)
    expect(sent().tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    expect(sent().system).toBeUndefined()
    expect(sent().messages).toEqual([{ role: 'user', content: 'commercial roof restoration' }])
  })

  test('the unconfigured default model is still forced to search', async () => {
    const sent = captureRequest(SEARCHED)
    const raw = await executeTrackedQuery(inputFor(undefined))
    expect(sent().model).toBe('claude-sonnet-4-6')
    expect(sent().tool_choice).toEqual(FORCED)
    expect(raw.retrievalContract).toBe('search-required-v1')
  })

  test('the contract follows the model actually sent, not a rejected config string', async () => {
    // A non-claude name falls back to the default model, which accepts forcing.
    const sent = captureRequest(SEARCHED)
    const raw = await executeTrackedQuery(inputFor('gpt-5.4'))
    expect(sent().model).toBe('claude-sonnet-4-6')
    expect(sent().tool_choice).toEqual(FORCED)
    expect(raw.retrievalContract).toBe('search-required-v1')
  })
})

describe('the contract each snapshot records', () => {
  test.each(REJECTS_FORCING)('%s records native-auto-v1 on both sides of the adapter boundary', async (model) => {
    captureRequest(SEARCHED)
    const raw = await executeTrackedQuery(inputFor(model))
    expect(raw.retrievalContract).toBe('native-auto-v1')
    expect(raw.model).toBe(model)

    captureRequest(SEARCHED)
    const viaAdapter = await claudeAdapter.executeTrackedQuery(QUERY, adapterConfigFor(model))
    expect(viaAdapter.retrievalContract).toBe('native-auto-v1')
  })

  test.each(ACCEPTS_FORCING)('%s records search-required-v1 on both sides of the adapter boundary', async (model) => {
    captureRequest(SEARCHED)
    const raw = await executeTrackedQuery(inputFor(model))
    expect(raw.retrievalContract).toBe('search-required-v1')

    captureRequest(SEARCHED)
    const viaAdapter = await claudeAdapter.executeTrackedQuery(QUERY, adapterConfigFor(model))
    expect(viaAdapter.retrievalContract).toBe('search-required-v1')
  })

  test('the recorded contract always names the tool_choice that was actually sent', async () => {
    const expected: Record<string, unknown> = {
      [RetrievalContracts['search-required-v1']]: FORCED,
      [RetrievalContracts['native-auto-v1']]: AUTO,
    }
    for (const model of [...REJECTS_FORCING, ...ACCEPTS_FORCING]) {
      const sent = captureRequest(SEARCHED)
      const raw = await executeTrackedQuery(inputFor(model))
      expect({ model, toolChoice: sent().tool_choice }).toEqual({ model, toolChoice: expected[raw.retrievalContract] })
      vi.unstubAllGlobals()
    }
  })
})

describe('retrieval detection under native-auto-v1', () => {
  // Without the forced call Claude may answer from memory. That answer stores
  // zero cited domains and zero mentions, exactly like a searched answer that
  // cited nothing, so `retrievalStatus` must keep separating the two.
  test.each(REJECTS_FORCING)('%s: an unsearched answer is marked not-used', async (model) => {
    captureRequest(UNSEARCHED)
    const viaAdapter = await claudeAdapter.executeTrackedQuery(QUERY, adapterConfigFor(model))
    expect(viaAdapter.retrievalContract).toBe('native-auto-v1')
    expect(viaAdapter.retrievalStatus).toBe('not-used')
    const normalized = claudeAdapter.normalizeResult(viaAdapter)
    expect(normalized.retrievalStatus).toBe('not-used')
    expect(normalized.citedDomains).toEqual([])
  })

  test.each(REJECTS_FORCING)('%s: a searched answer is marked used and keeps its citations', async (model) => {
    captureRequest(SEARCHED)
    const raw = await executeTrackedQuery(inputFor(model))
    expect(raw.retrievalStatus).toBe('used')
    const normalized = normalizeResult(raw)
    expect(normalized.retrievalStatus).toBe('used')
    expect(normalized.citedDomains).toEqual(['roofingcontractor.example'])
    expect(normalized.searchQueries).toEqual(['commercial roof restoration'])
  })
})
