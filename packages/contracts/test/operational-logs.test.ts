import { describe, expect, test } from 'vitest'
import {
  logQuerySchema,
  operationalLogEntryDtoSchema,
  operationalLogListDtoSchema,
  operationalLogLevelSchema,
} from '../src/operational-logs.js'

describe('operational log contracts', () => {
  test('accepts all runtime logger levels and safe durable identity fields', () => {
    expect(operationalLogLevelSchema.options).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    expect(operationalLogEntryDtoSchema.parse({
      cursor: 'cursor', ts: '2026-09-11T00:00:00.000Z', level: 'fatal', module: 'worker', action: 'job.failed',
      message: 'safe message', context: {
        actor: 'scheduler', credentialId: 'key_123', userAgent: 'canonry-cli/1.0', actorSession: 'session_123',
      },
    }).message).toBe('safe message')
  })

  test('validates bounded query identities and an ordered ISO range', () => {
    expect(logQuerySchema.parse({
      actor: 'scheduler', requestId: 'request_123', since: '2026-09-10T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z',
    })).toMatchObject({ actor: 'scheduler', requestId: 'request_123', limit: 100 })
    expect(() => logQuerySchema.parse({ since: '2026-09-12T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' })).toThrow()
    expect(() => logQuerySchema.parse({ stack: 'nope' })).toThrow()
  })

  test('keeps process-buffer results valid while allowing durable loss metadata', () => {
    expect(operationalLogListDtoSchema.parse({
      entries: [], nextCursor: null, truncated: 0, dropped: 2, retention: 'durable',
      retentionPolicy: { maxEntries: 10_000, maxAgeSeconds: 604_800 }, captureErrors: 1,
      observedAt: '2026-09-11T00:00:00.000Z',
    }).retentionPolicy?.maxEntries).toBe(10_000)
    expect(operationalLogListDtoSchema.parse({
      entries: [], nextCursor: null, truncated: 0, dropped: 0, retention: 'process',
      observedAt: '2026-09-11T00:00:00.000Z',
    }).captureErrors).toBeUndefined()
  })
})
