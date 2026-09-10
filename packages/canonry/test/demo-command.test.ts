import { describe, expect, it, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { demoCommand, parseDemoListenOptions } from '../src/commands/demo.js'

const demoServer = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../src/demo-server.js', () => ({ createDemoServer: demoServer.create }))

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
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
    } finally {
      await app.close()
    }
    expect(process.listenerCount('SIGINT')).toBe(interrupts)
    expect(process.listenerCount('SIGTERM')).toBe(terminations)
  })
})
