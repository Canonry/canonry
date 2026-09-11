import { afterEach, expect, it, vi } from 'vitest'
import { addLogListener, createLogger, type LogEntry } from '../src/logger.js'

afterEach(() => vi.restoreAllMocks())

it('redacts embedded URLs and complete authorization values from error diagnostics', () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const entries: LogEntry[] = []
  const stop = addLogListener(entry => entries.push(entry))
  try {
    createLogger('SafeLogger').error('request.failed', {
      error: new Error('Failed fetching https://user:fake-password@example.invalid/path?api_key=fake-query-secret&safe=yes'),
      responseBody: 'Authorization: Bearer fake-bearer-secret',
    })
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toMatch(/fake-password|fake-query-secret|fake-bearer-secret/)
    expect(serialized).toContain('example.invalid')
  } finally { stop() }
})
