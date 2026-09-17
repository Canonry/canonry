import { describe, expect, it, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { DEMO_CLI_COMMANDS } from '../src/cli-commands/demo.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { demoCommand, parseDemoListenOptions, parseDemoTrustedProxies } from '../src/commands/demo.js'

const demoServer = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../src/demo-server.js', () => ({ createDemoServer: demoServer.create }))

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const FORWARDED = '192.0.2.77'

/** The client address Fastify reports for a request from peer that claims FORWARDED. */
async function believedAddress(trustProxy: readonly string[], peer: string): Promise<string> {
  const app = Fastify({ trustProxy: [...trustProxy] })
  app.get('/', async request => request.ip)
  try {
    return (await app.inject({ url: '/', remoteAddress: peer, headers: { 'x-forwarded-for': FORWARDED } })).body
  } finally {
    await app.close()
  }
}

function ipv6Text(value: bigint): string {
  return Array.from({ length: 8 }, (_, group) => ((value >> BigInt((7 - group) * 16)) & 0xffffn).toString(16)).join(':')
}

// CIDR ranges covering every IPv6 address except the IPv4-mapped block ::ffff:0:0/96.
const everyIPv6RangeOutsideIPv4 = [
  ...Array.from({ length: 80 }, (_, bit) => `${ipv6Text(1n << BigInt(127 - bit))}/${bit + 1}`),
  ...Array.from({ length: 16 }, (_, index) => `${ipv6Text(((1n << BigInt(index)) - 1n) << BigInt(48 - index))}/${81 + index}`),
]
describe('demo listener options', () => {
  it('uses dedicated defaults rather than inherited production runtime settings', () => {
    vi.stubEnv('CANONRY_PORT', '4100')
    vi.stubEnv('CANONRY_HOST', 'production-host.example')
    vi.stubEnv('CANONRY_CONFIG_DIR', '/should-never-be-read')
    expect(parseDemoListenOptions({})).toEqual({ host: '127.0.0.1', port: 4188 })
  })
  it('accepts explicitly selected listener options', () => {
    expect(parseDemoListenOptions({ port: '4189', host: '0.0.0.0' })).toEqual({ host: '0.0.0.0', port: 4189 })
  })
  it.each(['0', '-1', '65536', '4.1', '4100junk', '1e3', ''])('rejects invalid port %s before starting a server', port => {
    expect(() => parseDemoListenOptions({ port })).toThrow()
  })
})

describe('demo command lifecycle', () => {
  it('reports readiness and removes signal handlers after closing a real listener', async () => {
    const app = Fastify()
    const listen = app.listen.bind(app)
    vi.spyOn(app, 'listen').mockImplementation(async () => listen({ host: '127.0.0.1', port: 0 }))
    demoServer.create.mockResolvedValue(app)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const interrupts = process.listenerCount('SIGINT')
    const terminations = process.listenerCount('SIGTERM')
    try {
      await expect(demoCommand({ format: 'json' })).resolves.toBeUndefined()
      expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ status: 'ready', mode: 'view-only' })
      expect(demoServer.create).toHaveBeenCalledWith({ trustProxy: ['127.0.0.1', '::1'] })
    } finally {
      await app.close()
    }
    expect(process.listenerCount('SIGINT')).toBe(interrupts)
    expect(process.listenerCount('SIGTERM')).toBe(terminations)
  })
})

