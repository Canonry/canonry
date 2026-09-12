import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { createClient, migrate, OperationalLogStore } from '@ainyc/canonry-db'
import { addLogListener, createLogger } from '../src/logger.js'

describe('operational logging', () => {
  afterEach(() => vi.restoreAllMocks())

  test('redacts nested secrets and URLs while preserving safe diagnostic metadata', () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    const received: unknown[] = []
    const remove = addLogListener(entry => received.push(entry))
    const cycle: Record<string, unknown> = { cookie: 'session=do-not-leak' }
    cycle.self = cycle
    const error = new Error('upstream rejected token=do-not-leak')
    ;(error as Error & { apiKey: string }).apiKey = 'sk-do-not-leak'

    createLogger('Worker').error('run.failed', {
      ts: 'attacker timestamp', level: 'info', module: 'attacker', action: 'attacker.action',
      runId: 'run_safe', projectId: 'project_safe', count: 3, retriable: true,
      authorization: 'Bearer do-not-leak', nested: { password: 'do-not-leak', error },
      url: 'https://user:pass@example.test/path?access_token=do-not-leak&keep=safe', cycle,
      responseBody: 'x'.repeat(20_000),
    })
    remove()

    const output = `${writes.join('')}\n${JSON.stringify(received)}`
    expect(output).not.toContain('do-not-leak')
    expect(output).not.toContain('user:pass')
    expect(output).toContain('run_safe')
    expect(output).toContain('project_safe')
    expect(output).toContain('"module":"Worker"')
    expect(output).toContain('"action":"run.failed"')
  })

  test('listener errors never interrupt console logging and can be unsubscribed', () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    const broken = addLogListener(() => { throw new Error('listener failure') })
    const seen: string[] = []
    const remove = addLogListener(entry => seen.push(entry.action))
    const logger = createLogger('Scheduler')

    expect(() => logger.info('schedule.tick')).not.toThrow()
    remove()
    logger.info('schedule.complete')
    broken()

    expect(seen).toEqual(['schedule.tick'])
    expect(writes).toHaveLength(2)
  })
})

describe('OperationalLogStore', () => {
  test('filters before pagination, bounds retention, and rejects stale cursors', () => {
    const db = createClient(':memory:')
    migrate(db)
    onTestFinished(() => db.$client.close())
    const buffer = new OperationalLogStore(db, { maxEntries: 2, now: () => new Date('2026-09-11T00:00:03.000Z'), retention: 'process' })
    buffer.append({ ts: '2026-09-11T00:00:00.000Z', level: 'info', module: 'Runner', action: 'run.start', runId: 'run_1', projectId: 'project_1', msg: 'not for API', query: 'never expose this' })
    buffer.append({ ts: '2026-09-11T00:00:01.000Z', level: 'warn', module: 'Runner', action: 'run.retry', runId: 'run_2', projectId: 'project_1', errorCode: 'RATE_LIMIT', url: 'https://private.example' })
    const first = buffer.list({ limit: 1, module: 'Runner' })
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({ runId: 'run_1', context: { runId: 'run_1', projectId: 'project_1' } })
    expect(first.entries[0]).not.toHaveProperty('msg')
    expect(first.entries[0]).not.toHaveProperty('query')
    expect(first.nextCursor).toBeTruthy()

    const second = buffer.list({ limit: 1, module: 'Runner', cursor: first.nextCursor! })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0]).toMatchObject({ runId: 'run_2', context: { errorCode: 'RATE_LIMIT' } })
    expect(second.nextCursor).toBeNull()

    buffer.append({ ts: '2026-09-11T00:00:02.000Z', level: 'error', module: 'Other', action: 'run.failed', runId: 'run_3' })
    expect(() => buffer.list({ limit: 1, module: 'Runner', cursor: first.nextCursor! })).toThrow(/stale/i)
    expect(() => buffer.list({ limit: 201 })).toThrow()
    expect(() => buffer.list({ limit: 1, cursor: 'wrong-buffer:1' })).toThrow(/cursor/i)
  })
})
