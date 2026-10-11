import { afterEach, describe, expect, it } from 'vitest'
import { probeApiHost, resetApiHostProbeCacheForTest } from '../src/api-host-probe.js'

afterEach(() => resetApiHostProbeCacheForTest())

describe('probeApiHost', () => {
  it.each(['0.0.0.0', '0.1.2.3', '0.255.255.255', '::', '127.0.0.1'])('does not dial null-routed address %s', async address => {
    let connects = 0
    const result = await probeApiHost('provider.example', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], connect: async () => { connects++; return 'reachable' } })
    expect(result.kind).toBe('null-routed')
    expect(connects).toBe(0)
  })

  it('does not dial private addresses', async () => {
    let connects = 0
    const result = await probeApiHost('provider.example', { lookup: async () => [{ address: '10.0.0.5', family: 4 }], connect: async () => { connects++; return 'reachable' } })
    expect(result.kind).toBe('private-address')
    expect(connects).toBe(0)
  })

  it('maps resolver errors and dials public mixed answers only', async () => {
    const noAddress = await probeApiHost('missing.example', { lookup: async () => { throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' }) } })
    expect(noAddress.kind).toBe('no-address')
    const dialed: string[] = []
    const mixed = await probeApiHost('mixed.example', {
      lookup: async () => [{ address: '0.0.0.0', family: 4 }, { address: '192.0.2.10', family: 4 }],
      connect: async (_host, address) => { dialed.push(address); return 'reachable' },
    })
    expect(mixed.kind).toBe('reachable')
    expect(dialed).toEqual(['192.0.2.10'])
  })

  it('skips when the resolver is unavailable or misses the deadline', async () => {
    const unavailable = await probeApiHost('retry.example', { lookup: async () => { throw Object.assign(new Error('again'), { code: 'EAI_AGAIN' }) } })
    expect(unavailable.kind).toBe('resolver-unavailable')
    const deadline = await probeApiHost('slow.example', { timeoutMs: 1, lookup: async () => new Promise(() => undefined) })
    expect(deadline.kind).toBe('resolver-unavailable')
  })

  it('reports TLS and connection failures and caches successful probes', async () => {
    let calls = 0
    const options = { lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: async () => { calls++; return 'tls-failed' as const } }
    expect((await probeApiHost('tls.example', options)).kind).toBe('tls-failed')
    expect((await probeApiHost('tls.example', options)).kind).toBe('tls-failed')
    expect(calls).toBe(1)
    expect((await probeApiHost('refused.example', { lookup: options.lookup, connect: async () => 'connect-failed' })).kind).toBe('connect-failed')
    let now = 0
    let lookups = 0
    const ttlOptions = { now: () => now, lookup: async () => { lookups++; return [{ address: '192.0.2.11', family: 4 }] }, connect: async () => 'reachable' as const }
    await probeApiHost('ttl.example', ttlOptions)
    await probeApiHost('ttl.example', ttlOptions)
    expect(lookups).toBe(1)
    now = 5 * 60_000 + 1
    await probeApiHost('ttl.example', ttlOptions)
    expect(lookups).toBe(2)
  })

  it.each(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'] as const)('grades certificate error %s as TLS failure without an HTTP dial', async code => {
    let tlsAttempts = 0
    const result = await probeApiHost(`tls-${code}.example`, {
      lookup: async () => [{ address: '192.0.2.30', family: 4 }],
      connect: async () => {
        tlsAttempts++
        throw Object.assign(new Error(code), { code })
      },
    })
    expect(result.kind).toBe('tls-failed')
    expect(tlsAttempts).toBe(1)
  })

  it('coalesces concurrent probes before applying the cache', async () => {
    let lookups = 0
    let connects = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const options = {
      lookup: async () => { lookups++; await gate; return [{ address: '192.0.2.20', family: 4 }] },
      connect: async () => { connects++; return 'reachable' as const },
    }
    const first = probeApiHost('concurrent.example', options)
    const second = probeApiHost('concurrent.example', options)
    release!()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'reachable', host: 'concurrent.example', addresses: ['192.0.2.20'], durationMs: expect.any(Number) },
      { kind: 'reachable', host: 'concurrent.example', addresses: ['192.0.2.20'], durationMs: expect.any(Number) },
    ])
    expect(lookups).toBe(1)
    expect(connects).toBe(1)
  })
})
