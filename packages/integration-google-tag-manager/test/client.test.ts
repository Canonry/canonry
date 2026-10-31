import { describe, expect, it } from 'vitest'
import { createGoogleTagManagerClient, GtmApiError } from '../src/index.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  })
}

describe('Google Tag Manager read client', () => {
  it('includes the provider host and dialed address for transport failures', async () => {
    const cause = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED', syscall: 'connect', address: '203.0.113.8', port: 443,
    })
    const fetchImpl: typeof fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause }) }
    const client = createGoogleTagManagerClient('oauth-token', { fetch: fetchImpl, retry: { maxRetries: 0 } })
    await expect(client.listAccounts()).rejects.toThrow(/ECONNREFUSED.*tagmanager\.googleapis\.com.*203\.0\.113\.8:443/)
  })

  it('paginates accounts and lists canonical containers and workspaces with GET only', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      if (url.pathname.endsWith('/accounts')) {
        return url.searchParams.has('pageToken')
          ? jsonResponse({ account: [{ accountId: '2', path: 'accounts/2' }] })
          : jsonResponse({ account: [{ accountId: '1', path: 'accounts/1' }], nextPageToken: 'next' })
      }
      if (url.pathname.endsWith('/accounts/1/containers')) {
        return jsonResponse({ container: [{ containerId: '2', path: 'accounts/1/containers/2' }] })
      }
      return jsonResponse({ workspace: [{ workspaceId: '3', path: 'accounts/1/containers/2/workspaces/3' }] })
    }
    const client = createGoogleTagManagerClient('oauth-token', { fetch: fetchImpl })

    await expect(client.listAccounts()).resolves.toHaveLength(2)
    await expect(client.listContainers('accounts/1')).resolves.toHaveLength(1)
    await expect(client.listWorkspaces('accounts/1/containers/2')).resolves.toHaveLength(1)
    expect(calls.every((call) => call.init?.method === 'GET')).toBe(true)
    expect(calls.every((call) => new Headers(call.init?.headers).get('authorization') === 'Bearer oauth-token')).toBe(true)
    expect(calls[1]?.url.searchParams.get('pageToken')).toBe('next')
  })

  it('reads the live version and every selected-workspace entity surface', async () => {
    const paths: string[] = []
    let builtInVariablesSearch: string | null = null
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      const path = url.pathname.replace('/tagmanager/v2/', '')
      paths.push(path)
      if (path.endsWith('/versions:live')) {
        return jsonResponse({
          accountId: '1',
          containerId: '2',
          containerVersionId: '7',
          tag: [{ tagId: '10', name: 'Live', type: 'awct' }],
        })
      }
      if (path.endsWith('/workspaces/3')) {
        return jsonResponse({ accountId: '1', containerId: '2', workspaceId: '3', path })
      }
      if (path.endsWith('/status')) return jsonResponse({ workspaceChange: [] })
      if (path.endsWith('/tags')) {
        return jsonResponse({
          tag: [{
            tagId: '10',
            name: 'Draft',
            type: 'awct',
            parameter: [{ key: 'map', type: 'map', map: [{ key: 'value', type: 'template', value: 'x' }] }],
          }],
        })
      }
      if (path.endsWith('/triggers')) return jsonResponse({ trigger: [{ triggerId: '8', type: 'customEvent' }] })
      if (path.endsWith('/variables')) return jsonResponse({ variable: [{ variableId: '9', type: 'v' }] })
      if (path.endsWith('/folders')) return jsonResponse({ folder: [{ folderId: '4', name: 'Ads' }] })
      if (path.endsWith('/built_in_variables')) {
        builtInVariablesSearch = url.search
        return jsonResponse({ builtInVariable: [{ type: 'pageHostname', name: 'Page Hostname' }] })
      }
      throw new Error(`Unexpected path ${path}`)
    }
    const client = createGoogleTagManagerClient('oauth-token', { fetch: fetchImpl })

    const live = await client.getLiveSnapshot('accounts/1/containers/2')
    const draft = await client.getWorkspaceSnapshot('accounts/1/containers/2/workspaces/3')

    expect(live.identity.containerVersionId).toBe('7')
    expect(draft.entities).toMatchObject({
      tags: [{ id: '10' }],
      triggers: [{ id: '8' }],
      variables: [{ id: '9' }],
      folders: [{ id: '4' }],
      builtInVariables: [{ id: 'pageHostname' }],
    })
    expect(draft.entities.tags[0]?.raw.parameter?.[0]?.map?.[0]?.value).toBe('x')
    expect(builtInVariablesSearch).toBe('')
    expect(paths).toEqual(expect.arrayContaining([
      'accounts/1/containers/2/versions:live',
      'accounts/1/containers/2/workspaces/3/status',
      'accounts/1/containers/2/workspaces/3/tags',
      'accounts/1/containers/2/workspaces/3/triggers',
      'accounts/1/containers/2/workspaces/3/variables',
      'accounts/1/containers/2/workspaces/3/folders',
      'accounts/1/containers/2/workspaces/3/built_in_variables',
    ]))
  })

  it('retries transient failures and honors Retry-After', async () => {
    let calls = 0
    const sleeps: number[] = []
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return calls === 1
        ? jsonResponse({ error: { message: 'temporarily unavailable' } }, {
          status: 503,
          headers: { 'retry-after': '2' },
        })
        : jsonResponse({ account: [] })
    }
    const client = createGoogleTagManagerClient('oauth-token', {
      fetch: fetchImpl,
      retry: { maxRetries: 1, sleep: async (ms) => { sleeps.push(ms) } },
    })

    await expect(client.listAccounts()).resolves.toEqual([])
    expect(calls).toBe(2)
    expect(sleeps).toEqual([2_000])
  })

  it('does not retry auth errors and redacts a reflected token', async () => {
    let calls = 0
    const token = 'ya29-secret-token'
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return jsonResponse({
        error: {
          message: `invalid credential ${token}`,
          status: 'UNAUTHENTICATED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      }, { status: 401 })
    }
    const client = createGoogleTagManagerClient(token, {
      fetch: fetchImpl,
      retry: { maxRetries: 3, sleep: async () => undefined },
    })

    const error = await client.listAccounts().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GtmApiError)
    expect(error).toMatchObject({
      status: 401,
      providerStatus: 'UNAUTHENTICATED',
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    })
    expect((error as Error).message).toBe('invalid credential [redacted]')
    expect((error as Error).message).not.toContain(token)
    expect(calls).toBe(1)
  })

  it('preserves a non-JSON auth response as non-retryable', async () => {
    let calls = 0
    const client = createGoogleTagManagerClient('oauth-token', {
      fetch: async () => {
        calls += 1
        return new Response('<html>unauthorized</html>', { status: 401 })
      },
      retry: { maxRetries: 3, sleep: async () => undefined },
    })

    await expect(client.listAccounts()).rejects.toMatchObject({
      status: 401,
      message: 'Tag Manager request failed (HTTP 401)',
    })
    expect(calls).toBe(1)
  })

  it('rejects non-canonical paths before sending a request', async () => {
    let calls = 0
    const client = createGoogleTagManagerClient('oauth-token', {
      fetch: async () => {
        calls += 1
        return jsonResponse({})
      },
    })

    for (const path of [
      'https://example.com/accounts/1',
      'accounts/..',
      'accounts/1?alt=json',
      'accounts/1#fragment',
      'accounts/a%2Fb',
      'accounts/a\\b',
    ]) {
      await expect(client.listContainers(path)).rejects.toMatchObject({
        status: 400,
        reason: 'INVALID_RESOURCE_PATH',
      })
    }
    expect(calls).toBe(0)
  })
})
