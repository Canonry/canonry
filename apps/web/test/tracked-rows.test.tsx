import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'
import { afterEach, expect, test } from 'vitest'
import { cleanup, screen } from '@testing-library/react'

import type { QueriesSectionProps } from '../src/components/project/DiscoverySection.js'
import { assignmentScopeLabel } from '../src/components/project/queries/tracked-rows.js'
import { installWorkspaceApi, noteButton, renderWorkspace, workspace as trackingWorkspace } from './support/query-tracking-fixtures.js'

afterEach(cleanup)

type Selection = NonNullable<QueriesSectionProps['selection']>

// Three locations: two in the North group and the North market, one in neither.
const workspace = {
  targets: [
    { stableKey: 'harbor', label: 'Harbor Point' },
    { stableKey: 'north', label: 'Northbridge' },
    { stableKey: 'south', label: 'South Quay' },
  ],
  groups: [{ stableKey: 'north-group', label: 'North', targetKeys: ['harbor', 'north'] }],
  markets: [{ stableKey: 'north-market', label: 'North metro', usageEdges: [] }],
} as unknown as QueryTrackingWorkspaceResponse

function row(targetKeys: readonly string[]): QueryTrackingTrackedRow {
  return {
    queryId: 'q',
    queryText: 'apartments near the harbor',
    assignments: targetKeys.map(targetKey => ({
      targetKey,
      groupKeys: targetKey === 'south' ? [] : ['north-group'],
      marketKeys: targetKey === 'south' ? [] : ['north-market'],
      queryClass: 'non-brand',
      contexts: [],
    })),
  } as unknown as QueryTrackingTrackedRow
}

function select(measurementScope: Selection['measurementScope'], measurementScopeKey?: string): Selection {
  return { measurementScope, measurementScopeKey, queryClass: 'all' } as Selection
}

// "Property" is the wire name for a location; the label a reader sees says location.
test('a group view counts the locations a query covers inside and outside the group', () => {
  expect(assignmentScopeLabel(row(['harbor', 'north', 'south']), workspace, select('group', 'north-group')))
    .toBe('2 locations in this group · Shared with 1 other location')
  expect(assignmentScopeLabel(row(['harbor']), workspace, select('group', 'north-group')))
    .toBe('1 location in this group')
  // Both other locations sit in a second group here, so the row is in North through one of three.
  const spread = row(['harbor', 'north', 'south'])
  spread.assignments[1]!.groupKeys = ['east-group']
  spread.assignments[2]!.groupKeys = ['east-group']
  expect(assignmentScopeLabel(spread, workspace, select('group', 'north-group')))
    .toBe('1 location in this group · Shared with 2 other locations')
})

test('a location view says whether the query is that location\'s alone', () => {
  expect(assignmentScopeLabel(row(['harbor']), workspace, select('property', 'harbor')))
    .toBe('This location only · Group: North · Market: North metro')
  expect(assignmentScopeLabel(row(['harbor', 'north']), workspace, select('property', 'harbor')))
    .toBe('This location · Shared with 1 other location · Group: North · Market: North metro')
  expect(assignmentScopeLabel(row(['harbor', 'north', 'south']), workspace, select('property', 'harbor')))
    .toBe('This location · Shared with 2 other locations · Group: North · Market: North metro')
})

test('a project view names one location and counts several', () => {
  expect(assignmentScopeLabel(row(['south']), workspace)).toBe('South Quay')
  expect(assignmentScopeLabel(row(['harbor', 'north', 'south']), workspace))
    .toBe('3 locations · Group: North · Market: North metro')
})

test('no label says property', () => {
  const selections = [undefined, select('project'), select('group', 'north-group'), select('property', 'harbor'), select('market', 'north-market')]
  for (const targetKeys of [['harbor'], ['harbor', 'north'], ['harbor', 'north', 'south']]) {
    for (const selection of selections) {
      expect(assignmentScopeLabel(row(targetKeys), workspace, selection)).not.toMatch(/propert/i)
    }
  }
})

// The earlier list draws these labels. A group view there carries one short note, with its sentence behind it.
test('the earlier list says location in a group view, with the shared-query rule behind a note', async () => {
  installWorkspaceApi(undefined, [], { ...trackingWorkspace(), mode: 'simple' })
  renderWorkspace({ selection: { measurementScope: 'group', measurementScopeKey: 'north-east', queryClass: 'all' } })

  expect(await screen.findByText('1 location in this group')).toBeTruthy()
  noteButton('Shared queries', 'Queries belong to locations, so a shared query can also cover other groups.')
  expect(screen.queryByText(/Queries belong to/)).toBeNull()
})
