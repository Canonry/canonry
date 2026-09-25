import { describe, expect, it } from 'vitest'
import {
  batchDispatchRefusalMessage,
  describeBatchIneligibility,
  ProviderBatchIneligibilityReasons,
  resolveRunDispatchModes,
  summarizeRunUsage,
  type RunDispatchInput,
} from '../src/run-dispatch.js'
import { projectDtoSchema, projectUpsertRequestSchema } from '../src/project.js'
import { configSpecSchema } from '../src/config-schema.js'
import { runDetailDtoSchema, runDtoSchema, runTriggerRequestSchema } from '../src/run.js'
import type { SnapshotUsage } from '../src/provider-batch.js'

const SLOTS = [
  { provider: 'claude', requestedModel: 'claude-sonnet-4-6' },
  { provider: 'claude', requestedModel: 'claude-sonnet-4-6' },
  { provider: 'openai', requestedModel: 'gpt-5.4' },
  { provider: 'gemini', requestedModel: 'gemini-2.5-flash' },
]

/** A scheduled full plan sweep on an instance that can batch claude and openai. */
function input(overrides: Partial<RunDispatchInput> = {}): RunDispatchInput {
  return {
    trigger: 'scheduled',
    requestedMode: null,
    projectModes: { claude: 'batch' },
    providers: ['claude', 'gemini', 'openai'],
    expectedSlots: SLOTS,
    scoped: false,
    batchEligibleProviders: ['claude', 'openai'],
    ...overrides,
  }
}

describe('resolveRunDispatchModes', () => {
  it('batches the providers a scheduled sweep\'s project marks batch, and only those', () => {
    expect(resolveRunDispatchModes(input())).toEqual({ modes: { claude: 'batch' }, ineligible: {}, requested: ['claude'] })
  })

  it('ignores a project preference for a provider the run does not measure', () => {
    expect(resolveRunDispatchModes(input({ projectModes: { perplexity: 'batch', claude: 'sync' } })))
      .toEqual({ modes: {}, ineligible: {}, requested: [] })
  })

  it('keeps manual and API runs sync unless the request asks for batch', () => {
    for (const trigger of ['manual', 'config-apply', 'backfill']) {
      expect(resolveRunDispatchModes(input({ trigger })), trigger).toEqual({ modes: {}, ineligible: {}, requested: [] })
    }
  })

  it('an explicit batch request batches every eligible provider in the run, whatever the project prefers', () => {
    expect(resolveRunDispatchModes(input({ trigger: 'manual', requestedMode: 'batch', projectModes: {} }))).toEqual({
      modes: { claude: 'batch', openai: 'batch' },
      ineligible: { gemini: ProviderBatchIneligibilityReasons.batch_unavailable },
      requested: ['claude', 'gemini', 'openai'],
    })
  })

  it('an explicit sync request wins over a scheduled project preference', () => {
    expect(resolveRunDispatchModes(input({ requestedMode: 'sync' }))).toEqual({ modes: {}, ineligible: {}, requested: [] })
  })

  it('refuses every provider of a planless run', () => {
    expect(resolveRunDispatchModes(input({ expectedSlots: null, projectModes: { claude: 'batch', openai: 'batch' } }))).toEqual({
      modes: {},
      ineligible: { claude: 'not_plan_run', openai: 'not_plan_run' },
      requested: ['claude', 'openai'],
    })
  })

  it('refuses a run that measures a slice', () => {
    expect(resolveRunDispatchModes(input({ scoped: true, trigger: 'probe', requestedMode: 'batch' })).ineligible)
      .toEqual({ claude: 'scoped_run', gemini: 'scoped_run', openai: 'scoped_run' })
  })

  it('refuses a probe run', () => {
    expect(resolveRunDispatchModes(input({ trigger: 'probe', requestedMode: 'batch' })).ineligible)
      .toEqual({ claude: 'probe_run', gemini: 'probe_run', openai: 'probe_run' })
  })

  it('refuses a provider the instance cannot batch', () => {
    expect(resolveRunDispatchModes(input({ batchEligibleProviders: null }))).toEqual({
      modes: {},
      ineligible: { claude: 'batch_unavailable' },
      requested: ['claude'],
    })
    expect(resolveRunDispatchModes(input({ batchEligibleProviders: ['openai'] })).ineligible).toEqual({ claude: 'batch_unavailable' })
  })

  it('refuses a provider with even one slot whose model was not frozen', () => {
    const slots = [...SLOTS, { provider: 'claude' }]
    expect(resolveRunDispatchModes(input({ expectedSlots: slots, projectModes: { claude: 'batch', openai: 'batch' } }))).toEqual({
      modes: { openai: 'batch' },
      ineligible: { claude: 'model_not_frozen' },
      requested: ['claude', 'openai'],
    })
    expect(resolveRunDispatchModes(input({ expectedSlots: [...SLOTS, { provider: 'claude', requestedModel: '  ' }] })).ineligible)
      .toEqual({ claude: 'model_not_frozen' })
  })

  it('refuses a provider with no slot at all in the manifest', () => {
    expect(resolveRunDispatchModes(input({ expectedSlots: SLOTS.filter(slot => slot.provider !== 'claude') })).ineligible)
      .toEqual({ claude: 'model_not_frozen' })
  })

  it('reports the run-level reason before any provider-level one', () => {
    expect(resolveRunDispatchModes(input({ expectedSlots: null, batchEligibleProviders: [] })).ineligible).toEqual({ claude: 'not_plan_run' })
    expect(resolveRunDispatchModes(input({ scoped: true, trigger: 'probe', requestedMode: 'batch', expectedSlots: [{ provider: 'claude' }], batchEligibleProviders: [] })).ineligible)
      .toEqual({ claude: 'scoped_run', gemini: 'scoped_run', openai: 'scoped_run' })
  })

  it('matches provider names case-insensitively', () => {
    expect(resolveRunDispatchModes(input({ projectModes: { Claude: 'batch' }, batchEligibleProviders: ['CLAUDE'] })).modes).toEqual({ claude: 'batch' })
  })
})

