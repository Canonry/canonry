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
    const headers: Headers[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      headers.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = new ApiClient('http://127.0.0.1:9', 'test-key')
    expect(await client.getServerUpdateAvailable()).toBeNull()
    await client.listProjects()
    expect(headers[0]?.get('x-canonry-stored-only')).toBe('1')
  })
})
