import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'

describe('direct ApiClient stored-only transport boundaries', () => {
  afterEach(() => {
    delete process.env.CANONRY_STORED_ONLY
    vi.restoreAllMocks()
  })

  it('refuses streamPost before opening a socket', async () => {
    process.env.CANONRY_STORED_ONLY = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new ApiClient('http://127.0.0.1:9', 'test-key', { skipProbe: true })
    await expect(client.streamPost('/projects/acme/agent/stream', {})).rejects.toMatchObject({ code: 'STORED_ONLY_REFUSED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('marks direct results export requests with the stored-only header', async () => {
    process.env.CANONRY_STORED_ONLY = '1'
    let requestHeaders: Headers | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return new Response('export-data', { status: 200, headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="results.txt"' } })
    })
    const client = new ApiClient('http://127.0.0.1:9', 'test-key', { skipProbe: true })
    const result = await client.downloadResultsExport('acme', { format: 'json' })
    expect(result.content).toBe('export-data')
    expect(requestHeaders?.get('x-canonry-stored-only')).toBe('1')
  })

  it('marks the base-path health probe without attempting an update check', async () => {
    process.env.CANONRY_STORED_ONLY = '1'
    const requests: { url: string; headers: Headers }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), headers: input instanceof Request ? input.headers : new Headers(init?.headers) })
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = new ApiClient('http://127.0.0.1:9', 'test-key')
    expect(await client.getServerUpdateAvailable()).toBeNull()
    expect(requests).toHaveLength(0)
    await client.listProjects()
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe('http://127.0.0.1:9/health')
    expect(requests[1]?.url).toContain('/api/v1/projects')
    expect(requests.every(request => request.headers.get('x-canonry-stored-only') === '1')).toBe(true)
  })

  it('rebuilds an ordinary stream URL after discovering the server base path', async () => {
    const requests: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', basePath: '/canonry' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('event: complete\\ndata: {}\\n\\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const client = new ApiClient('http://127.0.0.1:9', 'test-key')
    const response = await client.streamPost('/projects/acme/agent/stream', {})
    expect(response.ok).toBe(true)
    expect(requests).toEqual([
      'http://127.0.0.1:9/health',
      'http://127.0.0.1:9/canonry/api/v1/projects/acme/agent/stream',
    ])
  })
})
