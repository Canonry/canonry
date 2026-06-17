import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKeyDto, ApiKeyListDto, CreatedApiKeyDto } from '@ainyc/canonry-contracts'

const mockListApiKeys = vi.fn()
const mockCreateApiKey = vi.fn()
const mockRevokeApiKey = vi.fn()
const mockGetApiKeySelf = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listApiKeys: mockListApiKeys,
    createApiKey: mockCreateApiKey,
    revokeApiKey: mockRevokeApiKey,
    getApiKeySelf: mockGetApiKeySelf,
  }),
}))

/** Capture console.log output (the human + json paths). */
function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return { logs, restore: () => { console.log = orig } }
}

/** Capture process.stdout.write (the jsonl path). */
function captureStdout(): { lines: () => string[]; restore: () => void } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  return { lines: () => buf.split('\n').filter(Boolean), restore: () => spy.mockRestore() }
}

const { listApiKeys, createApiKey, revokeApiKey, showApiKeySelf } = await import('../src/commands/keys.js')

const KEYS: ApiKeyDto[] = [
  {
    id: 'k1',
    name: 'default',
    keyPrefix: 'cnry_aaaa',
    scopes: ['*'],
    readOnly: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    lastUsedAt: '2026-05-30T00:00:00.000Z',
    revokedAt: null,
  },
  {
    id: 'k2',
    name: 'ci-bot',
    keyPrefix: 'cnry_bbbb',
    scopes: ['read'],
    readOnly: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: '2026-05-15T00:00:00.000Z',
  },
]

describe('key list', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders a table with NAME / PREFIX / SCOPES / STATUS columns', async () => {
    mockListApiKeys.mockResolvedValue({ keys: KEYS } satisfies ApiKeyListDto)
    const cap = captureLog()
    try {
      await listApiKeys(undefined)
    } finally {
      cap.restore()
    }
    const out = cap.logs.join('\n')
    expect(out).toContain('NAME')
    expect(out).toContain('PREFIX')
    expect(out).toContain('SCOPES')
    expect(out).toContain('STATUS')
    expect(out).toContain('default')
    expect(out).toContain('cnry_aaaa')
    expect(out).toContain('active')
    expect(out).toContain('ci-bot')
    expect(out).toContain('revoked')
    // Never leak a hash or plaintext in human output.
    expect(out).not.toContain('keyHash')
  })

  it('format=json prints the full envelope', async () => {
    mockListApiKeys.mockResolvedValue({ keys: KEYS } satisfies ApiKeyListDto)
    const cap = captureLog()
    try {
      await listApiKeys('json')
    } finally {
      cap.restore()
    }
    expect(JSON.parse(cap.logs.join(''))).toEqual({ keys: KEYS })
  })

  it('format=jsonl streams one key per line', async () => {
    mockListApiKeys.mockResolvedValue({ keys: KEYS } satisfies ApiKeyListDto)
    const cap = captureStdout()
    try {
      await listApiKeys('jsonl')
    } finally {
      cap.restore()
    }
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records).toHaveLength(2)
    expect(records.map(r => r.id)).toEqual(['k1', 'k2'])
  })

  it('empty list prints a friendly message', async () => {
    mockListApiKeys.mockResolvedValue({ keys: [] } satisfies ApiKeyListDto)
    const cap = captureLog()
    try {
      await listApiKeys(undefined)
    } finally {
      cap.restore()
    }
    expect(cap.logs.join('\n')).toMatch(/no api keys/i)
  })
})

