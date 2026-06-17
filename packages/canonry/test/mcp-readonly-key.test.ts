import { describe, expect, it, vi } from 'vitest'
import type { ApiKeyDto } from '@ainyc/canonry-contracts'
import { resolveEffectiveScope } from '../src/mcp/cli.js'

function selfDto(overrides: Partial<ApiKeyDto>): ApiKeyDto {
  return {
    id: 'k1',
    name: 'mcp',
    keyPrefix: 'cnry_aaaa',
    scopes: ['*'],
    readOnly: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('resolveEffectiveScope — MCP read-only auto-detection', () => {
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
