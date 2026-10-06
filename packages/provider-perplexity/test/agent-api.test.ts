import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixture, stubAgentHttp as stubAgent } from './support/agent-api.js'
import { PROVIDER_MODEL_ALIASES } from '@ainyc/canonry-contracts'

import { perplexityAdapter } from '../src/adapter.js'
import {
  executeTrackedQuery,
  generateText,
  healthcheck,
  normalizeResult,
  reparseStoredResult,
} from '../src/normalize.js'

// Fixtures follow the Agent API schema in Perplexity's official SDK; they are
// not live captures. Provenance and how to replace them: test/fixtures/README.md.

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://wrong.example/v1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Agent API request', () => {

  it.each([
    ['sonar', 'fast'],
    ['sonar-pro', 'low'],
    ['sonar-reasoning-pro', 'low'],
    ['sonar-deep-research', 'medium'],
    ['pro-search', 'low'],
    ['low', 'low'],
  ])('runs a configured %s as the %s preset and records that preset as the model', async (configured, preset) => {
    const calls = stubAgent(200, fixture('agent-fast-cited'))
    const result = await executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy, model: configured },
    })
    expect(calls[0]!.body.preset).toBe(preset)
    expect(calls[0]!.body).not.toHaveProperty('model')
    expect(result.model).toBe(preset)
  })

  it('sends the token limit the API requires for anthropic slugs on every request path', async () => {
    const config = { apiKey: 'k', quotaPolicy, model: 'anthropic/claude-sonnet-4-6' }
    const calls = stubAgent(200, fixture('agent-no-search'))
    await executeTrackedQuery({ query: 'q', canonicalDomains: [], competitorDomains: [], config })
    await healthcheck(config)
    await generateText('Summarize.', config)

    expect(calls.map(call => call.body)).toEqual([
      {
        model: 'anthropic/claude-sonnet-4-6',
        max_output_tokens: 4096,
        input: 'q',
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
      },
      { model: 'anthropic/claude-sonnet-4-6', max_output_tokens: 4096, input: 'Say "ok"' },
      { model: 'anthropic/claude-sonnet-4-6', max_output_tokens: 4096, input: 'Summarize.' },
    ])
  })

})

