import { describe, expect, it } from 'vitest'
import { replayQueryAuditLog, activeQueriesAt } from '../src/commands/backfill.js'

/**
 * Pure-function tests for the audit-log replay logic that drives
 * `cnry backfill snapshot-attribution`. The recovery's correctness
 * depends on accurately reconstructing the historical query set at
 * each run timestamp, so these cases pin the replay's handling of
 * every event the queries routes emit.
 */
describe('replayQueryAuditLog', () => {
  it('append events accumulate active queries in insertion order', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q1', 'q2'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q3'] }) },
    ])
    expect(history).toEqual([
      { text: 'q1', addedAt: '2026-01-01T00:00:00Z', deletedAt: null },
      { text: 'q2', addedAt: '2026-01-01T00:00:00Z', deletedAt: null },
      { text: 'q3', addedAt: '2026-01-02T00:00:00Z', deletedAt: null },
    ])
  })

  it('delete events mark the latest matching entry as deleted (LIFO)', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['shared', 'unique'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.deleted', diff: JSON.stringify({ deleted: ['unique'] }) },
      { createdAt: '2026-01-03T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['shared'] }) }, // re-add same text
      { createdAt: '2026-01-04T00:00:00Z', action: 'queries.deleted', diff: JSON.stringify({ deleted: ['shared'] }) }, // deletes the re-added one
    ])
    expect(history).toEqual([
      { text: 'shared', addedAt: '2026-01-01T00:00:00Z', deletedAt: null }, // first 'shared' survives
      { text: 'unique', addedAt: '2026-01-01T00:00:00Z', deletedAt: '2026-01-02T00:00:00Z' },
      { text: 'shared', addedAt: '2026-01-03T00:00:00Z', deletedAt: '2026-01-04T00:00:00Z' },
    ])
  })

  it('queries.replaced ends all current entries and starts new ones at the same timestamp', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['old1', 'old2'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.replaced', diff: JSON.stringify({ queries: ['new1', 'new2'] }) },
    ])
    expect(history).toEqual([
      { text: 'old1', addedAt: '2026-01-01T00:00:00Z', deletedAt: '2026-01-02T00:00:00Z' },
      { text: 'old2', addedAt: '2026-01-01T00:00:00Z', deletedAt: '2026-01-02T00:00:00Z' },
      { text: 'new1', addedAt: '2026-01-02T00:00:00Z', deletedAt: null },
      { text: 'new2', addedAt: '2026-01-02T00:00:00Z', deletedAt: null },
    ])
  })

  it('handles both legacy keywords.* and current queries.* action names', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'keywords.appended', diff: JSON.stringify({ added: ['k1'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q1'] }) },
      { createdAt: '2026-01-03T00:00:00Z', action: 'keywords.deleted', diff: JSON.stringify({ deleted: ['k1'] }) },
    ])
    expect(history.map(e => ({ text: e.text, deleted: e.deletedAt !== null }))).toEqual([
      { text: 'k1', deleted: true },
      { text: 'q1', deleted: false },
    ])
  })

  it('ignores events with malformed or missing diff', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q1'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.appended', diff: null },
      { createdAt: '2026-01-03T00:00:00Z', action: 'queries.appended', diff: 'not-json' },
      { createdAt: '2026-01-04T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({}) },
    ])
    expect(history).toEqual([
      { text: 'q1', addedAt: '2026-01-01T00:00:00Z', deletedAt: null },
    ])
  })
})

describe('activeQueriesAt', () => {
  it('returns queries whose lifetime spans the requested timestamp, in insertion order', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q1', 'q2'] }) },
      { createdAt: '2026-01-05T00:00:00Z', action: 'queries.deleted', diff: JSON.stringify({ deleted: ['q1'] }) },
      { createdAt: '2026-01-10T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q3'] }) },
    ])
    expect(activeQueriesAt(history, '2026-01-03T00:00:00Z')).toEqual(['q1', 'q2']) // before q1 delete, after q3 add
    expect(activeQueriesAt(history, '2026-01-07T00:00:00Z')).toEqual(['q2']) // after q1 delete, before q3 add
    expect(activeQueriesAt(history, '2026-01-15T00:00:00Z')).toEqual(['q2', 'q3']) // after q3 add
    expect(activeQueriesAt(history, '2025-12-31T00:00:00Z')).toEqual([]) // before any add
  })

  it('treats the deletedAt timestamp as exclusive (a query swept AT its delete time is NOT active)', () => {
    // Edge case: a sweep started exactly when a query was deleted. The
    // sweep ran *after* the delete event committed, so the query isn't
    // in the basket — the snapshot belongs to the post-delete state.
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['q1'] }) },
      { createdAt: '2026-01-05T00:00:00Z', action: 'queries.deleted', diff: JSON.stringify({ deleted: ['q1'] }) },
    ])
    expect(activeQueriesAt(history, '2026-01-05T00:00:00Z')).toEqual([])
  })

  it('preserves insertion order across mixed append/delete events', () => {
    const history = replayQueryAuditLog([
      { createdAt: '2026-01-01T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['a', 'b', 'c'] }) },
      { createdAt: '2026-01-02T00:00:00Z', action: 'queries.deleted', diff: JSON.stringify({ deleted: ['b'] }) },
      { createdAt: '2026-01-03T00:00:00Z', action: 'queries.appended', diff: JSON.stringify({ added: ['d'] }) },
    ])
    // Active at end: a, c, d — in original insertion order minus 'b'.
    expect(activeQueriesAt(history, '2026-01-04T00:00:00Z')).toEqual(['a', 'c', 'd'])
  })
})
