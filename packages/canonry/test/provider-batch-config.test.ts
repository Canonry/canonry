import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderBatchCapability,
  ProviderConfig,
  RawQueryResult,
} from '@ainyc/canonry-contracts'
import { CliError } from '../src/cli-error.js'
import { loadConfig } from '../src/config.js'
import {
  adapterSupportsBatch,
  batchEligibleProviderNames,
  providerConfigFromEntry,
  providersWithUnsupportedBatch,
} from '../src/provider-batch-config.js'
import { ProviderRegistry } from '../src/provider-registry.js'

let tmpDir: string
let previousConfigDir: string | undefined

function writeConfig(providers: Record<string, unknown>) {
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), stringify({
    apiUrl: 'http://localhost:4100',
    database: path.join(tmpDir, 'canonry.db'),
    apiKey: 'cnry_test',
    providers,
  }))
}

function loadError(): CliError {
  try {
    loadConfig()
  } catch (error) {
    if (error instanceof CliError) return error
    throw error
  }
  throw new Error('expected loadConfig to throw')
}

const BATCH: ProviderBatchCapability = {
  maxRequestsPerBatch: 100_000,
  maxBytesPerBatch: 256 * 1024 * 1024,
  defaultDeadlineHours: 24,
  submit: async () => ({ providerBatchId: 'batch_1' }),
  poll: async () => ({ status: 'ended' }),
  results: async function* () { /* no lines */ },
  cancel: async () => {},
}

function adapter(name: string, capability: 'batch' | 'split-only' | 'none'): ProviderAdapter {
  const raw: RawQueryResult = { provider: name, rawResponse: {}, model: 'm', groundingSources: [], searchQueries: [], retrievalStatus: 'used', retrievalContract: 'search-required-v1' }
  const normalized: NormalizedQueryResult = { provider: name, answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'used' }
  return {
    name,
    displayName: name,
    mode: 'api',
    modelRegistry: { defaultModel: 'm', knownModels: [], validationPattern: /./, validationHint: '' },
    validateConfig: () => ({ ok: true, provider: name, message: 'ok' }),
    healthcheck: async () => ({ ok: true, provider: name, message: 'ok' }),
    executeTrackedQuery: async () => raw,
    normalizeResult: () => normalized,
    generateText: async () => '',
    ...(capability !== 'none'
      ? {
          buildTrackedQueryRequest: () => ({ endpoint: '/v1/messages', body: {} }),
          parseTrackedQueryResponse: () => raw,
        }
      : {}),
    ...(capability === 'batch' ? { batch: BATCH } : {}),
  } as unknown as ProviderAdapter
}

function config(name: string, batch?: ProviderConfig['batch']): ProviderConfig {
  return { provider: name, apiKey: 'k', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 }, ...(batch ? { batch } : {}) }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-batch-config-'))
  previousConfigDir = process.env.CANONRY_CONFIG_DIR
  process.env.CANONRY_CONFIG_DIR = tmpDir
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
  else process.env.CANONRY_CONFIG_DIR = previousConfigDir
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('config.yaml providers.<name>.batch and .pricing', () => {
  it('parses both blocks, defaulting batch.enabled to false', () => {
    writeConfig({
      claude: {
        apiKey: 'sk-ant',
        batch: { enabled: true, maxRequestsPerBatch: 5000, deadlineHours: 12 },
        pricing: { models: { 'claude-sonnet-4-6': { inputPerMTok: 2.5, outputPerMTok: 12 } } },
      },
      openai: { apiKey: 'sk-openai', batch: {} },
    })

    const loaded = loadConfig()

    expect(loaded.providers?.claude?.batch).toEqual({ enabled: true, maxRequestsPerBatch: 5000, deadlineHours: 12 })
    expect(loaded.providers?.claude?.pricing).toEqual({ models: { 'claude-sonnet-4-6': { inputPerMTok: 2.5, outputPerMTok: 12 } } })
    expect(loaded.providers?.openai?.batch).toEqual({ enabled: false })
    expect(loaded.providers?.openai?.pricing).toBeUndefined()
  })

  it('refuses a malformed batch block, naming the key', () => {
    writeConfig({ claude: { apiKey: 'sk-ant', batch: { enabled: 'yes' } } })
    const error = loadError()
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('providers.claude.batch')
  })

  it('refuses an unknown batch key rather than ignoring it', () => {
    writeConfig({ claude: { apiKey: 'sk-ant', batch: { enabled: true, deadline: 12 } } })
    expect(loadError().message).toContain('providers.claude.batch')
  })

  it('refuses a malformed price, naming the key', () => {
    writeConfig({ claude: { apiKey: 'sk-ant', pricing: { models: { 'claude-sonnet-4-6': { inputPerMTok: -1, outputPerMTok: 12 } } } } })
    const error = loadError()
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('providers.claude.pricing')
  })

  it('copies both blocks into the provider config the registry holds', () => {
    expect(providerConfigFromEntry('claude', {
      apiKey: 'sk-ant',
      model: 'claude-sonnet-4-6',
      batch: { enabled: true },
      pricing: { models: {} },
    }, { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 500 })).toEqual({
      provider: 'claude',
      apiKey: 'sk-ant',
      baseUrl: undefined,
      model: 'claude-sonnet-4-6',
      quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 500 },
      vertexProject: undefined,
      vertexRegion: undefined,
      vertexCredentials: undefined,
      batch: { enabled: true },
      pricing: { models: {} },
    })
  })
})

describe('which providers this host can batch', () => {
  it('needs the batch capability and the build/parse split', () => {
    expect(adapterSupportsBatch(adapter('claude', 'batch'))).toBe(true)
    expect(adapterSupportsBatch(adapter('openai', 'split-only'))).toBe(false)
    expect(adapterSupportsBatch(adapter('cdp', 'none'))).toBe(false)
  })

  it('lists only registered providers with the capability AND batch.enabled', () => {
    const registry = new ProviderRegistry()
    registry.register(adapter('claude', 'batch'), config('claude', { enabled: true }))
    registry.register(adapter('gemini', 'batch'), config('gemini', { enabled: false }))
    registry.register(adapter('local', 'batch'), config('local'))
    registry.register(adapter('openai', 'split-only'), config('openai', { enabled: true }))

    expect(batchEligibleProviderNames(registry)).toEqual(['claude'])
  })

  it('names each provider whose config enables batch its adapter cannot do', () => {
    const adapters = { claude: adapter('claude', 'batch'), openai: adapter('openai', 'split-only'), perplexity: adapter('perplexity', 'none') }
    expect(providersWithUnsupportedBatch({
      claude: { apiKey: 'k', batch: { enabled: true } },
      openai: { apiKey: 'k', batch: { enabled: true } },
      perplexity: { apiKey: 'k', batch: { enabled: false } },
      mistral: { apiKey: 'k', batch: { enabled: true } },
    }, name => adapters[name as keyof typeof adapters])).toEqual(['openai'])
  })
})
