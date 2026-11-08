import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects, users } from '@canonry/canonry-db'
import { notImplemented, type ProviderHealthcheckResult } from '@canonry/canonry-contracts'
import { apiRoutes, hashApiKey, type ApiRoutesOptions, type OutcomeTelemetryEvent, type ProviderTestRun } from '../src/index.js'
import { featureOutcomes } from './feature-outcome-capture.js'

type ProviderTestHook = NonNullable<ApiRoutesOptions['onProviderTest']>

/** A host run of one check; `record` captures what the host is asked to keep. */
function run(check: () => Promise<ProviderHealthcheckResult>, record: ProviderTestRun['record'] = vi.fn()): ProviderTestRun {
  return { check: check(), record }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(options: { onProviderTest?: ProviderTestHook; timeoutMs?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-test-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'example', name: 'example', displayName: 'Example', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(users).values({
    id: 'viewer', name: 'viewer', nameKey: 'viewer', passwordHash: 'not-used-for-bearer-auth',
    role: 'viewer', createdAt: now,
  }).run()
  for (const key of [
    { id: 'root', scopes: ['*'] },
    { id: 'settings', scopes: ['settings.write'] },
    { id: 'project', scopes: ['*'], projectId: 'example' },
    { id: 'read', scopes: ['read'] },
    { id: 'write', scopes: ['write'] },
    { id: 'viewer', scopes: ['*'], delegatedUserId: 'viewer' },
  ]) {
    const token = `cnry_provider_test_${key.id}`
    db.insert(apiKeys).values({
      ...key, name: key.id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), createdAt: now,
    }).run()
  }
  const outcomes: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    onOutcome: event => { outcomes.push(event) },
    providerAdapters: [
      {
        name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
        defaultModel: 'gemini-flash-latest', knownModels: [], modelValidationPattern: /./, modelValidationHint: 'Gemini model',
      },
      {
        name: 'exa', displayName: 'Exa', mode: 'api', kind: 'answer-service', modelConfigurable: false,
        defaultModel: '', knownModels: [], modelValidationPattern: /./, modelValidationHint: 'Exa profile',
      },
    ],
    ...(options.onProviderTest ? { onProviderTest: options.onProviderTest } : {}),
    ...(options.timeoutMs ? { providerTestTimeoutMs: options.timeoutMs } : {}),
  })
  await app.ready()
  cleanups.push(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const test = (name: string, key = 'root', headers: Record<string, string> = {}) => app.inject({
    method: 'POST',
    url: `/api/v1/settings/providers/${encodeURIComponent(name)}/test`,
    headers: { authorization: `Bearer cnry_provider_test_${key}`, ...headers },
  })
  return { test, outcomes }
}

const checkedAt = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

