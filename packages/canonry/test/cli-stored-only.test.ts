import { describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { ApiClient, classifyStoredOnlyRequest } from '../src/client.js'
import { createCanonryMcpServerWithCatalog, getCanonryMcpTools } from '../src/mcp/server.js'
import { parseCliOptions } from '../src/mcp/cli.js'
import { toolOperationAccess } from '../src/mcp/tool-registry.js'

describe('CLI stored-only guard', () => {
  it('refuses live and write specs before their handlers run', async () => {
    const calls: string[] = []
    const specs = [
      { path: ['stored'], usage: 'stored', access: 'stored' as const, run: () => calls.push('stored') },
      { path: ['live'], usage: 'live', access: 'live' as const, run: () => calls.push('live') },
      { path: ['write'], usage: 'write', access: 'write' as const, run: () => calls.push('write') },
    ]
    process.env.CANONRY_STORED_ONLY = '1'
    try {
      await expect(dispatchRegisteredCommand(['live'], 'json', specs)).rejects.toMatchObject({ code: 'STORED_ONLY_REFUSED' })
      await expect(dispatchRegisteredCommand(['write'], 'json', specs)).rejects.toMatchObject({ code: 'STORED_ONLY_REFUSED' })
      await dispatchRegisteredCommand(['stored'], 'json', specs)
    } finally {
      delete process.env.CANONRY_STORED_ONLY
    }
    expect(calls).toEqual(['stored'])
  })

  it('keeps a stored CLI dispatch from opening a provider POST socket', async () => {
    process.env.CANONRY_STORED_ONLY = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new ApiClient('http://127.0.0.1:9', 'test-key', { skipProbe: true })
    const specs = [{
      path: ['stored', 'preview'],
      usage: 'stored preview',
      access: 'stored' as const,
      run: async () => { await client.triggerRun('acme') },
    }]
    try {
      await expect(dispatchRegisteredCommand(['stored', 'preview'], 'json', specs)).rejects.toMatchObject({ code: 'STORED_ONLY_REFUSED' })
    } finally {
      delete process.env.CANONRY_STORED_ONLY
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('classifies a provider URL before a mislabeled client spec can send it', () => {
    expect(classifyStoredOnlyRequest('GET', 'http://localhost/api/v1/projects/acme/google/gsc/sitemaps')).toMatchObject({
      operation: 'GET /api/v1/projects/{name}/google/gsc/sitemaps',
      access: 'live',
    })
    expect(classifyStoredOnlyRequest('GET', 'http://localhost/api/v1/projects/acme/new-route')).toMatchObject({ access: 'live' })
  })

  it('keeps MCP stored-only scope to stored operations and honors flag and env', () => {
    expect(parseCliOptions(['--stored-only'], {}).scope).toBe('stored-only')
    expect(parseCliOptions([], { CANONRY_STORED_ONLY: '1' }).scope).toBe('stored-only')
    const tools = getCanonryMcpTools('stored-only')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => toolOperationAccess(tool) === 'stored')).toBe(true)
    const { catalog } = createCanonryMcpServerWithCatalog({
      scope: 'stored-only',
      eager: true,
      clientFactory: () => ({}) as unknown as ApiClient,
    })
    expect(catalog.helpResult().scope).toBe('stored-only')
    expect(catalog.helpResult().toolkits.every(toolkit => toolkit.liveTools.length === 0)).toBe(true)
  })
})
