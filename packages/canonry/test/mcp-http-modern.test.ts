import Database from 'better-sqlite3'
import { apiKeys, users } from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { authorizeSyntheticMcp, startSyntheticMcpInstance, type SyntheticMcpInstance } from './mcp-gateway-fixture.js'

interface RpcMessage {
  result?: { structuredContent?: unknown; isError?: boolean }
  error?: { code: number; message: string }
}

function modernRequest(token: string, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST', signal,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  }
}

async function rpcMessage(response: Response): Promise<RpcMessage> {
  const body = await response.text()
  const data = body.split('\n').find(line => line.startsWith('data:'))?.replace(/^data:\s*/, '') ?? body
  return JSON.parse(data) as RpcMessage
}

/** Transport lifetime tests complement the SDK-client contract suite. */
describe('modern MCP request authority and cancellation', () => {
  let instance: SyntheticMcpInstance
  let token: string

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
    vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
    vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_BASE_PATH', undefined)
    instance = await startSyntheticMcpInstance({ name: 'synthetic-modern-lifecycle', basePath: '/nested' })
    token = (await authorizeSyntheticMcp(instance)).access_token
    // Observe real key issuance even when request cleanup immediately deletes it.
    instance.db.$client.exec(`
      CREATE TEMP TABLE mcp_test_key_issuance (id TEXT);
      CREATE TEMP TRIGGER mcp_test_record_key AFTER INSERT ON main.api_keys
      WHEN NEW.name LIKE 'mcp-session:%'
      BEGIN INSERT INTO mcp_test_key_issuance VALUES (NEW.id); END;
    `)
  })

  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await instance?.close()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  function requestKeys() {
    return instance.db.select().from(apiKeys).where(eq(apiKeys.delegatedUserId, instance.user.id)).all()
  }

  async function initializeLegacy(): Promise<string> {
    const response = await fetch(instance.transportUrl, {
      method: 'POST', headers: {
        authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-probe', version: '1' },
      } }),
    })
    await response.text()
    expect(response.status).toBe(200)
    const id = response.headers.get('mcp-session-id')
    expect(id).toBeTruthy()
    return id!
  }

  it.each([
    { name: 'missing mirrored method', header: 'mcp-method', value: undefined, code: -32020 },
    { name: 'mismatched mirrored method', header: 'mcp-method', value: 'tools/call', code: -32020 },
    { name: 'mismatched protocol revision', header: 'mcp-protocol-version', value: '2025-11-25', code: -32020 },
  ])('rejects $name before issuing any internal credential', async ({ header, value, code }) => {
    const issuedBefore = instance.db.$client.prepare('SELECT count(*) AS count FROM mcp_test_key_issuance').get()
    const init = modernRequest(token, 'tools/list')
    const headers = new Headers(init.headers)
    if (value === undefined) headers.delete(header)
    else headers.set(header, value)
    const response = await fetch(instance.transportUrl, { ...init, headers })
    expect(response.status).toBe(400)
    expect((await rpcMessage(response)).error?.code).toBe(code)
    expect(instance.db.$client.prepare('SELECT count(*) AS count FROM mcp_test_key_issuance').get()).toEqual(issuedBefore)
  })

  it('completes unsupported subscriptions and metadata reads without issuing credentials', async () => {
    const issuedBefore = instance.db.$client.prepare('SELECT count(*) AS count FROM mcp_test_key_issuance').get()
    for (const bearer of [token, instance.rootKey]) {
      for (const method of ['server/discover', 'tools/list', 'resources/list']) {
        const response = await fetch(instance.transportUrl, modernRequest(bearer, method))
        expect(response.status).toBe(200)
        expect((await rpcMessage(response)).error).toBeUndefined()
      }
      const response = await fetch(instance.transportUrl, modernRequest(bearer, 'subscriptions/listen', {
        notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['canonry://agent-operations/v1'] },
      }, AbortSignal.timeout(5_000)))
      expect(response.status).toBe(200)
      const body = await response.text()
      const frames = body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)) as { method?: string; params?: unknown; result?: unknown })
      expect(frames).toEqual([expect.objectContaining({
        method: 'notifications/subscriptions/acknowledged', params: expect.objectContaining({ notifications: {} }),
      }), expect.objectContaining({ result: expect.objectContaining({ resultType: 'complete' }) })])
    }
    expect(instance.db.$client.prepare('SELECT count(*) AS count FROM mcp_test_key_issuance').get()).toEqual(issuedBefore)
    expect(requestKeys()).toEqual([])
  })

  it.each(['complete', 'abort'] as const)('propagates a delayed tool request through %s and retires its credential', async mode => {
    const realFetch = globalThis.fetch
    let internalSignal: AbortSignal | undefined
    let internalSession: string | null | undefined
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${instance.origin}${instance.basePath}/api/v1/projects`) {
        internalSignal = input instanceof Request ? input.signal : init?.signal ?? undefined
        internalSession = new Headers(input instanceof Request ? input.headers : init?.headers).get('x-canonry-actor-session')
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(internalSignal?.reason)
          internalSignal?.addEventListener('abort', onAbort, { once: true })
          void delayed.then(() => {
            internalSignal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      }
      return realFetch(input, init)
    })
    const abort = new AbortController()
    const result = fetch(instance.transportUrl, modernRequest(token, 'tools/call', {
      name: 'canonry_projects_list', arguments: {},
    }, abort.signal)).then(async response => ({ response, message: await rpcMessage(response) }))
    // Attach the rejection handler before aborting to avoid an unhandled promise.
    const settled = result.then(value => ({ value }), error => ({ error: error as Error }))
    try {
      await vi.waitFor(() => expect(internalSignal).toBeDefined())
      expect(internalSignal?.aborted).toBe(false)
      expect(internalSession).toBeNull()
      expect(requestKeys()).toHaveLength(1)
      expect(requestKeys()[0]?.revokedAt).toBeNull()
      if (mode === 'abort') {
        abort.abort()
        await vi.waitFor(() => expect(internalSignal?.aborted).toBe(true))
        expect(await settled).toMatchObject({ error: { name: 'AbortError' } })
      } else {
        release()
        const outcome = await settled
        expect(outcome).toHaveProperty('value')
        if (!('value' in outcome)) throw outcome.error
        expect(outcome.value.response.status).toBe(200)
        expect(outcome.value.message.result?.isError).not.toBe(true)
        expect(JSON.stringify(outcome.value.message.result?.structuredContent)).toContain('synthetic-modern-lifecycle')
      }
      await vi.waitFor(() => expect(requestKeys()).toEqual([]))
    } finally {
      release()
      abort.abort()
      await settled
    }
  })

  it.each(['modern', 'legacy'] as const)('retries failed %s credential retirement only on the background sweep', async era => {
    const endpoint = instance.transportUrl
    const sessionId = era === 'legacy' ? await initializeLegacy() : null
    // Exercise the actual SQLite persistence boundary, including each attempt.
    const attempts: string[] = []
    instance.db.$client.function('mcp_test_retirement_failure', (id: unknown) => {
      attempts.push(String(id))
      throw new Error('synthetic credential storage failure')
    })
    instance.db.$client.exec(`
      CREATE TEMP TRIGGER mcp_test_fail_retirement BEFORE UPDATE OF revoked_at ON main.api_keys
      WHEN OLD.name LIKE 'mcp-session:%'
      BEGIN SELECT mcp_test_retirement_failure(OLD.id); END;
    `)
    let keyId = ''
    try {
      const retired = era === 'modern'
        ? await fetch(endpoint, modernRequest(token, 'tools/call', { name: 'canonry_projects_list', arguments: {} }))
        : await fetch(endpoint, { method: 'DELETE', headers: {
          authorization: `Bearer ${token}`, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-11-25',
        } })
      expect(retired.status).toBe(200)
      await retired.text()
      await vi.waitFor(() => expect(attempts).toHaveLength(1))
      keyId = attempts[0]!
      for (let read = 0; read < 3; read++) {
        const response = await fetch(endpoint, modernRequest(token, 'tools/list'))
        expect(response.status).toBe(200)
        await response.text()
      }
      expect(attempts).toEqual([keyId])
      expect(requestKeys().find(row => row.id === keyId)?.revokedAt).toBeNull()
      // The interval is aligned to boot, while the retry delay starts at failure.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(attempts).toEqual([keyId, keyId])
    } finally {
      instance.db.$client.exec('DROP TRIGGER IF EXISTS mcp_test_fail_retirement')
    }
    // A recovered database does not turn unrelated requests into retry workers.
    const response = await fetch(endpoint, modernRequest(token, 'tools/list'))
    expect(response.status).toBe(200)
    await response.text()
    expect(requestKeys().find(row => row.id === keyId)?.revokedAt).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    await vi.waitFor(() => {
      const retired = requestKeys().find(row => row.id === keyId)
      if (era === 'modern') expect(retired).toBeUndefined()
      else expect(retired?.revokedAt).toEqual(expect.any(String))
      expect(requestKeys().filter(row => row.revokedAt === null)).toEqual([])
    })
    instance.db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run()
  })

  it('logs an internal modern factory failure and keeps the transport usable', async () => {
    const logged = vi.spyOn(instance.app.log, 'error')
    instance.db.$client.exec(`
      CREATE TEMP TRIGGER mcp_test_fail_creation BEFORE INSERT ON main.api_keys
      WHEN NEW.name LIKE 'mcp-session:%'
      BEGIN SELECT RAISE(FAIL, 'synthetic MCP credential insertion failure'); END;
    `)
    try {
      const response = await fetch(instance.transportUrl, modernRequest(token, 'tools/call', { name: 'canonry_projects_list', arguments: {} }))
      expect(response.status).toBe(500)
      expect((await rpcMessage(response)).error?.code).toBe(-32603)
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Modern MCP request failed')
    } finally {
      instance.db.$client.exec('DROP TRIGGER IF EXISTS mcp_test_fail_creation')
    }
    const recovered = await fetch(instance.transportUrl, modernRequest(token, 'tools/call', { name: 'canonry_projects_list', arguments: {} }))
    expect(recovered.status).toBe(200)
    expect((await rpcMessage(recovered)).result?.isError).not.toBe(true)
  })

  it.each(['modern', 'legacy'] as const)('refuses to add read authority to a research-only OAuth grant over %s', async era => {
    instance.db.update(users).set({ role: 'admin' }).where(eq(users.id, instance.user.id)).run()
    try {
      const researchToken = (await authorizeSyntheticMcp(instance, 'research.run offline_access')).access_token
      const init = era === 'modern' ? modernRequest(researchToken, 'tools/list') : {
        method: 'POST', headers: {
          authorization: `Bearer ${researchToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'scope-probe', version: '1' },
        } }),
      }
      const response = await fetch(instance.transportUrl, init)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { message: 'The hosted read-only MCP endpoint requires the "read" scope.' } })
      expect(requestKeys()).toEqual([])
    } finally {
      instance.db.update(users).set({ role: 'viewer' }).where(eq(users.id, instance.user.id)).run()
    }
  })

  it('invalidates a legacy session after its OAuth user loses research authority', async () => {
    instance.db.update(users).set({ role: 'admin' }).where(eq(users.id, instance.user.id)).run()
    const researchToken = (await authorizeSyntheticMcp(instance, 'read research.run offline_access')).access_token
    const endpoint = `${instance.origin}${instance.basePath}/api/v1/mcp`
    const headers = {
      authorization: `Bearer ${researchToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    }
    try {
      const initialized = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'role-probe', version: '1' },
        },
      }) })
      await initialized.text()
      const sessionId = initialized.headers.get('mcp-session-id')!
      expect(sessionId).toBeTruthy()
      expect(requestKeys().find(key => key.revokedAt === null)?.scopes).toEqual(['read', 'research.run'])
      instance.db.update(users).set({ role: 'viewer' }).where(eq(users.id, instance.user.id)).run()
      const response = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('Unknown MCP session')
    } finally {
      instance.db.update(users).set({ role: 'viewer' }).where(eq(users.id, instance.user.id)).run()
    }
  })

  it('isolates a failed lifecycle read and resumes expiry checks on the next sweep', async () => {
    const logged = vi.spyOn(instance.app.log, 'error')
    const previousKeys = new Set(requestKeys().map(row => row.id))
    const sessionId = await initializeLegacy()
    const live = requestKeys().find(row => !previousKeys.has(row.id))!
    expect(live).toBeDefined()
    instance.db.$client.exec('ALTER TABLE api_keys RENAME TO mcp_test_unavailable_keys')
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'MCP lifecycle sweep failed; will retry on the next interval')
    } finally {
      instance.db.$client.exec('ALTER TABLE mcp_test_unavailable_keys RENAME TO api_keys')
    }
    instance.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, live.id)).run()
    await vi.advanceTimersByTimeAsync(60_000)
    const expired = await fetch(instance.transportUrl, {
      method: 'POST', headers: {
        authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(expired.status).toBe(404)
    await expired.text()
    const recovered = await fetch(instance.transportUrl, modernRequest(token, 'tools/list'))
    expect(recovered.status).toBe(200)
    await recovered.text()
  })

  it('aborts active tool work and completes shutdown without waiting for a database writer', async () => {
    const realFetch = globalThis.fetch
    let internalSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${instance.origin}${instance.basePath}/api/v1/projects`) {
        internalSignal = input instanceof Request ? input.signal : init?.signal ?? undefined
        await new Promise<void>((_resolve, reject) => {
          internalSignal?.addEventListener('abort', () => reject(internalSignal?.reason), { once: true })
        })
      }
      return realFetch(input, init)
    })
    const outcome = fetch(instance.transportUrl, modernRequest(token, 'tools/call', { name: 'canonry_projects_list', arguments: {} }))
      .then(response => response.text()).then(value => ({ value }), error => ({ error: error as Error }))
    await vi.waitFor(() => expect(internalSignal).toBeDefined())
    const key = requestKeys().find(row => row.revokedAt === null)!
    expect(key).toBeDefined()
    const writer = new Database(instance.db.$client.name)
    writer.exec('BEGIN IMMEDIATE')
    const timeoutBefore = instance.db.$client.pragma('busy_timeout', { simple: true })
    const started = performance.now()
    try {
      await instance.app.close()
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(internalSignal?.aborted).toBe(true)
      expect(requestKeys().find(row => row.id === key.id)?.revokedAt).toBeNull()
      expect(instance.db.$client.pragma('busy_timeout', { simple: true })).toBe(timeoutBefore)
      await outcome
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

})
