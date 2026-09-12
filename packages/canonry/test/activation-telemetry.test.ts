import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import type {
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, queries, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const ENV_KEYS = [
  'CANONRY_ANONYMOUS_ID',
  'CANONRY_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'CANONRY_CONFIG_DIR',
] as const

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>
let configDir: string
let activationCallbacks = 0

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CANONRY_ANONYMOUS_ID = crypto.randomUUID()
  // Point config at an EMPTY directory, not just scrub env. `isTelemetryEnabled`
  // has one more input than the env vars above: with no override it falls back
  // to the host's real ~/.canonry/config.yaml, and on an operator machine that
  // file says `telemetry: false`. The positive test below then fails without a
  // code defect, and the two negative tests pass without testing anything,
  // since nothing is ever emitted. An empty config dir is the documented
  // no-config state: telemetry defaults on, the anonymous ID comes from env.
  activationCallbacks = 0
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-activation-config-'))
  process.env.CANONRY_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(configDir, { recursive: true, force: true })
})

function buildAdapter(): ProviderAdapter {
  return {
    name: 'gemini',
    validateConfig(_config: ProviderConfig): ProviderHealthcheckResult {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async healthcheck(_config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      return { ok: true, provider: 'gemini', message: 'ok' }
    },
    async executeTrackedQuery(_input: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      return {
        provider: 'gemini',
        rawResponse: {},
        model: 'stub-model',
        groundingSources: [],
        searchQueries: [],
      }
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      return {
        provider: 'gemini',
        answerText: 'stub answer',
        citedDomains: [],
        groundingSources: [],
        searchQueries: [],
      }
    },
    async generateText(_prompt: string, _config: ProviderConfig): Promise<string> {
      return 'stub'
    },
  }
}

function createFixture(queryCount: number) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-activation-telemetry-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'activation-project',
    displayName: 'Activation Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  for (let index = 0; index < queryCount; index++) {
    db.insert(queries).values({
      id: crypto.randomUUID(),
      projectId,
      query: `query-${index + 1}`,
      createdAt: now,
    }).run()
  }

  const registry = new ProviderRegistry()
  registry.register(buildAdapter(), {
    provider: 'gemini',
    apiKey: 'test',
    quotaPolicy: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 100,
    },
  })
  return {
    db,
    projectId,
    runner: new JobRunner(db, registry, {
      onFirstActivation: () => {
        activationCallbacks += 1
      },
    }),
  }
}

function queueRun(
  db: ReturnType<typeof createClient>,
  projectId: string,
  trigger: 'manual' | 'probe' = 'manual',
): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    trigger,
    status: 'queued',
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

async function captureTelemetry(run: () => Promise<void>) {
  const payloads: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) payloads.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ ok: true }))
  }
  try {
    await run()
    await new Promise(resolve => setTimeout(resolve, 30))
    return payloads
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('activation telemetry', () => {
  it('emits once for the first non-empty completed result', async () => {
    const { db, projectId, runner } = createFixture(1)

    const payloads = await captureTelemetry(async () => {
      await runner.executeRun(queueRun(db, projectId), projectId)
      await runner.executeRun(queueRun(db, projectId), projectId)
    })

    const activations = payloads.filter(payload => payload.event === 'activation.completed')
    expect(activations).toHaveLength(1)
    // The UX hook rides the same guard as the event: once, on the first
    // non-empty result, so the serve console can thank the operator.
    expect(activationCallbacks).toBe(1)
    expect(activations[0]?.properties).toEqual({
      flowVersion: 1,
      kind: 'answer_visibility',
      status: 'completed',
      providerCountBucket: '1',
      queryCountBucket: '1',
      snapshotCountBucket: '1',
    })
  })

  it('does not count an empty completed run as activation', async () => {
    const { db, projectId, runner } = createFixture(0)

    const payloads = await captureTelemetry(async () => {
      await runner.executeRun(queueRun(db, projectId), projectId)
    })

    expect(payloads.some(payload => payload.event === 'activation.completed')).toBe(false)
    expect(activationCallbacks).toBe(0)
  })

  it('does not count an operator probe as activation', async () => {
    const { db, projectId, runner } = createFixture(1)

    const payloads = await captureTelemetry(async () => {
      await runner.executeRun(queueRun(db, projectId, 'probe'), projectId)
    })

    expect(payloads.some(payload => payload.event === 'activation.completed')).toBe(false)
    expect(activationCallbacks).toBe(0)
  })
})
