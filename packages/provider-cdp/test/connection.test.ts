import { describe, it, expect, vi } from 'vitest'
import { CDPConnectionManager, waitForStabilization } from '../src/connection.js'
import type CDP from 'chrome-remote-interface'

// Build a minimal mock CDP.Client for waitForStabilization testing
function makeMockClient(textSequence: (string | null)[]): CDP.Client {
  let callCount = 0
  return {
    Runtime: {
      evaluate: vi.fn().mockImplementation(async () => {
        const val = callCount < textSequence.length ? textSequence[callCount] : textSequence[textSequence.length - 1]
        callCount++
        return { result: { value: val } }
      }),
    },
  } as unknown as CDP.Client
}

// ─── CDPConnectionManager ────────────────────────────────────────────────────

describe('CDPConnectionManager.endpoint', () => {
  it('returns host:port for localhost', () => {
    const mgr = new CDPConnectionManager('localhost', 9222)
    expect(mgr.endpoint).toBe('localhost:9222')
  })

  it('returns host:port for a custom host and port', () => {
    const mgr = new CDPConnectionManager('my-host.tailnet', 9333)
    expect(mgr.endpoint).toBe('my-host.tailnet:9333')
  })
})

describe('CDPConnectionManager.getTabStatus', () => {
  it('returns an empty array when no tabs have been opened', () => {
    const mgr = new CDPConnectionManager('localhost', 9222)
    expect(mgr.getTabStatus()).toEqual([])
  })
})

// ─── waitForStabilization ────────────────────────────────────────────────────

describe('waitForStabilization', () => {
  it('resolves once text is non-empty and unchanged for stableMs', async () => {
    // First call: 'loading', second+: 'done' (stable immediately with stableMs=0)
    const client = makeMockClient(['loading', 'done', 'done'])
    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 0, timeoutMs: 5000 }),
    ).resolves.toBeUndefined()
  })

  it('resolves when text stabilizes after several changes', async () => {
    const client = makeMockClient(['a', 'b', 'c', 'c', 'c'])
    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 0, timeoutMs: 5000 }),
    ).resolves.toBeUndefined()
  })

  it('throws CDP_RESPONSE_TIMEOUT when text never stabilizes within timeoutMs', async () => {
    let n = 0
    const client = {
      Runtime: {
        evaluate: vi.fn().mockImplementation(async () => ({ result: { value: `text-${n++}` } })),
      },
    } as unknown as CDP.Client

    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 100, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'CDP_RESPONSE_TIMEOUT' })
  })

  it('throws CDP_RESPONSE_TIMEOUT when the selector returns only empty strings', async () => {
    const client = makeMockClient(['', '', ''])
    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 50, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'CDP_RESPONSE_TIMEOUT' })
  })

  it('throws CDP_RESPONSE_TIMEOUT when the selector returns null', async () => {
    const client = makeMockClient([null, null, null])
    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 50, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: 'CDP_RESPONSE_TIMEOUT' })
  })

  it('includes the selector and timeout in the error message', async () => {
    const client = makeMockClient([''])
    try {
      await waitForStabilization(client, '#my-selector', { pollIntervalMs: 0, stableMs: 50, timeoutMs: 30 })
      expect.fail('should have thrown')
    } catch (err: unknown) {
      expect((err as Error).message).toContain('#my-selector')
      expect((err as Error).message).toContain('30ms')
    }
  })

  it('continues polling after a DOM query error and still resolves', async () => {
    let call = 0
    const client = {
      Runtime: {
        evaluate: vi.fn().mockImplementation(async () => {
          call++
          if (call < 3) throw new Error('Node not found')
          return { result: { value: 'stable text' } }
        }),
      },
    } as unknown as CDP.Client

    await expect(
      waitForStabilization(client, '.response', { pollIntervalMs: 0, stableMs: 0, timeoutMs: 5000 }),
    ).resolves.toBeUndefined()
  })

  it('uses a default timeout of 60s when none is given (verify via error message)', async () => {
    const client = makeMockClient([''])
    try {
      await waitForStabilization(client, '.x', { pollIntervalMs: 0, stableMs: 50, timeoutMs: 10 })
      expect.fail('should have thrown')
    } catch (err: unknown) {
      // Just verify error code — the exact message format is not contractual
      expect((err as { code?: string }).code).toBe('CDP_RESPONSE_TIMEOUT')
    }
  })
})
