import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseDemoListenOptions } from '../src/commands/demo.js'

afterEach(() => vi.unstubAllEnvs())
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
