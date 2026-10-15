import { expect, test } from 'vitest'
import { queryTrackingPreviewResponseSchema, type QueryTrackingPreviewResponse, type QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'

import { trackingChangeSummary, trackingReviewRows } from '../src/components/project/queries/tracking-review-model.js'
import { rows, workspace } from './support/tracked-action-fixtures.js'

const existing = rows.market.tracked
const added = { ...existing, queryId: 'q-new', queryText: 'new apartments uptown', normalizedText: 'new apartments uptown' }
const diffRow = (row: QueryTrackingTrackedRow, assignmentCount = row.assignments.length) => ({ queryId: row.queryId, queryText: row.queryText, assignmentCount })
const placement = (targetKeys: string[]) => ({ targetKeys, marketKeys: [] })
const detail = (row: QueryTrackingTrackedRow, change: 'added' | 'reused' | 'removed', overrides = {}) => ({ queryId: row.queryId, queryText: row.queryText, change, before: placement(['harbor']), after: placement(['harbor']), altered: true, ...overrides })

function preview(overrides: Partial<QueryTrackingPreviewResponse> = {}) {
  return queryTrackingPreviewResponseSchema.parse({
    mode: 'advanced', workspaceVersion: workspace.workspaceVersion, active: workspace.active,
    previewToken: `qtp_${'b'.repeat(64)}`, reviewedAt: '2026-10-15T12:00:00.000Z', tracked: [existing],
    diff: { added: [], reused: [], removed: [], unchanged: [], noOp: false },
    workload: { existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 1, nextSweepProviderCalls: 1, addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0 },
    ...overrides,
  })
}

test('a changed batch counts additions but leaves an unchanged match out of the publish total', () => {
  const review = preview({
    tracked: [existing, added],
    diff: { added: [diffRow(added)], reused: [diffRow(existing)], removed: [], unchanged: [], noOp: false },
    changes: [detail(added, 'added'), detail(existing, 'reused', { altered: false })],
  })
  const presented = trackingReviewRows(review, [existing])
  expect(presented.map(({ label, counted }) => ({ label, counted }))).toEqual([{ label: 'Added', counted: true }, { label: 'Already tracked', counted: false }])
  expect(trackingChangeSummary(presented)).toBe('1 added')
  expect(trackingChangeSummary(presented, true)).toBe('1 added · 1 already tracked')
})

test('a no-op explains the matched query without claiming a change', () => {
  const presented = trackingReviewRows(preview({ diff: { added: [], reused: [diffRow(existing)], removed: [], unchanged: [], noOp: true } }))
  expect(presented[0]).toMatchObject({ label: 'Already tracked', counted: false })
  expect(trackingChangeSummary(presented)).toBe('')
  expect(trackingChangeSummary(presented, true)).toBe('1 already tracked')
})

test('stopping retains the query while removal deletes it from the catalog', () => {
  const diff = { added: [], reused: [], removed: [diffRow(existing)], unchanged: [], noOp: false }
  expect(trackingReviewRows(preview({ diff, tracked: [{ ...existing, assignments: [] }] }))[0]).toMatchObject({ label: 'Stopped', counted: true })
  expect(trackingReviewRows(preview({ diff, tracked: [] }))[0]).toMatchObject({ label: 'Removed', counted: true })
})

test('rewording is one change even when its old query appears in the removal list', () => {
  const presented = trackingReviewRows(preview({
    tracked: [added], diff: { added: [diffRow(added)], reused: [], removed: [diffRow(existing)], unchanged: [], noOp: false },
    changes: [detail(added, 'added', { rewordedFrom: existing.queryId }), detail(existing, 'removed')],
  }), [existing])
  expect(presented.map(({ label, counted }) => ({ label, counted }))).toEqual([{ label: 'Reworded', counted: true }, { label: 'Removed', counted: false }])
  expect(trackingChangeSummary(presented)).toBe('1 reworded')
})

test('tracking a previously unasked query preserves its identity and explains reactivation', () => {
  const presented = trackingReviewRows(preview({
    diff: { added: [], reused: [diffRow(existing)], removed: [], unchanged: [], noOp: false },
    changes: [detail(existing, 'reused', { before: placement([]) })],
  }), [{ ...existing, assignments: [], focus: { kind: 'not-asked' } }])
  expect(presented[0]).toMatchObject({ row: { queryId: existing.queryId }, label: 'Added', wasNotAsked: true, counted: true })
})

test('a reused query names its changed Subject or Type from the before and after rows', () => {
  const before = { ...existing, focus: { kind: 'market' as const, key: 'uptown' }, queryClasses: ['non-brand' as const] }
  const diff = { added: [], reused: [diffRow(existing)], removed: [], unchanged: [], noOp: false }
  const changes = [detail(existing, 'reused')]
  expect(trackingReviewRows(preview({ diff, changes, tracked: [{ ...before, focus: { kind: 'property', key: 'harbor' }, queryClasses: ['branded'] }] }), [before])[0]?.label).toBe('Subject changed')
  expect(trackingReviewRows(preview({ diff, changes, tracked: [{ ...before, queryClasses: ['branded'] }] }), [before])[0]?.label).toBe('Type changed')
})