describe('batch ineligibility copy', () => {
  it('names every reason', () => {
    for (const reason of Object.values(ProviderBatchIneligibilityReasons)) {
      expect(describeBatchIneligibility('claude', reason), reason).toMatch(/\S/)
    }
    expect(describeBatchIneligibility('claude', 'batch_unavailable')).toContain('providers.claude.batch.enabled')
  })

  it('names each provider and its reason in the refusal', () => {
    const message = batchDispatchRefusalMessage({ claude: 'model_not_frozen', gemini: 'batch_unavailable' })
    expect(message).toMatch(/^No provider in this run can use batch dispatch\./)
    expect(message).toContain('claude: ')
    expect(message).toContain('gemini: ')
    expect(message.indexOf('claude: ')).toBeLessThan(message.indexOf('gemini: '))
  })
})

function usage(overrides: Partial<SnapshotUsage> = {}): SnapshotUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    searchCount: 0,
    pricingTier: 'standard',
    estimatedCostMicros: 0,
    priceSource: 'default',
    ...overrides,
  }
}

describe('summarizeRunUsage', () => {
  it('sums each provider and tier exactly, excluding rows with no usage', () => {
    const rows = [
      { provider: 'claude', usage: usage({ inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 50, outputTokens: 300, searchCount: 2, pricingTier: 'batch', estimatedCostMicros: 21_000 }) },
      { provider: 'claude', usage: usage({ inputTokens: 1500, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 450, searchCount: 3, pricingTier: 'batch', estimatedCostMicros: 32_125 }) },
      // A fill answer for the same provider, at the sync price: its own row.
      { provider: 'claude', usage: usage({ inputTokens: 900, outputTokens: 100, searchCount: 1, pricingTier: 'standard', estimatedCostMicros: 14_200 }) },
      // Predates usage capture: counted nowhere.
      { provider: 'claude', usage: null },
      { provider: 'openai', usage: usage({ inputTokens: 800, outputTokens: 120, searchCount: 1, estimatedCostMicros: 12_000 }) },
      // An unpriced model: its tokens count, its cost does not.
      { provider: 'openai', usage: usage({ inputTokens: 700, outputTokens: 80, searchCount: 0, estimatedCostMicros: null, priceSource: null }) },
    ]

    expect(summarizeRunUsage(rows)).toEqual([
      {
        provider: 'claude', pricingTier: 'standard', answers: 1,
        inputTokens: 900, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, searchCount: 1,
        estimatedCostMicros: 14_200, unpricedAnswers: 0,
      },
      {
        provider: 'claude', pricingTier: 'batch', answers: 2,
        inputTokens: 2500, cachedInputTokens: 200, cacheWriteTokens: 50, outputTokens: 750, searchCount: 5,
        estimatedCostMicros: 53_125, unpricedAnswers: 0,
      },
      {
        provider: 'openai', pricingTier: 'standard', answers: 2,
        inputTokens: 1500, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200, searchCount: 1,
        estimatedCostMicros: 12_000, unpricedAnswers: 1,
      },
    ])
  })

  it('reports a group with no priced answer as unknown cost, never as free', () => {
    expect(summarizeRunUsage([
      { provider: 'local', usage: usage({ inputTokens: 10, outputTokens: 5, estimatedCostMicros: null, priceSource: null }) },
      { provider: 'local', usage: usage({ inputTokens: 20, outputTokens: 7, estimatedCostMicros: null, priceSource: null }) },
    ])).toEqual([{
      provider: 'local', pricingTier: 'standard', answers: 2,
      inputTokens: 30, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 12, searchCount: 0,
      estimatedCostMicros: null, unpricedAnswers: 2,
    }])
  })

  it('keeps a priced zero as a real zero', () => {
    expect(summarizeRunUsage([{ provider: 'claude', usage: usage() }])[0]).toMatchObject({ answers: 1, estimatedCostMicros: 0, unpricedAnswers: 0 })
  })

  it('returns nothing when no row carries usage', () => {
    expect(summarizeRunUsage([])).toEqual([])
    expect(summarizeRunUsage([{ provider: 'claude', usage: null }, { provider: 'gemini', usage: null }])).toEqual([])
  })
})

