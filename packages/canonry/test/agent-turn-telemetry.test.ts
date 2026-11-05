import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, type DatabaseClient } from '@canonry/canonry-db'
import { AppError } from '@canonry/canonry-contracts'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, createProvider, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { aeroModels } from '../src/agent/pi-models.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

// Every finished Aero turn is one `feature.completed` (`aero` / `turn`): how
// it ended, who started it, the model, and the model calls, tool calls,
// tokens and cost the turn's own responses reported.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

const turnEvents = () => telemetry.trackEvent.mock.calls.filter(([event]) => event === 'feature.completed')

/** USD per million tokens, so a turn on this model has a known price. */
const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

function usage(input: number, output: number, cacheRead: number, costUsd: number): AssistantMessage['usage'] {
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } }
}

function toolCall(id: string, name: string) {
  return { type: 'toolCall' as const, id, name, arguments: {} }
}

/** A scripted answer, or one that waits on the request (its abort signal) before answering. */
type ScriptedResponse = Partial<AssistantMessage> | ((options: { signal?: AbortSignal; apiKey?: string } | undefined) => Promise<Partial<AssistantMessage>>)

/**
 * A provider that answers with scripted messages exactly as written, usage
 * included, standing in for Anthropic in the collection Aero streams through.
 */
function scriptAnthropic(): { model: Model<Api>; responses: ScriptedResponse[]; restore: () => void } {
  const original = aeroModels.getProvider('anthropic')
  const model = {
    id: 'claude-sonnet-4-6', name: 'Scripted Sonnet', api: 'aero-turn-telemetry-test', provider: 'anthropic', baseUrl: 'http://localhost:0',
    reasoning: false, input: ['text'], cost: PRICE, contextWindow: 200_000, maxTokens: 16_384,
  } as unknown as Model<Api>
  const responses: ScriptedResponse[] = []
  const stream = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal; apiKey?: string }) => {
    const events = createAssistantMessageEventStream()
    const step = responses.shift()
    queueMicrotask(async () => {
      const message = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: usage(0, 0, 0, 0), stopReason: 'stop', timestamp: Date.now(),
        ...(typeof step === 'function' ? await step(options) : step),
      } as AssistantMessage
      events.push(message.stopReason === 'error' || message.stopReason === 'aborted'
        ? { type: 'error', reason: message.stopReason, error: message }
        : { type: 'done', reason: message.stopReason as 'stop', message })
      events.end(message)
    })
    return events
  }
  aeroModels.setProvider(createProvider({
    id: 'anthropic',
    auth: { apiKey: { name: 'Scripted', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  } as never))
  return { model, responses, restore: () => (original ? aeroModels.setProvider(original) : aeroModels.deleteProvider('anthropic')) }
}

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let registry: SessionRegistry
let scripted: ReturnType<typeof scriptAnthropic>
let config: CanonryConfig

beforeEach(async () => {
  telemetry.trackEvent.mockReset()
  // A frozen clock: every turn here takes no time.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'))
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-turn-telemetry-'))
  db = createClient(path.join(directory, 'data.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  config = { apiKey: 'test', providers: { claude: { apiKey: 'test' } } } as CanonryConfig
  registry = new SessionRegistry({ db, client: {} as ApiClient, config })
  // Built against the real catalog first; the scripted provider then answers its turns.
  const agent = registry.getOrCreate('demo')
  scripted = scriptAnthropic()
  agent.state.model = scripted.model
  app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.status(500).send(error)
  })
  registerAgentRoutes(app, { db, sessionRegistry: registry })
  await app.ready()
})

afterEach(async () => {
  await app?.close()
  scripted.restore()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

const CLI = { 'user-agent': 'canonry-cli/7.21.0', 'x-canonry-surface': 'cli', 'x-canonry-agent': 'codex' }
const DASHBOARD = { 'user-agent': 'Mozilla/5.0 (Macintosh)' }

async function ask(payload: Record<string, unknown>, headers: Record<string, string>, project = 'demo'): Promise<void> {
  const response = await app.inject({ method: 'POST', url: `/projects/${project}/agent/prompt`, payload, headers })
  expect(response.statusCode).toBe(200)
}

describe('Aero turn outcome', () => {
  it('reports a completed turn with its calls, tokens and cost, attributed to the caller', async () => {
    scripted.responses.push(
      // Two tool calls, one to a tool that does not exist.
      { content: [toolCall('call-1', 'aero_list_toolkits'), toolCall('call-2', 'zzz_unknown_tool')], stopReason: 'toolUse', usage: usage(1_200, 80, 300, 0.0045), responseId: 'resp-1' },
      { content: [{ type: 'text', text: 'Everything is on track.' }], stopReason: 'stop', usage: usage(1_500, 220, 900, 0.0081), responseId: 'resp-2' },
    )

    await ask({ prompt: 'How are we doing?' }, CLI)

    expect(turnEvents()).toEqual([['feature.completed', {
      feature: 'aero',
      operation: 'turn',
      status: 'succeeded',
      trigger: 'manual',
      surface: 'cli',
      agent: 'codex',
      durationBucket: 'under_1s',
      counts: { modelCalls: 2, toolCalls: 2, toolErrors: 1, inputTokens: 2_700, outputTokens: 300, cachedTokens: 1_200, costMicros: 12_600 },
      model: 'claude-sonnet-4-6',
      modelProvider: 'claude',
    }, undefined]])
  })

  it('reports a provider failure by its reason, never its text', async () => {
    scripted.responses.push({
      content: [], stopReason: 'error', responseId: 'resp-err',
      errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    })

    await ask({ prompt: 'How are we doing?' }, DASHBOARD)

    expect(turnEvents()).toEqual([['feature.completed', {
      feature: 'aero',
      operation: 'turn',
      status: 'failed',
      reasonCode: 'INVALID_CREDENTIALS',
      trigger: 'manual',
      surface: 'dashboard',
      durationBucket: 'under_1s',
      counts: { modelCalls: 1, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0 },
      model: 'claude-sonnet-4-6',
      modelProvider: 'claude',
    }, { errorCode: 'INVALID_CREDENTIALS' }]])
  })

  it('reports a turn its tool limit cut short as partial, without counting the blocked call', async () => {
    scripted.responses.push(
      { content: [toolCall('call-1', 'aero_list_toolkits')], stopReason: 'toolUse', usage: usage(1_000, 50, 0, 0.003), responseId: 'resp-1' },
      { content: [toolCall('call-2', 'aero_list_toolkits')], stopReason: 'toolUse', usage: usage(1_100, 60, 0, 0.004), responseId: 'resp-2' },
      { content: [{ type: 'text', text: 'Here is what I found so far.' }], stopReason: 'stop', usage: usage(1_200, 90, 0, 0.005), responseId: 'resp-3' },
    )

    await ask({ prompt: 'Audit everything', limits: { maxToolCalls: 1, timeoutMs: 10_000 } }, DASHBOARD)

    const [[, props, options]] = turnEvents()
    expect(props).toMatchObject({
      status: 'partial',
      reasonCode: 'QUOTA_EXCEEDED',
      trigger: 'manual',
      counts: { modelCalls: 3, toolCalls: 1, toolErrors: 0, inputTokens: 3_300, outputTokens: 200, cachedTokens: 0, costMicros: 12_000 },
    })
    expect(options).toEqual({ errorCode: 'QUOTA_EXCEEDED' })
  })

  it('reports a turn its time limit cut short as partial', async () => {
    scripted.responses.push(
      // Still researching when the turn's research budget runs out.
      options => new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({
        content: [], stopReason: 'aborted', errorMessage: 'Request was aborted', usage: usage(800, 0, 0, 0.0024), responseId: 'resp-1',
      }))),
      { content: [{ type: 'text', text: 'Here is what I found in time.' }], stopReason: 'stop', usage: usage(900, 120, 0, 0.0045), responseId: 'resp-2' },
    )

    await ask({ prompt: 'Audit everything', limits: { maxToolCalls: 5, timeoutMs: 1_000 } }, DASHBOARD)

    const [[, props, options]] = turnEvents()
    expect(props).toMatchObject({
      status: 'partial',
      reasonCode: 'TIMEOUT',
      counts: { modelCalls: 2, toolCalls: 0, toolErrors: 0, inputTokens: 1_700, outputTokens: 120, cachedTokens: 0, costMicros: 6_900 },
    })
    expect(options).toEqual({ errorCode: 'TIMEOUT' })
  })

  it('reports a turn Aero started itself as the system acting, triggered by the agent', async () => {
    // A provider that reports fractional token counts still yields whole counts.
    scripted.responses.push({ content: [{ type: 'text', text: 'The sweep looks steady.' }], stopReason: 'stop', usage: usage(900.4, 39.6, 0, 0.0033), responseId: 'resp-1' })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] run.completed for demo', timestamp: Date.now() } as AgentMessage)

    await registry.drainNow('demo')

    expect(turnEvents()).toEqual([['feature.completed', {
      feature: 'aero',
      operation: 'turn',
      status: 'succeeded',
      trigger: 'agent',
      surface: 'system',
      durationBucket: 'under_1s',
      counts: { modelCalls: 1, toolCalls: 0, toolErrors: 0, inputTokens: 900, outputTokens: 40, cachedTokens: 0, costMicros: 3_300 },
      model: 'claude-sonnet-4-6',
      modelProvider: 'claude',
    }, undefined]])
  })

  it.each([
    ['401 invalid x-api-key', 'INVALID_CREDENTIALS'],
    ['402 insufficient credits', 'BILLING'],
  ])('pauses automatic turns across projects after %s without accumulating wake notifications', async (errorMessage, reasonCode) => {
    scripted.responses.push({ stopReason: 'error', errorMessage })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] first run', timestamp: Date.now() })
    await registry.drainNow('demo')

    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    registry.getOrCreate('other', { provider: 'claude', modelId: scripted.model.id })
    for (const project of ['demo', 'other', 'demo']) {
      registry.queueFollowUp(project, { role: 'user', content: '[system] another run', timestamp: Date.now() })
      await registry.drainNow(project)
    }

    expect(turnEvents()).toHaveLength(1)
    expect(turnEvents()[0]![1]).toMatchObject({ status: 'failed', reasonCode, counts: { modelCalls: 1 } })
    expect(registry.peekPending('demo')).toHaveLength(0)
    expect(registry.peekPending('other')).toHaveLength(0)
  })

  it('holds a follow-up queued during the failing turn and resumes after a successful manual retry', async () => {
    scripted.responses.push(async () => {
      registry.queueFollowUp('demo', { role: 'user', content: '[system] mid-turn run', timestamp: Date.now() })
      return { stopReason: 'error', errorMessage: '401 invalid x-api-key' }
    })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] first run', timestamp: Date.now() })
    await registry.drainNow('demo')
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(1)
    expect(registry.peekPending('demo')).toHaveLength(1)

    await ask({ prompt: 'I fixed the key. Retry.' }, DASHBOARD)
    expect(registry.peekPending('demo')).toHaveLength(0)
    registry.queueFollowUp('demo', { role: 'user', content: '[system] recovered run', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents().map(([, props]) => [props.trigger, props.status])).toEqual([
      ['agent', 'failed'], ['manual', 'succeeded'], ['agent', 'succeeded'],
    ])
  })

  it('also pauses background work after an interactive account failure', async () => {
    scripted.responses.push({ stopReason: 'error', errorMessage: '402 insufficient credits' })
    await ask({ prompt: 'Check the report' }, CLI)
    registry.queueFollowUp('demo', { role: 'user', content: '[system] run', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(1)
    expect(turnEvents()[0]![1]).toMatchObject({ trigger: 'manual', status: 'failed', reasonCode: 'BILLING' })
  })

  it('scopes a failure to the credential used at turn start, even if it is replaced in flight', async () => {
    scripted.responses.push(async () => {
      config.providers!.claude!.apiKey = 'replacement'
      return { stopReason: 'error', errorMessage: '401 invalid x-api-key' }
    })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] old key', timestamp: Date.now() })
    await registry.drainNow('demo')
    registry.queueFollowUp('demo', { role: 'user', content: '[system] new key', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents().map(([, props]) => props.status)).toEqual(['failed', 'succeeded'])

    // A successful replacement must not unpause the still-invalid old key.
    config.providers!.claude!.apiKey = 'test'
    registry.queueFollowUp('demo', { role: 'user', content: '[system] restored old key', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(2)
  })

  it('permits an automatic recovery attempt after a day', async () => {
    scripted.responses.push({ stopReason: 'error', errorMessage: '402 insufficient credits' })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] first run', timestamp: Date.now() })
    await registry.drainNow('demo')
    vi.setSystemTime(new Date('2026-10-10T11:59:59Z'))
    registry.queueFollowUp('demo', { role: 'user', content: '[system] held run', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(1)

    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    registry.queueFollowUp('demo', { role: 'user', content: '[system] next day', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents().map(([, props]) => props.status)).toEqual(['failed', 'succeeded'])
  })

  it('does not put transient provider failures on an account hold', async () => {
    scripted.responses.push({ stopReason: 'error', errorMessage: '503 service unavailable' })
    for (let run = 0; run < 2; run++) {
      registry.queueFollowUp('demo', { role: 'user', content: `[system] run ${run}`, timestamp: Date.now() })
      await registry.drainNow('demo')
    }
    expect(turnEvents().map(([, props]) => props.status)).toEqual(['failed', 'succeeded'])
  })

  it.each([false, true])('keeps a newer account hold after an older success (already paused: %s)', async (alreadyPaused) => {
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    registry.getOrCreate('other', { provider: 'claude', modelId: scripted.model.id })
    if (alreadyPaused) {
      scripted.responses.push({ stopReason: 'error', errorMessage: '401 invalid x-api-key' })
      await ask({ prompt: 'First failure' }, CLI)
    }
    const priorTurns = turnEvents().length
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const responsePromise = new Promise<void>(resolve => { release = resolve })
    scripted.responses.push(async () => { started(); await responsePromise; return {} })
    if (!alreadyPaused) registry.queueFollowUp('demo', { role: 'user', content: '[system] earlier turn', timestamp: Date.now() })
    const earlier = alreadyPaused ? ask({ prompt: 'Retry after repair' }, CLI) : registry.drainNow('demo')
    await startedPromise
    // The clock stays fixed: repeated failures may have identical expiries.
    scripted.responses.push({ stopReason: 'error', errorMessage: '401 invalid x-api-key' })
    await ask({ prompt: 'Later failure' }, CLI, 'other')
    expect(turnEvents()).toHaveLength(priorTurns + 1)
    expect(turnEvents().at(-1)![1]).toMatchObject({ status: 'failed' })
    release()
    await earlier
    registry.queueFollowUp('other', { role: 'user', content: '[system] must stay paused', timestamp: Date.now() })
    await registry.drainNow('other')
    expect(turnEvents()).toHaveLength(priorTurns + 2)
    // A new request after the latest failure is still allowed to prove recovery.
    await ask({ prompt: 'Credentials repaired' }, CLI)
    registry.queueFollowUp('other', { role: 'user', content: '[system] recovered', timestamp: Date.now() })
    await registry.drainNow('other')
    expect(turnEvents()).toHaveLength(priorTurns + 4)
  })

  it('holds the credential that failed after rotation between model calls', async () => {
    scripted.responses.push(async () => {
      config.providers!.claude!.apiKey = 'rotated-invalid-key'
      return { content: [toolCall('read-docs', 'list_skill_docs')], stopReason: 'toolUse' }
    })
    scripted.responses.push(options => {
      expect(options?.apiKey).toBe('rotated-invalid-key')
      return Promise.resolve({ stopReason: 'error', errorMessage: '401 invalid x-api-key' })
    })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] key rotates in turn', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(1)
    expect(turnEvents()[0]![1]).toMatchObject({ status: 'failed', counts: { modelCalls: 2 } })
    registry.queueFollowUp('demo', { role: 'user', content: '[system] same rejected rotated key', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(1)
    config.providers!.claude!.apiKey = 'test'
    registry.queueFollowUp('demo', { role: 'user', content: '[system] original key still works', timestamp: Date.now() })
    await registry.drainNow('demo')
    expect(turnEvents()).toHaveLength(2)
    expect(turnEvents().at(-1)![1]).toMatchObject({ status: 'succeeded' })
  })
})
