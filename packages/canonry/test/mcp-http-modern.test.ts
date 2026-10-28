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
  })

  function requestKeys() {
    return instance.db.select().from(apiKeys).where(eq(apiKeys.delegatedUserId, instance.user.id)).all()
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

  it('keeps its internal credential valid while an SSE response is open, then deletes it on cancellation', async () => {
    const response = await fetch(instance.transportUrl, modernRequest(token, 'subscriptions/listen', {
      notifications: { toolsListChanged: true },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    try {
      const frame = await reader.read()
      expect(new TextDecoder().decode(frame.value)).toContain('notifications/subscriptions/acknowledged')
      expect(requestKeys()).toHaveLength(1)
      expect(requestKeys()[0]?.revokedAt).toBeNull()
    } finally {
      await reader.cancel()
    }
    await vi.waitFor(() => expect(requestKeys()).toEqual([]))
  })

  it.each(['complete', 'abort'] as const)('propagates a delayed tool request through %s and retires its credential', async mode => {
    const realFetch = globalThis.fetch
    let internalSignal: AbortSignal | undefined
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${instance.origin}${instance.basePath}/api/v1/projects`) {
        internalSignal = input instanceof Request ? input.signal : init?.signal ?? undefined
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

  it.each(['modern', 'legacy'] as const)('retries failed %s credential retirement after storage recovers', async era => {
    const endpoint = `${instance.origin}${instance.basePath}/api/v1/mcp/readonly`
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let sessionId: string | null = null
    if (era === 'modern') {
      const opened = await fetch(endpoint, modernRequest(token, 'subscriptions/listen', {
        notifications: { toolsListChanged: true },
      }))
      reader = opened.body!.getReader()
      await reader.read()
    } else {
      const initialized = await fetch(endpoint, {
        method: 'POST', headers: {
          authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cleanup-probe', version: '1' },
        } }),
      })
      await initialized.text()
      sessionId = initialized.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
    }
    const key = requestKeys().find(row => row.revokedAt === null)!
    expect(key).toBeDefined()
    // A SQLite write failure is the actual persistence boundary, not a mocked
    // cleanup callback that manufactures the retry behavior being asserted.
    const failedKeys = new Set<string>()
    instance.db.$client.function('mcp_test_retirement_failure', (id: unknown) => {
      failedKeys.add(String(id))
      throw new Error('synthetic credential storage failure')
    })
    instance.db.$client.exec(`
      CREATE TEMP TRIGGER mcp_test_fail_retirement BEFORE UPDATE OF revoked_at ON main.api_keys
      WHEN OLD.name LIKE 'mcp-session:%'
      BEGIN SELECT mcp_test_retirement_failure(OLD.id); END;
    `)
    try {
      if (reader) await reader.cancel()
      else {
        const deleted = await fetch(endpoint, { method: 'DELETE', headers: {
          authorization: `Bearer ${token}`, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-11-25',
        } })
        expect(deleted.status).toBe(200)
        await deleted.text()
      }
      await vi.waitFor(() => expect(failedKeys.has(key.id)).toBe(true))
      const failedRetry = await fetch(endpoint, modernRequest(token, 'tools/list'))
      expect(failedRetry.status).toBe(200)
      await failedRetry.text()
      expect(requestKeys().find(row => row.id === key.id)?.revokedAt).toBeNull()
    } finally {
      instance.db.$client.exec('DROP TRIGGER IF EXISTS mcp_test_fail_retirement')
      await reader?.cancel()
    }
    const recovered = await fetch(endpoint, modernRequest(token, 'tools/list'))
    expect(recovered.status).toBe(200)
    await recovered.text()
    await vi.waitFor(() => {
      const retired = requestKeys().find(row => row.id === key.id)
      if (era === 'modern') expect(retired).toBeUndefined()
      else expect(retired?.revokedAt).toEqual(expect.any(String))
      expect(requestKeys().filter(row => row.revokedAt === null)).toEqual([])
    })
    // Keep later cases independent of the retained legacy audit identity.
    instance.db.delete(apiKeys).where(eq(apiKeys.id, key.id)).run()
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

  it('closes an open SSE response and retries pending retirement at shutdown', async () => {
    const opened = await fetch(instance.transportUrl, modernRequest(token, 'subscriptions/listen', {
      notifications: { toolsListChanged: true },
    }))
    const reader = opened.body!.getReader()
    await reader.read()
    const key = requestKeys().find(row => row.revokedAt === null && row.scopes.length === 1)!
    expect(key).toBeDefined()
    const stillOpen = await fetch(instance.transportUrl, modernRequest(token, 'subscriptions/listen', {
      notifications: { toolsListChanged: true },
    }))
    const stillOpenReader = stillOpen.body!.getReader()
    await stillOpenReader.read()
    let failed = false
    instance.db.$client.function('mcp_test_shutdown_failure', () => {
      failed = true
      throw new Error('synthetic shutdown storage failure')
    })
    instance.db.$client.exec(`
      CREATE TEMP TRIGGER mcp_test_fail_shutdown BEFORE UPDATE OF revoked_at ON main.api_keys
      WHEN OLD.name LIKE 'mcp-session:%'
      BEGIN SELECT mcp_test_shutdown_failure(); END;
    `)
    try {
      await reader.cancel()
      await vi.waitFor(() => expect(failed).toBe(true))
      expect(requestKeys().find(row => row.id === key.id)?.revokedAt).toBeNull()
    } finally {
      instance.db.$client.exec('DROP TRIGGER IF EXISTS mcp_test_fail_shutdown')
      await reader.cancel()
    }
    const closing = instance.app.close()
    let streamEnded = false
    while (!streamEnded) streamEnded = (await stillOpenReader.read()).done
    await closing
    expect(streamEnded).toBe(true)
    expect(requestKeys().find(row => row.id === key.id)).toBeUndefined()
    expect(requestKeys().filter(row => row.revokedAt === null)).toEqual([])
  })

})