describe('demo trusted proxies', () => {
  it('trusts only a reverse proxy on the same machine by default', () => {
    expect(parseDemoTrustedProxies(undefined)).toEqual(['127.0.0.1', '::1'])
    expect(parseDemoTrustedProxies([])).toEqual(['127.0.0.1', '::1'])
  })

  it('replaces the default with the named addresses and CIDR ranges', () => {
    const values = ['10.0.0.5', '10.0.1.0/24', '2001:db8::/32', '::ffff:10.0.0.9', '192.0.2.1/32', '::ffff:10.0.0.0/104', '64:ff9b::/96']
    expect(parseDemoTrustedProxies(values)).toEqual(values)
  })

  it('accepts only ranges under which Fastify still ignores a forwarded address from the open internet', async () => {
    const values = parseDemoTrustedProxies(['10.0.0.5', '10.0.1.0/24', '2001:db8::/32', '::ffff:10.0.0.9', '::ffff:10.0.0.0/104', '64:ff9b::/96'])
    for (const peer of ['203.0.113.9', '::ffff:203.0.113.9', '2600::9']) {
      expect(await believedAddress(values, peer), peer).toBe(peer)
    }
  })

  it.each([
    'proxy.example', 'loopback', '10.0.0.256', '10.0.0', '', ' 10.0.0.5', '10.0.0.5 ',
    '10.0.0.0/', '/8', '10.0.0.0/33', '10.0.0.0/08', '10.0.0.0/-1', '10.0.0.0/8/8', '10.0.0.0/8.0',
    '2001:db8::/129', 'fe80::1%eth0', '10.0.0.5,10.0.0.6',
  ])('refuses %j with a usage error before starting', value => {
    expect(() => parseDemoTrustedProxies([value])).toThrow(expect.objectContaining({
      code: 'INVALID_TRUST_PROXY',
      message: expect.stringContaining('--trust-proxy'),
    }))
  })

  it.each([
    { value: '0.0.0.0/0', scope: 'every IPv4 address' },
    { value: '::/0', scope: 'every address' },
    { value: '::ffff:0:0/96', scope: 'every IPv4 address' },
    { value: '::ffff:0.0.0.0/96', scope: 'every IPv4 address' },
    { value: '::/1', scope: 'every IPv4 address' },
    { value: '::/80', scope: 'every IPv4 address' },
    { value: '10.0.0.0/0', scope: 'every IPv4 address' },
  ])('refuses $value, which would let visitors pick their own address', async ({ value, scope }) => {
    expect(() => parseDemoTrustedProxies(['10.0.0.5', value])).toThrow(expect.objectContaining({
      code: 'INVALID_TRUST_PROXY',
      message: expect.stringContaining(`would trust ${scope}`),
    }))
    if (value.endsWith('/0')) return
    // Fastify matches an IPv4 visitor against an IPv6 range through its mapped form.
    for (const peer of ['100.64.0.9', '203.0.113.9']) expect(await believedAddress([value], peer), `${value} ${peer}`).toBe(FORWARDED)
  })

  it.each([
    { values: ['0.0.0.0/1', '128.0.0.0/1'], scope: 'every IPv4 address', peers: ['100.64.0.9', '203.0.113.9'] },
    { values: ['::ffff:0:0/97', '128.0.0.0/1'], scope: 'every IPv4 address', peers: ['100.64.0.9', '203.0.113.9'] },
    { values: [...everyIPv6RangeOutsideIPv4, '0.0.0.0/1', '128.0.0.0/1'], scope: 'every address', peers: ['203.0.113.9', '2600::9'] },
    { values: everyIPv6RangeOutsideIPv4, scope: 'every IPv6 address', peers: ['2600::9', '::9', 'fc00::9'] },
  ])('refuses ranges that together trust $scope', async ({ values, scope, peers }) => {
    for (const value of values) expect(parseDemoTrustedProxies([value])).toEqual([value])
    expect(() => parseDemoTrustedProxies(values)).toThrow(expect.objectContaining({
      code: 'INVALID_TRUST_PROXY',
      message: expect.stringContaining(`together would trust ${scope}`),
    }))
    for (const peer of peers) expect(await believedAddress(values, peer), `${peer}`).toBe(FORWARDED)
  })

  it('still ignores IPv4 visitors under a set that trusts every IPv6 address outside the IPv4 block', async () => {
    expect(await believedAddress(everyIPv6RangeOutsideIPv4, '203.0.113.9')).toBe('203.0.113.9')
  })
})

describe('demo command spec', () => {
  it('documents the repeatable proxy flag', () => {
    const [spec] = DEMO_CLI_COMMANDS
    expect(spec!.usage).toContain('[--trust-proxy <ip-or-cidr>]...')
    expect(spec!.help).toContain('--trust-proxy')
    expect(spec!.options?.['trust-proxy']).toEqual({ type: 'string', multiple: true })
  })

  it('passes every --trust-proxy value to the demo server', async () => {
    demoServer.create.mockReset()
    const app = Fastify()
    const listen = app.listen.bind(app)
    vi.spyOn(app, 'listen').mockImplementation(async () => listen({ host: '127.0.0.1', port: 0 }))
    demoServer.create.mockResolvedValue(app)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(dispatchRegisteredCommand(
        ['demo', '--trust-proxy', '10.0.0.5', '--trust-proxy', '2001:db8::/32'], 'json', DEMO_CLI_COMMANDS,
      )).resolves.toBe(true)
      expect(demoServer.create).toHaveBeenCalledWith({ trustProxy: ['10.0.0.5', '2001:db8::/32'] })
    } finally {
      await app.close()
    }
  })

  it('refuses an invalid --trust-proxy before creating a server', async () => {
    demoServer.create.mockReset()
    await expect(dispatchRegisteredCommand(
      ['demo', '--trust-proxy', '10.0.0.5', '--trust-proxy', 'proxy.example'], 'json', DEMO_CLI_COMMANDS,
    )).rejects.toMatchObject({ code: 'INVALID_TRUST_PROXY' })
    expect(demoServer.create).not.toHaveBeenCalled()
  })
})