describe('POST /settings/providers/:name/test', () => {
  it.each<{ case: string; name: string; check: () => Promise<ProviderHealthcheckResult>; expected: Record<string, unknown> }>([
    {
      case: 'a passing check is connected',
      name: 'gemini',
      check: async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified', model: 'gemini-flash-latest' }),
      expected: { status: 'connected', ok: true, message: 'gemini api key verified', model: 'gemini-flash-latest' },
    },
    {
      case: 'a refusal is a failed result with the credential redacted',
      name: 'gemini',
      check: async () => ({ ok: false, provider: 'gemini', message: '401 Unauthorized: Bearer sk-live-fixture rejected', model: 'gemini-flash-latest' }),
      expected: { status: 'failed', ok: false, message: '401 Unauthorized: Bearer [REDACTED] rejected', model: 'gemini-flash-latest' },
    },
    {
      case: 'a pass without any request is not-verified',
      name: 'exa',
      check: async () => ({ ok: true, verified: false, provider: 'exa', message: 'Exa key saved, not verified: the service documents no free key check.' }),
      expected: { status: 'not-verified', ok: true, message: 'Exa key saved, not verified: the service documents no free key check.', model: null },
    },
    {
      case: 'a check that throws is that provider failing, not a server error',
      name: 'gemini',
      check: async () => { throw new Error('socket hang up') },
      expected: { status: 'failed', ok: false, message: 'socket hang up', model: null },
    },
  ])('$case, and the host keeps exactly that result', async ({ name, check, expected }) => {
    const record = vi.fn()
    const onProviderTest = vi.fn<ProviderTestHook>(() => run(check, record))
    const { test } = await harness({ onProviderTest })
    const response = await test(name)
    expect(response.statusCode).toBe(200)
    expect(response.headers['x-canonry-access']).toBe('live')
    expect(response.json()).toEqual({
      provider: name,
      displayName: name === 'exa' ? 'Exa' : 'Gemini',
      ...expected,
      checkedAt,
      durationMs: expect.any(Number),
    })
    expect(onProviderTest).toHaveBeenCalledWith(name)
    expect(record).toHaveBeenCalledExactlyOnceWith(response.json())
  })

  it('reports and keeps a check that never answers as failed once the wait ends', async () => {
    const record = vi.fn()
    const { test } = await harness({ onProviderTest: () => ({ check: new Promise(() => {}), record }), timeoutMs: 20 })
    const response = await test('gemini')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'failed',
      ok: false,
      model: null,
      message: 'Gemini did not answer within 1 second. Check the endpoint and network, then test again.',
    })
    expect(record).toHaveBeenCalledExactlyOnceWith(response.json())
  })

  it('still answers when the host cannot keep the result', async () => {
    const { test } = await harness({ onProviderTest: () => run(async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified' }), () => { throw new Error('database is locked') }) })
    const response = await test('gemini')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'connected', ok: true })
  })

  it.each([
    {
      case: 'an unknown connection, naming the valid ones',
      name: 'openrouter:openai/gpt-5',
      hook: true,
      status: 400,
      error: { code: 'VALIDATION_ERROR', details: { provider: 'openrouter:openai/gpt-5', validProviders: ['gemini', 'exa'] } },
      called: false,
    },
    {
      case: 'a connection with nothing saved',
      name: 'gemini',
      hook: true,
      status: 400,
      error: { code: 'VALIDATION_ERROR', details: { provider: 'gemini', reason: 'provider-not-configured' } },
      called: true,
    },
    {
      case: 'a host without connection tests',
      name: 'gemini',
      hook: false,
      status: 501,
      error: { code: 'NOT_IMPLEMENTED' },
      called: false,
    },
  ])('refuses $case', async ({ name, hook, status, error, called }) => {
    const onProviderTest = vi.fn<ProviderTestHook>(() => undefined)
    const { test } = await harness(hook ? { onProviderTest } : {})
    const response = await test(name)
    expect(response.statusCode).toBe(status)
    expect(response.json()).toMatchObject({ error })
    expect(onProviderTest).toHaveBeenCalledTimes(called ? 1 : 0)
  })

  it('keeps a host refusal as that refusal instead of a failed provider result', async () => {
    const { test } = await harness({ onProviderTest: () => { throw notImplemented('Connection tests are paused on this host') } })
    const response = await test('gemini')
    expect(response.statusCode).toBe(501)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED', message: 'Connection tests are paused on this host' } })
  })

  it.each(['root', 'settings', 'project'])('lets a %s credential that can save provider keys run the test', async (key) => {
    const onProviderTest = vi.fn<ProviderTestHook>(() => run(async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified' })))
    const { test } = await harness({ onProviderTest })
    expect((await test('gemini', key)).statusCode).toBe(200)
    expect(onProviderTest).toHaveBeenCalledTimes(1)
  })

  // `write` reaches this route's own scope check; `read` and `viewer` are refused earlier for any POST,
  // which this keeps true should the route ever be marked as a read.
  it.each(['read', 'write', 'viewer'])('refuses a %s credential before any provider call, since the test spends on the provider account', async (key) => {
    const onProviderTest = vi.fn<ProviderTestHook>(() => run(async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified' })))
    const { test } = await harness({ onProviderTest })
    const response = await test('gemini', key)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(onProviderTest).not.toHaveBeenCalled()
  })

  it('is refused in stored-only mode before any provider call', async () => {
    const onProviderTest = vi.fn<ProviderTestHook>(() => run(async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified' })))
    const { test } = await harness({ onProviderTest })
    const response = await test('gemini', 'root', { 'x-canonry-stored-only': '1' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'STORED_ONLY_REFUSED', details: { access: 'live' } } })
    expect(onProviderTest).not.toHaveBeenCalled()
  })

  it('reports each test outcome, naming only providers the telemetry catalog knows', async () => {
    const results: Array<() => ProviderTestRun | undefined> = [
      () => run(async () => ({ ok: true, provider: 'gemini', message: 'gemini api key verified' })),
      () => run(async () => ({ ok: false, provider: 'gemini', message: '401 Unauthorized' })),
      () => run(async () => ({ ok: true, verified: false, provider: 'exa', message: 'Exa key saved, not verified' })),
      () => ({ check: new Promise(() => {}) }),
      () => undefined,
    ]
    const { test, outcomes } = await harness({ onProviderTest: () => results.shift()!(), timeoutMs: 20 })
    for (const name of ['gemini', 'gemini', 'exa', 'gemini', 'gemini']) await test(name)
    const base = { feature: 'providers', operation: 'test', durationBucket: expect.any(String) }
    expect(featureOutcomes(outcomes)).toEqual([
      { ...base, status: 'succeeded', provider: 'gemini' },
      { ...base, status: 'failed', reasonCode: 'UNKNOWN', provider: 'gemini' },
      { ...base, status: 'skipped', reasonCode: 'UNSUPPORTED' },
      { ...base, status: 'failed', reasonCode: 'TIMEOUT', provider: 'gemini' },
      { ...base, status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError' },
    ])
  })
})