describe('key create', () => {
  beforeEach(() => vi.clearAllMocks())

  const created: CreatedApiKeyDto = {
    id: 'k3',
    name: 'new-key',
    keyPrefix: 'cnry_cccc',
    scopes: ['*'],
    readOnly: false,
    createdAt: '2026-05-31T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    key: 'cnry_cccc1111222233334444555566667777',
  }

  it('prints the plaintext key AND the shown-once warning', async () => {
    mockCreateApiKey.mockResolvedValue(created)
    const cap = captureLog()
    try {
      await createApiKey({ name: 'new-key', format: undefined })
    } finally {
      cap.restore()
    }
    const out = cap.logs.join('\n')
    expect(out).toContain('cnry_cccc1111222233334444555566667777')
    expect(out).toMatch(/will not be shown again/i)
    expect(mockCreateApiKey).toHaveBeenCalledWith({ name: 'new-key' })
  })

  it('passes explicit scopes through to the API', async () => {
    mockCreateApiKey.mockResolvedValue({ ...created, scopes: ['read', 'keys.write'] })
    const cap = captureLog()
    try {
      await createApiKey({ name: 'new-key', scopes: ['read', 'keys.write'], format: undefined })
    } finally {
      cap.restore()
    }
    expect(mockCreateApiKey).toHaveBeenCalledWith({ name: 'new-key', scopes: ['read', 'keys.write'] })
  })

  it('format=json includes the plaintext key in the JSON', async () => {
    mockCreateApiKey.mockResolvedValue(created)
    const cap = captureLog()
    try {
      await createApiKey({ name: 'new-key', format: 'json' })
    } finally {
      cap.restore()
    }
    expect(JSON.parse(cap.logs.join(''))).toEqual(created)
  })

  it('--read-only mints a key with exactly the read scope', async () => {
    mockCreateApiKey.mockResolvedValue({ ...created, scopes: ['read'], readOnly: true })
    const cap = captureLog()
    try {
      await createApiKey({ name: 'reader', readOnly: true, format: undefined })
    } finally {
      cap.restore()
    }
    expect(mockCreateApiKey).toHaveBeenCalledWith({ name: 'reader', scopes: ['read'] })
  })

  it('--read-only combined with explicit --scope is a usage error', async () => {
    await expect(
      createApiKey({ name: 'reader', readOnly: true, scopes: ['keys.write'], format: undefined }),
    ).rejects.toThrow(/read-only/i)
    expect(mockCreateApiKey).not.toHaveBeenCalled()
  })
})

describe('key whoami', () => {
  beforeEach(() => vi.clearAllMocks())

  const self: ApiKeyDto = {
    id: 'k2',
    name: 'ci-bot',
    keyPrefix: 'cnry_bbbb',
    scopes: ['read'],
    readOnly: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    lastUsedAt: '2026-06-01T00:00:00.000Z',
    revokedAt: null,
  }

  it('renders the current key and its read-only status', async () => {
    mockGetApiKeySelf.mockResolvedValue(self)
    const cap = captureLog()
    try {
      await showApiKeySelf(undefined)
    } finally {
      cap.restore()
    }
    const out = cap.logs.join('\n')
    expect(out).toContain('ci-bot')
    expect(out).toContain('cnry_bbbb')
    expect(out).toMatch(/read-only/i)
    expect(out).not.toContain('keyHash')
    expect(mockGetApiKeySelf).toHaveBeenCalledTimes(1)
  })

  it('format=json prints the self DTO', async () => {
    mockGetApiKeySelf.mockResolvedValue(self)
    const cap = captureLog()
    try {
      await showApiKeySelf('json')
    } finally {
      cap.restore()
    }
    expect(JSON.parse(cap.logs.join(''))).toEqual(self)
  })
})

describe('key revoke', () => {
  beforeEach(() => vi.clearAllMocks())

  const revoked: ApiKeyDto = {
    id: 'k2',
    name: 'ci-bot',
    keyPrefix: 'cnry_bbbb',
    scopes: ['read'],
    readOnly: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: '2026-05-31T00:00:00.000Z',
  }

  it('confirms revocation in human output', async () => {
    mockRevokeApiKey.mockResolvedValue(revoked)
    const cap = captureLog()
    try {
      await revokeApiKey('k2', undefined)
    } finally {
      cap.restore()
    }
    expect(cap.logs.join('\n')).toMatch(/revoked/i)
    expect(mockRevokeApiKey).toHaveBeenCalledWith('k2')
  })

  it('format=json prints the revoked key DTO', async () => {
    mockRevokeApiKey.mockResolvedValue(revoked)
    const cap = captureLog()
    try {
      await revokeApiKey('k2', 'json')
    } finally {
      cap.restore()
    }
    expect(JSON.parse(cap.logs.join(''))).toEqual(revoked)
  })
})