describe('Agent API response parsing', () => {
  it('reads answer, sources, search queries, retrieval and served model from the output items', async () => {
    stubAgent(200, fixture('agent-fast-cited'))
    const raw = await perplexityAdapter.executeTrackedQuery(
      { query: 'best crm for startups', canonicalDomains: ['hubspot.com'], competitorDomains: [] },
      { provider: 'perplexity', apiKey: 'k', quotaPolicy },
    )

    // Four results, one duplicate URL: three sources, in output order.
    expect(raw.groundingSources).toEqual([
      { uri: 'https://www.hubspot.com/products/crm/startups', title: 'HubSpot for Startups' },
      { uri: 'https://blog.example.com/startup-crm-guide', title: 'The startup CRM guide' },
      { uri: 'https://pipedrive.com/en/blog/crm-for-startups', title: 'CRM for startups' },
    ])
    expect(raw.searchQueries).toEqual(['best crm for startups', 'startup crm comparison 2026'])
    expect(raw.model).toBe('fast')
    expect(raw.servedModel).toBe('perplexity/sonar')
    expect(raw.retrievalStatus).toBe('used')
    expect(raw.retrievalContract).toBe('search-required-v1')

    const normalized = perplexityAdapter.normalizeResult(raw)
    expect(normalized.answerText).toBe(
      "HubSpot's free tier is the usual starting point for startups [1][2]. Pipedrive suits pipeline-heavy sales teams [4].",
    )
    expect(normalized.citedDomains).toEqual(['hubspot.com', 'blog.example.com', 'pipedrive.com'])
    expect(normalized.groundingSources).toEqual(raw.groundingSources)
    expect(normalized.searchQueries).toEqual(raw.searchQueries)
    expect(normalized.retrievalStatus).toBe('used')
  })

  it('marks a search that returned nothing as used, with no sources', () => {
    const parsed = reparseStoredResult(fixture('agent-search-no-results'))
    expect(parsed.retrievalStatus).toBe('used')
    expect(parsed.groundingSources).toEqual([])
    expect(parsed.citedDomains).toEqual([])
    expect(parsed.searchQueries).toEqual(['canonry aeo platform zzzz'])
    expect(parsed.answerText).toBe('I could not find sources for that exact phrase.')
  })

  it('marks an answer with no retrieval item as not-used', () => {
    const parsed = reparseStoredResult(fixture('agent-no-search'))
    expect(parsed.retrievalStatus).toBe('not-used')
    expect(parsed.groundingSources).toEqual([])
    expect(parsed.citedDomains).toEqual([])
    expect(parsed.searchQueries).toEqual([])
    expect(parsed.answerText).toBe('ok')
  })

  it('says unknown when the output holds no answer to judge by', () => {
    expect(reparseStoredResult({ object: 'response', status: 'completed', output: [] }).retrievalStatus).toBe('unknown')
  })

  it('reads url_citation annotations and fetched pages as sources, deduplicated against search results', () => {
    const response = fixture('agent-fast-cited')
    const output = response.output as Record<string, unknown>[]
    const parsed = reparseStoredResult({
      ...response,
      output: [
        ...output.slice(0, 1),
        { type: 'fetch_url_results', contents: [{ url: 'https://docs.example.org/crm', title: 'CRM docs', snippet: '' }] },
        {
          ...output[1],
          content: [{
            type: 'output_text',
            text: 'Answer.',
            annotations: [
              { type: 'url_citation', url: 'https://pipedrive.com/en/blog/crm-for-startups', title: 'dup', start_index: 0, end_index: 3 },
              { type: 'url_citation', url: 'https://www.g2.com/categories/crm', start_index: 0, end_index: 3 },
            ],
          }],
        },
      ],
    })
    expect(parsed.groundingSources.map(source => source.uri)).toEqual([
      'https://www.hubspot.com/products/crm/startups',
      'https://blog.example.com/startup-crm-guide',
      'https://pipedrive.com/en/blog/crm-for-startups',
      'https://docs.example.org/crm',
      'https://www.g2.com/categories/crm',
    ])
    expect(parsed.groundingSources.at(-1)).toEqual({ uri: 'https://www.g2.com/categories/crm', title: '' })
    expect(parsed.citedDomains).toEqual(['hubspot.com', 'blog.example.com', 'pipedrive.com', 'docs.example.org', 'g2.com'])
    expect(parsed.retrievalStatus).toBe('used')
  })

  it("reparses a stored envelope the same as the direct response", () => {
    const response = fixture('agent-fast-cited')
    const stored = {
      model: 'fast',
      groundingSources: [{ uri: 'https://stale.example.com', title: '' }],
      searchQueries: ['stale'],
      apiResponse: response,
    }
    const expected = {
      provider: 'perplexity',
      answerText: "HubSpot's free tier is the usual starting point for startups [1][2]. Pipedrive suits pipeline-heavy sales teams [4].",
      citedDomains: ['hubspot.com', 'blog.example.com', 'pipedrive.com'],
      groundingSources: [
        { uri: 'https://www.hubspot.com/products/crm/startups', title: 'HubSpot for Startups' },
        { uri: 'https://blog.example.com/startup-crm-guide', title: 'The startup CRM guide' },
        { uri: 'https://pipedrive.com/en/blog/crm-for-startups', title: 'CRM for startups' },
      ],
      searchQueries: ['best crm for startups', 'startup crm comparison 2026'], retrievalStatus: 'used',
    }
    expect(reparseStoredResult(stored), 'stored Agent envelope').toEqual(expected)
    expect(reparseStoredResult(response), 'direct Agent body').toEqual(expected)
  })

  it('prefers the reparsed response over stale extracted fields, and falls back to them when it is empty', () => {
    const stale = {
      provider: 'perplexity' as const,
      model: 'fast',
      groundingSources: [{ uri: 'https://stale.example.com/x', title: '' }],
      searchQueries: ['stale'],
      retrievalStatus: 'not-used' as const,
    }
    const fresh = normalizeResult({ ...stale, rawResponse: fixture('agent-fast-cited') })
    expect(fresh.citedDomains).toEqual(['hubspot.com', 'blog.example.com', 'pipedrive.com'])
    expect(fresh.retrievalStatus).toBe('used')

    const empty = normalizeResult({ ...stale, rawResponse: { object: 'response', output: [] } })
    expect(empty.groundingSources).toEqual(stale.groundingSources)
    expect(empty.searchQueries).toEqual(['stale'])
    expect(empty.retrievalStatus).toBe('not-used')
  })
})