describe('dispatch fields on the wire', () => {
  it('accepts dispatchMode on a run request and rejects anything but sync or batch', () => {
    expect(runTriggerRequestSchema.parse({ dispatchMode: 'batch' }).dispatchMode).toBe('batch')
    expect(runTriggerRequestSchema.parse({ dispatchMode: 'sync' }).dispatchMode).toBe('sync')
    expect(runTriggerRequestSchema.parse({}).dispatchMode).toBeUndefined()
    expect(runTriggerRequestSchema.safeParse({ dispatchMode: 'flex' }).success).toBe(false)
  })

  it('carries providerDispatchModes on the project request, DTO and config spec', () => {
    const request = { displayName: 'Acme', canonicalDomain: 'acme.com', country: 'US', language: 'en' }
    expect(projectUpsertRequestSchema.parse({ ...request, providerDispatchModes: { claude: 'batch' } }).providerDispatchModes).toEqual({ claude: 'batch' })
    expect(projectUpsertRequestSchema.parse(request).providerDispatchModes).toBeUndefined()
    expect(projectUpsertRequestSchema.safeParse({ ...request, providerDispatchModes: { claude: 'later' } }).success).toBe(false)

    expect(projectDtoSchema.parse({ id: 'p', name: 'acme', canonicalDomain: 'acme.com', country: 'US', language: 'en' }).providerDispatchModes).toEqual({})

    // Omitted means "this apply does not manage it", so there is no default here.
    expect(configSpecSchema.parse(request).providerDispatchModes).toBeUndefined()
    expect(configSpecSchema.parse({ ...request, providerDispatchModes: { claude: 'batch' } }).providerDispatchModes).toEqual({ claude: 'batch' })
  })

  it('carries frozen modes on a run and batches plus usage on its detail', () => {
    const run = { id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'running', createdAt: '2026-09-24T00:00:00.000Z' }
    expect(runDtoSchema.parse({ ...run, dispatchModes: { claude: 'batch' } }).dispatchModes).toEqual({ claude: 'batch' })
    expect(runDtoSchema.safeParse({ ...run, dispatchModes: { claude: 'sync' } }).success).toBe(false)

    const detail = runDetailDtoSchema.parse({
      ...run,
      providerBatches: [{
        id: 'b1', provider: 'claude', model: 'claude-sonnet-4-6', status: 'submitted', requestCount: 120,
        ingestedCount: 0, recordedCount: 0, submittedAt: '2026-09-24T00:00:05.000Z', endedAt: null,
        deadlineAt: '2026-09-25T00:00:05.000Z', error: null,
      }],
      usage: [],
    })
    expect(detail.providerBatches?.[0]?.status).toBe('submitted')
  })
})
