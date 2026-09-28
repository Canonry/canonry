import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  logQuerySchema,
  OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS,
  operationalLogEntryDtoSchema,
  operationalLogListDtoSchema,
  operationalLogListReadSchema,
  operationalLogLevelSchema,
} from '../src/operational-logs.js'
import { legacyOperationalLogPageSchema } from './fixtures/operational-logs-v1.js'

type JsonObject = Record<string, unknown>

function path(value: JsonObject, ...keys: string[]): JsonObject {
  return keys.reduce((node, key) => node[key] as JsonObject, value)
}

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

  test('carries the provider an entry came from, bounded like the other diagnostic names', () => {
    const entry = { cursor: 'cursor', ts: '2026-09-11T00:00:00.000Z', level: 'error', module: 'JobRunner', action: 'query.failed' }
    expect(operationalLogEntryDtoSchema.parse({ ...entry, context: { provider: 'claude' } }).context.provider).toBe('claude')
    expect(() => operationalLogEntryDtoSchema.parse({ ...entry, context: { provider: '' } })).toThrow()
    expect(() => operationalLogEntryDtoSchema.parse({ ...entry, context: { provider: 'x'.repeat(257) } })).toThrow()
  })

  test('a client reader drops keys a newer server adds, while the server contract still rejects them', () => {
    const known = { cursor: 'cursor', ts: '2026-09-11T00:00:00.000Z', level: 'error', module: 'JobRunner', action: 'query.failed' }
    const entry = { ...known, context: { runId: 'run_1', provider: 'claude', region: 'us-east' }, severityText: 'ERROR' }
    const page = {
      entries: [entry], nextCursor: null, truncated: 0, dropped: 0, retention: 'durable',
      retentionPolicy: { maxEntries: 10, maxAgeSeconds: 60, shards: 1 }, observedAt: '2026-09-11T00:00:01.000Z', region: 'us-east',
    }
    expect(operationalLogListReadSchema.parse(page)).toEqual({
      entries: [{ ...known, context: { runId: 'run_1', provider: 'claude' } }],
      nextCursor: null, truncated: 0, dropped: 0, retention: 'durable',
      retentionPolicy: { maxEntries: 10, maxAgeSeconds: 60 }, observedAt: '2026-09-11T00:00:01.000Z',
    })
    // The strict DTO is the redaction boundary: an unknown key is still refused.
    expect(() => operationalLogListDtoSchema.parse(page)).toThrow(/Unrecognized key/)
    expect(() => operationalLogEntryDtoSchema.parse({ ...known, context: { region: 'us-east' } })).toThrow(/Unrecognized key.*region/)
    // Known fields keep their bounds in the reader.
    expect(() => operationalLogListReadSchema.parse({ ...page, entries: [{ ...entry, context: { provider: '' } }] })).toThrow()
  })

  test('changes the page strict readers shipped with only by adding opt-in context fields', () => {
    // Adapters built before #1209 check every level of the page (keys, enum
    // values, bounds) and reject the whole page on anything this fixture does
    // not allow. Only a context field has an opt-in path (the fields header),
    // so any other widening, such as an entry or page key, a new level, or a
    // looser bound, fails here until it gets its own path to stay compatible.
    const shipped = z.toJSONSchema(legacyOperationalLogPageSchema) as JsonObject
    const current = z.toJSONSchema(operationalLogListDtoSchema) as JsonObject
    const contextPath = ['properties', 'entries', 'items', 'properties', 'context', 'properties']
    const context = path(current, ...contextPath)
    for (const field of OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS) {
      expect(context).toHaveProperty(field)
      expect(path(shipped, ...contextPath)).not.toHaveProperty(field)
      delete context[field]
    }
    expect(current).toEqual(shipped)
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
