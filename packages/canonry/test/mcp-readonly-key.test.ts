import { describe, expect, it, vi } from 'vitest'
import type { ApiKeyDto } from '@ainyc/canonry-contracts'
import { resolveEffectiveScope, resolveEffectiveAuthorization } from '../src/mcp/cli.js'
import { getCanonryMcpTools } from '../src/mcp/server.js'

function selfDto(overrides: Partial<ApiKeyDto>): ApiKeyDto {
  return {
    id: 'k1',
    name: 'mcp',
    keyPrefix: 'cnry_aaaa',
    scopes: ['*'],
    projectId: null,
    projectName: null,
    readOnly: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('resolveEffectiveScope — MCP read-only auto-detection', () => {
  it('advertises only research writes for a delegated research credential', async () => {
    const client = { getApiKeySelf: vi.fn().mockResolvedValue(selfDto({ scopes: ['read', 'research.run'] })) }
    const access = await resolveEffectiveAuthorization(client, 'all')
    const tools = getCanonryMcpTools(access.scope, undefined, access.credentialScopes)
    expect(tools.filter(tool => tool.access === 'write').map(tool => tool.name)).toEqual([
      'canonry_research_run_start',
      'canonry_research_batch_start',
    ])
    expect(tools.map(tool => tool.name)).toContain('canonry_research_runs_list')
    expect(getCanonryMcpTools('read-only', undefined, access.credentialScopes).every(tool => tool.access === 'read')).toBe(true)
    const discovery = getCanonryMcpTools(access.scope, ['core', 'discovery'], access.credentialScopes)
    expect(discovery.map(tool => tool.name)).toContain('canonry_research_run_start')
    expect(discovery.map(tool => tool.name)).toContain('canonry_research_batch_start')
    expect(discovery.map(tool => tool.name)).not.toContain('canonry_discover_run_start')
    expect(tools.map(tool => tool.name)).not.toContain('canonry_measurement_query_template_upsert')
  })
  it('forces read-only when the configured key is read-only (readOnly flag)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const client = { getApiKeySelf: vi.fn().mockResolvedValue(selfDto({ scopes: ['read'], readOnly: true })) }
    try {
      expect(await resolveEffectiveScope(client, 'all')).toBe('read-only')
      // It announces the restriction on stderr (never stdout).
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/read-only/i))
    } finally {
      stderr.mockRestore()
    }
  })

  it('forces read-only from scopes even if an old server omits the readOnly field', async () => {
    const client = {
      // Simulate a server that returns scopes but not the derived flag.
      getApiKeySelf: vi.fn().mockResolvedValue({ ...selfDto({ scopes: ['read'] }), readOnly: undefined } as unknown as ApiKeyDto),
    }
    expect(await resolveEffectiveScope(client, 'all')).toBe('read-only')
  })

  it('keeps the full catalog for a wildcard key', async () => {
    const client = { getApiKeySelf: vi.fn().mockResolvedValue(selfDto({ scopes: ['*'], readOnly: false })) }
    expect(await resolveEffectiveScope(client, 'all')).toBe('all')
  })

  it('does not probe when --read-only was already requested', async () => {
    const getApiKeySelf = vi.fn()
    expect(await resolveEffectiveScope({ getApiKeySelf }, 'read-only')).toBe('read-only')
    expect(getApiKeySelf).not.toHaveBeenCalled()
  })

  it('falls back to the requested scope when the probe fails (offline / old server)', async () => {
    const client = { getApiKeySelf: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    expect(await resolveEffectiveScope(client, 'all')).toBe('all')
  })
})