describe('Agent API errors', () => {
  it('throws on a failed run even though it arrives as HTTP 200', async () => {
    const calls = stubAgent(200, fixture('agent-failed'))
    await expect(executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy },
    })).rejects.toThrow('[provider-perplexity] agent response failed: The model failed to produce a response. (internal_error)')
    expect(calls).toHaveLength(1)
  })

  it('throws on a cancelled run without an error body', async () => {
    stubAgent(200, { object: 'response', status: 'cancelled', output: [] })
    await expect(executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy },
    })).rejects.toThrow('[provider-perplexity] agent response cancelled: no error detail')
  })

  it('throws on an incomplete run that stopped before any answer', async () => {
    const searchOnly = (fixture('agent-fast-cited').output as Record<string, unknown>[]).slice(0, 1)
    const calls = stubAgent(200, {
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: searchOnly,
    })
    await expect(executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy },
    })).rejects.toThrow('[provider-perplexity] agent response incomplete with no answer: max_output_tokens')
    expect(calls).toHaveLength(1)
  })

  it('keeps an incomplete run that still carries an answer', async () => {
    stubAgent(200, { ...fixture('agent-fast-cited'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    const raw = await executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy },
    })
    expect(normalizeResult(raw).answerText).toBe(
      "HubSpot's free tier is the usual starting point for startups [1][2]. Pipedrive suits pipeline-heavy sales teams [4].",
    )
  })

  it('reports an incomplete key check with no answer as failed, with its reason', async () => {
    stubAgent(200, { object: 'response', status: 'incomplete', output: [] })
    expect(await healthcheck({ apiKey: 'k', quotaPolicy })).toEqual({
      ok: false,
      provider: 'perplexity',
      message: 'agent response incomplete with no answer: no reason given',
      model: 'fast',
    })
  })

  it('surfaces a 400 without retrying it', async () => {
    const calls = stubAgent(400, fixture('agent-error-400'))
    await expect(executeTrackedQuery({
      query: 'q',
      canonicalDomains: [],
      competitorDomains: [],
      config: { apiKey: 'k', quotaPolicy },
    })).rejects.toThrow(/^\[provider-perplexity\] 400 .*unknown field \\?"search_mode\\?"/)
    expect(calls).toHaveLength(1)
  })
})

describe('key check and text generation', () => {
  it('checks the key with the configured engine and no forced search', async () => {
    const calls = stubAgent(200, fixture('agent-no-search'))
    const result = await healthcheck({ apiKey: 'k', quotaPolicy, model: 'sonar' })
    expect(calls[0]!.url).toBe('https://api.perplexity.ai/v1/agent')
    expect(calls[0]!.body).toEqual({ preset: 'fast', input: 'Say "ok"' })
    expect(result).toEqual({ ok: true, provider: 'perplexity', message: 'perplexity api key verified', model: 'fast' })
  })

  it('reports a failed key check with the run error', async () => {
    stubAgent(200, fixture('agent-failed'))
    const result = await healthcheck({ apiKey: 'k', quotaPolicy })
    expect(result).toEqual({
      ok: false,
      provider: 'perplexity',
      message: 'agent response failed: The model failed to produce a response. (internal_error)',
      model: 'fast',
    })
  })

  it('reports an empty answer as a failed key check', async () => {
    stubAgent(200, { object: 'response', status: 'completed', output: [] })
    const result = await healthcheck({ apiKey: 'k', quotaPolicy })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('empty response from perplexity')
  })

  it('generates text through the same endpoint', async () => {
    const calls = stubAgent(200, fixture('agent-no-search'))
    await expect(generateText('Summarize.', { apiKey: 'k', quotaPolicy, model: 'perplexity/sonar' })).resolves.toBe('ok')
    expect(calls[0]!.body).toEqual({ model: 'perplexity/sonar', input: 'Summarize.' })
  })
})

describe('model registry', () => {
  const { validationPattern, defaultModel } = perplexityAdapter.modelRegistry

  it('defaults to the fast preset', () => {
    expect(defaultModel).toBe('fast')
    expect(perplexityAdapter.validateConfig({ provider: 'perplexity', apiKey: 'k', quotaPolicy }).model).toBe('fast')
  })

  it('accepts every retired id the alias table resolves, so an existing config keeps validating', () => {
    for (const retired of Object.keys(PROVIDER_MODEL_ALIASES.perplexity!)) {
      expect(validationPattern.test(retired), retired).toBe(true)
    }
  })

  it('accepts presets and provider/model slugs', () => {
    for (const model of ['fast', 'low', 'medium', 'high', 'xhigh', 'perplexity/sonar', 'openai/gpt-5.1', 'anthropic/claude-sonnet-4-5']) {
      expect(validationPattern.test(model), model).toBe(true)
    }
  })

  it('rejects ids the Agent API would not accept as a preset or model', () => {
    for (const model of ['', 'gpt-4o', 'Sonar', 'sonar-foo', 'FAST', 'perplexity/', '/sonar', 'fast preset']) {
      expect(validationPattern.test(model), model).toBe(false)
    }
  })

  it('lists its default among the known models', () => {
    expect(perplexityAdapter.modelRegistry.knownModels.map(model => model.id)).toContain(defaultModel)
  })
})
