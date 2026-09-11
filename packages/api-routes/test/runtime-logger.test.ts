import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { addLogListener, createFastifyLogger, createLogger } from '../src/runtime-logger.js'

afterEach(() => vi.restoreAllMocks())

describe('runtime logger', () => {
  it('retains sanitized custom logger messages', () => {
    const entries: Record<string, unknown>[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stop = addLogListener(entry => entries.push(entry))
    try {
      createLogger('Scheduler').error('skipped', { msg: 'missing source token=must-not-leak' })
      expect(entries[0]?.msg).toBe('missing source token=[REDACTED]')
    } finally { stop() }
  })

  it('honors level thresholds on the root logger and inherited child loggers', () => {
    const entries: Record<string, unknown>[] = []
    const stop = addLogListener(entry => entries.push(entry))
    try {
      const logger = createFastifyLogger({ enabled: false })
      logger.debug('below default')
      logger.level = 'warn'
      const child = logger.child({ component: 'child' })
      logger.info('below configured')
      child.info('below inherited')
      child.error('visible')
      child.level = 'silent'
      child.fatal('silent')
      expect(entries.map(entry => entry.msg)).toEqual(['visible'])
    } finally { stop() }
  })

  it('captures app, request, and child logs through one redacted path', async () => {
    const entries: Record<string, unknown>[] = []
    const stop = addLogListener(entry => entries.push(entry))
    const app = Fastify({ loggerInstance: createFastifyLogger({ enabled: false, module: 'HTTP' }) })
    app.get('/safe', async request => {
      request.log.child({ component: 'route', authorization: 'Bearer child-secret' }).warn({ token: 'nested-secret' }, 'child https://user:pass@example.test/?api_key=query-secret')
      return { ok: true }
    })
    app.log.error({ password: 'app-secret' }, 'app failed Bearer message-secret')

    await app.inject({ url: '/safe?token=access-secret', headers: { authorization: 'Bearer access-secret' } })
    await app.close()
    stop()
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toMatch(/app-secret|message-secret|child-secret|nested-secret|user:pass|query-secret|access-secret/)
    expect(serialized).not.toContain('"req":')
    expect(serialized).toContain('HTTP')
    expect(serialized).toContain('component')
  })

  it('preserves trusted identity and does not leak child bindings across requests', async () => {
    const entries: Record<string, unknown>[] = []
    const stop = addLogListener(entry => entries.push(entry))
    const app = Fastify({ loggerInstance: createFastifyLogger({ enabled: false }) })
    app.get('/:id', async request => {
      request.log.info({ reqId: 'spoofed-req', requestId: 'spoofed', actor: 'spoofed', credentialId: 'spoofed', marker: request.params }, 'request')
      return { ok: true }
    })
    await Promise.all([app.inject('/one'), app.inject('/two')])
    await app.close()
    stop()
    const matching = entries.filter(entry => entry.msg === 'request')
    expect(matching).toHaveLength(2)
    expect(matching.map(entry => entry.requestId)).not.toContain('spoofed')
    expect(matching.map(entry => entry.requestId)).not.toContain('spoofed-req')
    expect(matching.map(entry => JSON.stringify(entry.marker)).sort()).toEqual(['{"id":"one"}', '{"id":"two"}'])
  })

  it('shares sanitized output and capture, including malformed and circular inputs', () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true })
    const entries: Record<string, unknown>[] = []
    const stop = addLogListener(entry => entries.push(entry))
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => createLogger('Worker').error('run.failed', { authorization: 'Bearer output-secret', circular, url: 'https://user:pass@example.test/?token=truncated' })).not.toThrow()
    stop()
    const captured = JSON.stringify(entries)
    const output = writes.join('')
    expect(captured).not.toMatch(/output-secret|user:pass|truncated/)
    expect(output).not.toMatch(/output-secret|user:pass|truncated/)
    expect(output).toContain('"action":"run.failed"')
  })
})
