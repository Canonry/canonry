import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  AdvancedMeasurementGroupsStep,
  AdvancedMeasurementQueriesStep,
  AdvancedMeasurementReviewStep,
  type AdvancedMeasurementGroup,
  type AdvancedMeasurementGroupDraft,
  type AdvancedMeasurementProperty,
  type AdvancedMeasurementQuery,
} from '../src/components/project/advanced-measurement/SetupQueriesGroupsReview.js'

afterEach(cleanup)

const properties: AdvancedMeasurementProperty[] = [
  { id: 'harbor-house', label: 'Harbor House', urlCount: 4 },
  { id: 'north-hall', label: 'North Hall', urlCount: 2 },
]

const manyProperties: AdvancedMeasurementProperty[] = Array.from({ length: 55 }, (_, index) => ({
  id: `property-${index + 1}`,
  label: `Property ${index + 1}`,
  urlCount: 1,
}))

const manyQueries: AdvancedMeasurementQuery[] = Array.from({ length: 55 }, (_, index) => ({
  id: `query-${index + 1}`,
  text: `Service query ${index + 1}`,
  source: 'saved-project-queries',
}))

const queries: AdvancedMeasurementQuery[] = [
  {
    id: 'q-saved',
    text: 'Harbor House events',
    source: 'saved-project-queries',
    assignmentClass: 'branded',
    propertyIds: ['harbor-house'],
  },
  {
    id: 'q-set',
    text: 'event spaces near me',
    source: 'query-sets',
    assignmentClass: 'non-brand',
    sourceDetail: 'Event planning',
    propertyIds: ['north-hall'],
  },
  {
    id: 'q-draft',
    text: 'Harbor House private events',
    source: 'generated-drafts-from-templates',
    assignmentClass: 'branded',
    sourceDetail: 'Private event template',
  },
  {
    id: 'q-unclassified',
    text: 'private event venue',
    source: 'saved-project-queries',
  },
]

const groupDraft: AdvancedMeasurementGroupDraft = {
  name: 'Waterfront venues',
  propertyIds: ['harbor-house'],
  competitorDomains: 'rival.example',
}

const emptyGroupDraft: AdvancedMeasurementGroupDraft = {
  name: '',
  propertyIds: [],
  competitorDomains: '',
}

const groups: AdvancedMeasurementGroup[] = [{
  id: 'waterfront-venues',
  name: 'Waterfront venues',
  propertyIds: ['harbor-house'],
  competitors: ['rival.example'],
}]

function renderQueries(overrides: Partial<ComponentProps<typeof AdvancedMeasurementQueriesStep>> = {}) {
  const props = {
    properties,
    queries,
    selectedQueryIds: ['q-saved'],
    onSelectedQueryIdsChange: vi.fn(),
    onApplySelectedQueries: vi.fn(),
    onRemoveQuery: vi.fn(),
    groups: [],
    audience: { kind: 'all' as const },
    onAudienceChange: vi.fn(),
    assignmentImpact: {
      assignmentCount: 2,
      addedAssignments: 2,
      alreadyPresentAssignments: 0,
      resolvedPropertyCount: 2,
      overlapCount: 0,
      addedProviderCalls: 2,
      fullRunProviderCalls: 2,
    },
    onBack: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementQueriesStep {...props} />), props }
}

function renderGroups(overrides: Partial<ComponentProps<typeof AdvancedMeasurementGroupsStep>> = {}) {
  const props = {
    properties,
    groups,
    groupDraft,
    onGroupDraftChange: vi.fn(),
    onSaveGroup: vi.fn(),
    onBack: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementGroupsStep {...props} />), props }
}

function renderReview(overrides: Partial<ComponentProps<typeof AdvancedMeasurementReviewStep>> = {}) {
  const props = {
    counts: { properties: 2, queries: 3, groups: 1 },
    flaggedExceptions: [{ id: 'missing-url', title: 'A URL needs review', detail: 'Harbor House has one unmatched URL.' }],
    canPublish: true,
    onBack: vi.fn(),
    onPublish: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdvancedMeasurementReviewStep {...props} />), props }
}

test('uses Queries without exposing source taxonomy or assignment mechanics', () => {
  const view = renderQueries({ onCreateQueries: vi.fn() })

  expect(screen.getByRole('heading', { name: 'Queries' })).toBeTruthy()
  expect(screen.getAllByText('Add queries').find(element => element.tagName === 'SUMMARY')?.closest('details')?.open).toBe(false)
  expect(screen.queryByText('Saved project queries')).toBeNull()
  expect(screen.queryByText('Query sets')).toBeNull()
  expect(screen.queryByText('Generated drafts from templates')).toBeNull()
  expect(screen.queryByText('Assignment class')).toBeNull()
  expect(screen.queryByText('Needs classification')).toBeNull()
  expect(view.container.textContent?.toLowerCase()).not.toContain('competitor')
})

test('opens Query creation only when the library is empty', () => {
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries: vi.fn() })

  expect(screen.getAllByText('Add queries').find(element => element.tagName === 'SUMMARY')?.closest('details')?.open).toBe(true)
})

test('shows Property scope before dependent query patterns and previews cross-product impact', () => {
  const { props } = renderQueries({ onCreateQueries: vi.fn() })
  const scope = screen.getByLabelText('Apply to').closest('fieldset')
  const creation = screen.getAllByText('Add queries').find(element => element.tagName === 'SUMMARY')?.closest('details')

  expect(scope?.compareDocumentPosition(creation!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(screen.getByText(/2 new, 0 already assigned/)).toBeTruthy()
  const apply = screen.getByRole('button', { name: 'Assign 1 query to all 2 Properties' })
  expect(apply.className).toContain('min-h-11')
  expect(apply.className).toContain('bg-accent')
  expect(screen.getByRole('button', { name: 'Continue' }).className).toContain('border')
  fireEvent.click(apply)
  expect(props.onApplySelectedQueries).toHaveBeenCalledWith({
    queryIds: ['q-saved'],
    propertyIds: ['harbor-house', 'north-hall'],
  })
})

test('clears an individual query assignment with explicit wording', () => {
  const { props } = renderQueries()

  fireEvent.click(screen.getByRole('button', { name: 'Clear query assignments for Harbor House events' }))

  expect(props.onRemoveQuery).toHaveBeenCalledWith('q-saved')
})

test('offers an inline query text editor without replacing assignment controls', () => {
  const onEditQuery = vi.fn()
  const onValueChange = vi.fn()
  const { props } = renderQueries({
    onEditQuery,
    queryEditor: {
      originalValue: 'Harbor House events',
      value: 'Harbor House events',
      assignedPropertyLabels: ['Harbor House'],
      onValueChange,
      onSave: vi.fn(),
    },
  })

  fireEvent.click(screen.getByRole('button', { name: 'Edit query Harbor House events' }))
  expect(onEditQuery).toHaveBeenCalledWith('q-saved')
  expect((screen.getByLabelText('Query text') as HTMLInputElement).value).toBe('Harbor House events')
  expect(screen.getByText('1 Property assigned')).toBeTruthy()
  expect(screen.getByText('View assigned Properties')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save to draft' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'Harbor House event space' } })
  expect(onValueChange).toHaveBeenCalledWith('Harbor House event space')
  expect(props.onRemoveQuery).not.toHaveBeenCalled()
})

test('does not expose draft query editing to a viewer', () => {
  renderQueries({
    access: 'viewer',
    queryEditor: {
      originalValue: 'Harbor House events',
      value: 'Harbor House events',
      assignedPropertyLabels: ['Harbor House'],
      onValueChange: vi.fn(),
      onSave: vi.fn(),
    },
    onEditQuery: vi.fn(),
  })

  expect(screen.queryByLabelText('Query text')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit query Harbor House events' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull()
})

test('does not offer a draft save for a normalized wording no-op', () => {
  renderQueries({
    queryEditor: {
      originalValue: 'Harbor House events',
      value: '  HARBOR HOUSE EVENTS  ',
      assignedPropertyLabels: ['Harbor House'],
      onValueChange: vi.fn(),
      onSave: vi.fn(),
    },
  })
  expect(screen.getByRole('button', { name: 'Save to draft' })).toHaveProperty('disabled', true)
})

test('offers an explicit replacement editor for an already assigned query', () => {
  const onReplaceAssignments = vi.fn()
  renderQueries({ onReplaceAssignments })

  fireEvent.click(screen.getByRole('button', { name: 'Replace query assignments for Harbor House events' }))
  expect(screen.getByRole('heading', { name: 'Replace assigned Properties' })).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Clear selection' }).at(-1)!)
  fireEvent.click(screen.getAllByLabelText('Select North Hall').at(-1)!)
  fireEvent.click(screen.getByRole('button', { name: 'Replace with 1 Property' }))
  expect(onReplaceAssignments).toHaveBeenCalledWith({ queryId: 'q-saved', propertyIds: ['north-hall'] })
})

test('keeps a missing tracked query visible only for clearing its assignments', () => {
  const missingQuery: AdvancedMeasurementQuery = {
    id: 'q-missing',
    text: 'Removed event query',
    source: 'unavailable-tracked-query',
    state: 'missing',
    propertyIds: ['harbor-house'],
  }
  const { props } = renderQueries({
    queries: [missingQuery],
    selectedQueryIds: [],
  })

  expect(screen.getAllByText('Unavailable tracked query').length).toBeGreaterThan(0)
  expect(screen.queryByLabelText('Select query Removed event query')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear query assignments for Unavailable tracked query' }))
  expect(props.onRemoveQuery).toHaveBeenCalledWith('q-missing')
})

test('supports bulk query selection through the live audience control', () => {
  const { props } = renderQueries()

  expect((screen.getByLabelText('Apply to') as HTMLSelectElement).value).toBe('all')
  expect(screen.queryByText('Specific Properties')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown queries' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenCalledWith(queries.map(query => query.id))
  fireEvent.click(screen.getByRole('button', { name: 'Clear query selection' }))
  expect(props.onSelectedQueryIdsChange).toHaveBeenLastCalledWith([])
})

test('uses one audience control for all Properties, groups, and the Specific Properties escape hatch', () => {
  const onAudienceChange = vi.fn()
  const onApplySelectedQueries = vi.fn()
  const metroGroups: AdvancedMeasurementGroup[] = [
    ...groups,
    { id: 'downtown', name: 'Downtown', propertyIds: ['north-hall'], competitors: [] },
  ]
  renderQueries({
    groups: metroGroups,
    audience: { kind: 'groups', groupIds: ['waterfront-venues'] },
    onAudienceChange,
    onApplySelectedQueries,
    assignmentImpact: {
      assignmentCount: 1,
      addedAssignments: 1,
      alreadyPresentAssignments: 0,
      resolvedPropertyCount: 1,
      overlapCount: 0,
      addedProviderCalls: 2,
      fullRunProviderCalls: 4,
    },
  })

  expect((screen.getByLabelText('Apply to') as HTMLSelectElement).value).toBe('group:waterfront-venues')
  expect(screen.getByText('1 query → 1 Property assignment · 1 new, 0 already assigned · 4 provider requests per full run · 2 new · 1 unique Property. Existing assignments stay in place.')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Add another group'), { target: { value: 'downtown' } })
  expect(onAudienceChange).toHaveBeenLastCalledWith({ kind: 'groups', groupIds: ['waterfront-venues', 'downtown'] })
  fireEvent.click(screen.getByRole('button', { name: 'Assign 1 query to Waterfront venues' }))
  expect(onApplySelectedQueries).toHaveBeenCalledWith({
    queryIds: ['q-saved'],
    propertyIds: ['harbor-house'],
    groupIds: ['waterfront-venues'],
  })
})

test('shows zero new provider requests when the execution nodes are already reused', () => {
  renderQueries({
    groups,
    audience: { kind: 'groups', groupIds: ['waterfront-venues'] },
    assignmentImpact: {
      assignmentCount: 1,
      addedAssignments: 0,
      alreadyPresentAssignments: 1,
      resolvedPropertyCount: 1,
      overlapCount: 0,
      addedProviderCalls: 0,
      fullRunProviderCalls: 4,
    },
  })

  expect(screen.getByText('1 query → 1 Property assignment · 0 new, 1 already assigned · 4 provider requests per full run · 0 new · 1 unique Property. Existing assignments stay in place.')).toBeTruthy()
})

test('keeps selected queries visible and disables assignment when the server impact cannot be calculated', () => {
  const onRetryAssignmentImpact = vi.fn()
  const view = renderQueries({
    audience: { kind: 'all' },
    onAudienceChange: vi.fn(),
    assignmentImpact: null,
    assignmentImpactError: 'Could not calculate assignment impact.',
    onRetryAssignmentImpact,
  })

  expect(screen.getByRole('alert').textContent).toContain('Could not calculate assignment impact.')
  expect(screen.getByRole('button', { name: 'Assign 1 query to all 2 Properties' })).toHaveProperty('disabled', true)
  expect((screen.getByLabelText('Select query Harbor House events') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry impact' }))
  expect(onRetryAssignmentImpact).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Back to Groups' }))
  expect(view.props.onBack).toHaveBeenCalledTimes(1)
})

test('keeps a large query library searchable, capped, and explicit about bulk selection', () => {
  const view = renderQueries({ queries: manyQueries, selectedQueryIds: [] })

  expect(screen.getByText(/Showing 50 of 55 queries/)).toBeTruthy()
  expect(screen.queryByLabelText('Select query Service query 51')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown queries' }))
  expect(view.props.onSelectedQueryIdsChange).toHaveBeenCalledWith(manyQueries.slice(0, 50).map(query => query.id))

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: 'Service query 55' } })
  expect(screen.getByText(/Showing 1 of 1 queries/)).toBeTruthy()
  expect(screen.getByLabelText('Select query Service query 55')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search queries' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show all queries' }))
  expect(screen.getByText(/Showing 55 of 55 queries/)).toBeTruthy()
  expect(screen.getByLabelText('Select query Service query 51')).toBeTruthy()
})

test('makes the query Property picker searchable and bounded for large portfolios', () => {
  const onAudienceChange = vi.fn()
  const view = renderQueries({
    properties: manyProperties,
    selectedQueryIds: [],
    audience: { kind: 'specific', propertyIds: [] },
    onAudienceChange,
    assignmentImpact: null,
  })

  expect(screen.getByText('Showing 50 of 55 Properties')).toBeTruthy()
  expect(screen.queryByLabelText('Select Property 51')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Select all shown' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull()
  fireEvent.click(screen.getByLabelText('Select Property 1'))
  expect(onAudienceChange).toHaveBeenCalledWith({ kind: 'specific', propertyIds: ['property-1'] })

  fireEvent.click(screen.getByRole('button', { name: 'Show all Properties' }))
  expect(screen.getByText('Showing 55 of 55 Properties')).toBeTruthy()
  expect(screen.getByLabelText('Select Property 51')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Properties' }), { target: { value: 'Property 55' } })
  expect(screen.getByText('Showing 1 of 1 Properties')).toBeTruthy()
  expect(screen.getByLabelText('Select Property 55')).toBeTruthy()

  view.unmount()
})

test('shares the bounded, searchable Property picker with group setup', () => {
  renderGroups({
    properties: manyProperties,
    groups: [],
    groupDraft: emptyGroupDraft,
  })

  fireEvent.click(screen.getByText('0 of 55 Properties selected'))
  expect(screen.getByText('Showing 50 of 55 Properties')).toBeTruthy()
  expect(screen.queryByLabelText('Select Property 51')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Properties' }), { target: { value: 'Property 55' } })
  expect(screen.getByText('Showing 1 of 1 Properties')).toBeTruthy()
})

// Previously this asserted the copy "Add queries to this project first. Then
// return here to apply them to Properties." — an instruction to leave the
// wizard. On a new project that was a dead end: the step consumed queries and
// could not create them, so the only way forward was out and back. It now
// creates them in place, and the assertion moves with the behaviour.
test('lets an empty query library add queries without leaving setup', () => {
  const onCreateQueries = vi.fn()
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries,
  })

  fireEvent.change(screen.getByLabelText('New queries, one per line'), {
    target: { value: 'best apartments in dallas\nluxury apartments atlanta' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Add 2 queries/ }))

  expect(onCreateQueries).toHaveBeenCalledTimes(1)
  expect(onCreateQueries.mock.calls[0]![0]).toEqual([
    'best apartments in dallas',
    'luxury apartments atlanta',
  ])
})

// The portfolio shape. Typing one generic query and applying it to 213
// Properties measures the portfolio; a query per Property measures the
// Properties. The count is shown before the click because 213 is a surprising
// number to produce from one line of text.
test('writes one query per selected Property from a pattern, paired to it', () => {
  // Was: this handed the expanded texts to onCreateQueries and nothing carried
  // the pairing, so the caller could only cross-product them back onto every
  // Property. The pattern now emits (Property, text) pairs.
  const onCreateAndPairQuestions = vi.fn()
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onCreateAndPairQuestions,
  })

  fireEvent.change(screen.getByLabelText('Query pattern'), {
    target: { value: 'apartments near {property}' },
  })

  // The expansion is visible before it is committed.
  expect(screen.getByText('apartments near Harbor House')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /Add \d+ quer(y|ies)/ }))

  const pairs = onCreateAndPairQuestions.mock.calls[0]![0] as { propertyId: string; text: string }[]
  expect(pairs.every(pair => pair.text.startsWith('apartments near '))).toBe(true)
  // One query per Property, each naming the Property it is assigned to.
  expect(new Set(pairs.map(pair => pair.propertyId)).size).toBe(pairs.length)
  for (const pair of pairs) expect(pair.text.includes('{property}')).toBe(false)
})

test('states how many assignments the pattern will create', () => {
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onCreateAndPairQuestions: vi.fn(),
  })

  fireEvent.change(screen.getByLabelText('Query pattern'), {
    target: { value: 'apartments near {property}' },
  })

  // The number nobody saw before a plan was published with 45,369 of them.
  expect(screen.getByText(/adds \d+ assignments?/)).toBeTruthy()
})

test('removes the legacy name-matched recovery banner in favor of the pattern path', () => {
  renderQueries({ onCreateQueries: vi.fn(), onCreateAndPairQuestions: vi.fn() })
  expect(screen.queryByText(/suggested question-to-Property match/)).toBeNull()
  expect(screen.getByText('Write one query for every Property')).toBeTruthy()
})

test('does not show a no-op pagination action for a fully shown unapplied filter', () => {
  const mostlyApplied = manyQueries.map((query, index) => ({
    ...query,
    propertyIds: index < 50 ? ['harbor-house'] : [],
  }))
  renderQueries({ queries: mostlyApplied, selectedQueryIds: [] })

  fireEvent.click(screen.getByRole('button', { name: 'Show the 5 not applied' }))
  expect(screen.getAllByRole('button', { name: 'Show all queries' })).toHaveLength(1)
  expect(screen.getByText(/Showing 5 of 5 queries/)).toBeTruthy()
})

test('does not guess recovery matches for partial or overlapping Property names', () => {
  renderQueries({
    properties: [
      { id: 'harbor', label: 'Harbor', urlCount: 1 },
      { id: 'park', label: 'Park', urlCount: 1 },
      { id: 'park-place', label: 'Park Place', urlCount: 1 },
    ],
    queries: [
      { id: 'partial', text: 'Harborview events', source: 'saved-project-queries' },
      { id: 'overlap', text: 'events at Park Place', source: 'saved-project-queries' },
    ],
    selectedQueryIds: [],
  })

  expect(screen.queryByText(/suggested question-to-Property match/)).toBeNull()
})

test('blocks writes and navigation while another setup change is saving', () => {
  const onCreateQueries = vi.fn()
  const onContinue = vi.fn()
  renderQueries({ queries: [], selectedQueryIds: [], isBusy: true, onCreateQueries, onContinue })

  fireEvent.change(screen.getByLabelText('New queries, one per line'), {
    target: { value: 'best apartments in dallas' },
  })
  const add = screen.getByRole('button', { name: 'Add 1 query' })
  expect(add).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  fireEvent.click(add)
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(onCreateQueries).not.toHaveBeenCalled()
  expect(onContinue).not.toHaveBeenCalled()
})

test('asks for a placeholder rather than writing the same query repeatedly', () => {
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries: vi.fn() })

  fireEvent.change(screen.getByLabelText('Query pattern'), {
    target: { value: 'best apartments' },
  })

  expect(screen.getByText(/Add \{property\} to the pattern/)).toBeTruthy()
})

// Clearing the box on failure means retyping every query to retry, which is
// worst for the pattern case where the operator may have written one line that
// expanded to two hundred.
test('keeps what was typed when creation fails', async () => {
  const onCreateQueries = vi.fn().mockRejectedValue(new Error('Query is already tracked.'))
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries })

  const box = screen.getByLabelText('New queries, one per line')
  fireEvent.change(box, { target: { value: 'best apartments in dallas' } })
  fireEvent.click(screen.getByRole('button', { name: /Add 1 query/ }))

  await waitFor(() => expect(onCreateQueries).toHaveBeenCalled())
  expect((box as HTMLTextAreaElement).value).toBe('best apartments in dallas')
})

test('clears the box only once creation succeeds', async () => {
  const onCreateQueries = vi.fn().mockResolvedValue(undefined)
  renderQueries({ queries: [], selectedQueryIds: [], onCreateQueries })

  const box = screen.getByLabelText('New queries, one per line')
  fireEvent.change(box, { target: { value: 'best apartments in dallas' } })
  fireEvent.click(screen.getByRole('button', { name: /Add 1 query/ }))

  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))
})

test('surfaces the server reason when adding queries fails', () => {
  renderQueries({
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    createQueriesError: 'Query "best apartments in dallas" is already tracked.',
  })

  expect(screen.getByRole('alert').textContent)
    .toContain('Query "best apartments in dallas" is already tracked.')
})

test('keeps query creation away from viewers', () => {
  renderQueries({
    access: 'viewer',
    queries: [],
    selectedQueryIds: [],
    onCreateQueries: vi.fn(),
    onManageProjectQueries: vi.fn(),
  })

  expect(screen.queryByLabelText('New queries, one per line')).toBeNull()
  expect(screen.queryByRole('button', { name: /Add .* quer(y|ies)/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Manage project queries' })).toBeNull()
})

test('uses an accessible hit target for each table query checkbox', () => {
  renderQueries()

  expect(screen.getByLabelText('Select query Harbor House events').className).toContain('size-6')
})

test('places competitors only in groups and uses one clear continuation action', () => {
  const queryView = renderQueries()
  expect(queryView.queryByText('rival.example')).toBeNull()
  queryView.unmount()

  const { props } = renderGroups({ groupDraft: emptyGroupDraft })
  expect(screen.getByText('rival.example')).toBeTruthy()
  expect(screen.getByText(/used only in this group's competitor report/i)).toBeTruthy()

  expect(screen.queryByRole('button', { name: 'Skip groups' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(props.onContinue).toHaveBeenCalledTimes(1)

  cleanup()
  renderGroups({ groups: [], groupDraft: emptyGroupDraft })
  expect(screen.getByRole('button', { name: 'Continue without groups' })).toBeTruthy()
})

test('collapses group Properties and exposes optional actions for saved groups', () => {
  const onEditGroup = vi.fn()
  const onRemoveGroup = vi.fn()
  renderGroups({ onEditGroup, onRemoveGroup })

  const propertyChooser = screen.getByText('1 of 2 Properties selected').closest('details')
  expect(propertyChooser?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Edit Waterfront venues' }))
  expect(onEditGroup).toHaveBeenCalledWith(groups[0])
  fireEvent.click(screen.getByRole('button', { name: 'Remove Waterfront venues' }))
  expect(onRemoveGroup).toHaveBeenCalledWith('waterfront-venues')
})

test('reviews CSV group rows before applying only matched memberships', () => {
  const onReview = vi.fn()
  const onApply = vi.fn()
  renderGroups({
    membershipImport: {
      csv: 'property,group\nHarbor House,Dallas\nUnknown,Miami',
      preview: {
        draftEtag: '"mpd_7"',
        sourceChecksum: 'a'.repeat(64),
        previewChecksum: 'b'.repeat(64),
        rows: [
          { dataRow: 1, property: 'Harbor House', group: 'Dallas', url: null, status: 'matched' },
          { dataRow: 2, property: 'Unknown', group: 'Miami', url: null, status: 'unmatched' },
        ],
        groupChanges: [{
          groupKey: 'group-dallas',
          label: 'Dallas',
          action: 'create',
          targetKeys: ['harbor-house'],
          addedTargetKeys: ['harbor-house'],
          unchangedTargetKeys: [],
        }],
        counts: { dataRows: 2, matchedRows: 1, needsAttention: 1, groupsReady: 1 },
      },
      onCsvChange: vi.fn(),
      onReview,
      onApply,
    },
  })

  expect(screen.getByText('1 matched · 1 group ready · 1 needs attention')).toBeTruthy()
  expect(screen.getByRole('table', { name: 'Groups and memberships ready to apply' }).textContent).toContain('DallasCreate group11')
  fireEvent.click(screen.getByText('Review CSV rows (2)'))
  expect(screen.getByRole('table', { name: 'CSV group membership review' }).textContent).toContain('Harbor House')
  fireEvent.click(screen.getByText('Fix 1 row before applying'))
  const apply = screen.getByRole('button', { name: 'Apply 1 matched row' })
  expect((apply as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the exceptions and understand that 1 row will be skipped.' }))
  fireEvent.click(apply)
  expect(onApply).toHaveBeenCalledWith([1])
})

test('gives group-specific repair guidance for ambiguous labels and stable-key conflicts', () => {
  renderGroups({
    membershipImport: {
      csv: 'property,group\nHarbor House,Dallas\nNorth Hall,A/B',
      preview: {
        draftEtag: '"mpd_7"',
        sourceChecksum: 'a'.repeat(64),
        previewChecksum: 'b'.repeat(64),
        rows: [
          {
            dataRow: 1,
            property: 'Harbor House',
            group: 'Dallas',
            status: 'ambiguous',
            reason: 'group-label-ambiguous',
            candidateGroupKeys: ['dallas-a', 'dallas-b'],
          },
          {
            dataRow: 2,
            property: 'North Hall',
            group: 'A/B',
            status: 'invalid',
            reason: 'group-key-conflict',
            groupKeyConflict: {
              proposedGroupKey: 'group-a-b',
              evidence: [{ source: 'draft-target', stableKey: 'group-a-b' }],
            },
          },
        ],
        groupChanges: [],
        counts: { dataRows: 2, matchedRows: 0, needsAttention: 2, groupsReady: 0 },
      },
      onCsvChange: vi.fn(),
      onReview: vi.fn(),
      onApply: vi.fn(),
    },
  })

  fireEvent.click(screen.getByText('Fix 2 rows before applying'))
  expect(screen.getAllByText('More than one group matches “Dallas”. Rename duplicate groups, then preview again.').length).toBeGreaterThan(0)
  expect(screen.getAllByText('The group name “A/B” conflicts with an existing setup identity. Rename the group, then preview again.').length).toBeGreaterThan(0)
  expect(document.body.textContent).not.toContain('group-a-b')
})

test('pages CSV exceptions and requires the final page to be reviewed before skipping rows', () => {
  const onApply = vi.fn()
  const exceptionRows = Array.from({ length: 52 }, (_, index) => ({
    dataRow: index + 2,
    property: `Unknown ${index + 1}`,
    group: 'Dallas',
    url: null,
    status: 'unmatched' as const,
  }))
  renderGroups({
    membershipImport: {
      csv: 'property,group',
      preview: {
        draftEtag: '"mpd_7"',
        sourceChecksum: 'a'.repeat(64),
        previewChecksum: 'b'.repeat(64),
        rows: [{ dataRow: 1, property: 'Harbor House', group: 'Dallas', url: null, status: 'matched' }, ...exceptionRows],
        groupChanges: [{
          groupKey: 'group-dallas',
          label: 'Dallas',
          action: 'create',
          targetKeys: ['harbor-house'],
          addedTargetKeys: ['harbor-house'],
          unchangedTargetKeys: [],
        }],
        counts: { dataRows: 53, matchedRows: 1, needsAttention: 52, groupsReady: 1 },
      },
      onCsvChange: vi.fn(),
      onReview: vi.fn(),
      onApply,
    },
  })

  fireEvent.click(screen.getByText('Fix 52 rows before applying'))
  const acknowledgement = screen.getByRole('checkbox', { name: 'I reviewed the exceptions and understand that 52 rows will be skipped.' }) as HTMLInputElement
  expect(acknowledgement.disabled).toBe(true)
  expect(screen.getByRole('table', { name: 'CSV rows that need attention' }).textContent).toContain('Unknown 50')
  fireEvent.click(screen.getByRole('button', { name: 'Review next 50 exceptions' }))
  expect(screen.getByRole('table', { name: 'CSV rows that need attention' }).textContent).toContain('Unknown 52')
  expect(acknowledgement.disabled).toBe(false)
  fireEvent.click(acknowledgement)
  fireEvent.click(screen.getByRole('button', { name: 'Apply 1 matched row' }))
  expect(onApply).toHaveBeenCalledWith([1])
})

test('requires a partially entered group to be saved or cleared before continuing', () => {
  const onClearGroupDraft = vi.fn()
  const { props } = renderGroups({
    groups: [],
    onClearGroupDraft,
    groupDraft: { name: 'Waterfront venues', propertyIds: [], competitorDomains: '' },
  })

  expect(screen.getByText('Save this group or clear the form before continuing.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Clear form' }))
  expect(onClearGroupDraft).toHaveBeenCalledTimes(1)
  expect(props.onContinue).not.toHaveBeenCalled()
})

test('provides a predictable Back action on every step after Properties', () => {
  const queryView = renderQueries()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(queryView.props.onBack).toHaveBeenCalledTimes(1)
  queryView.unmount()

  const groupView = renderGroups()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(groupView.props.onBack).toHaveBeenCalledTimes(1)
  groupView.unmount()

  const reviewView = renderReview()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(reviewView.props.onBack).toHaveBeenCalledTimes(1)
})

test('blocks query continuation until an applied query is available', () => {
  renderQueries({ canContinue: false })

  expect(screen.getByText('Apply at least one query to a Property before continuing.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
})

test('uses publish wording without showing a result or implying work starts', () => {
  const { container, props } = renderReview()

  fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

  expect(props.onPublish).toHaveBeenCalledTimes(1)
  expect(container.textContent?.toLowerCase()).not.toContain('result')
  expect(container.textContent?.toLowerCase()).not.toContain('start a run')
})

test('requires a human-readable change review before publishing when preflight is configured', () => {
  const onReviewChanges = vi.fn()
  const waitingForReview = renderReview({
    onReviewChanges,
    reviewedChanges: null,
  })

  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  expect(onReviewChanges).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Publish setup' })).toBeNull()
  waitingForReview.unmount()

  const { props } = renderReview({
    onReviewChanges,
    reviewedChanges: {
      title: '2 Properties, 3 queries, and 1 group are ready to publish.',
      items: ['Harbor House and North Hall have selected URLs.', 'One group compares Waterfront venues with rival.example.'],
    },
  })

  expect(screen.getByText('2 Properties, 3 queries, and 1 group are ready to publish.')).toBeTruthy()
  expect(screen.getByText('Harbor House and North Hall have selected URLs.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))
  expect(props.onPublish).toHaveBeenCalledTimes(1)
})

test('keeps flagged exceptions labelled without treating static review items as an alert', () => {
  renderReview()

  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('region', { name: 'Flagged exceptions' }).textContent).toContain('A URL needs review')
})

test('shows reviewed sitemap URLs behind a concise disclosure before confirming them', () => {
  const onResolve = vi.fn()
  renderReview({
    sitemapReview: {
      exceptionCount: 1,
      coverageReviewCount: 0,
      coverageResolution: 'keep-existing',
      items: [{ url: 'https://example.com/blog', reason: 'Shared page, not a single Property' }],
      onCoverageResolutionChange: vi.fn(),
      onResolve,
    },
    canPublish: false,
  })

  expect(screen.getByText('URLs not added to Properties (1)').closest('details')?.open).toBe(false)
  expect(screen.getByText('https://example.com/blog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sitemap changes' }))
  expect(onResolve).toHaveBeenCalledTimes(1)
})

test('keeps large review lists bounded and reveals them fifty at a time', () => {
  const count = 75
  renderReview({
    flaggedExceptions: Array.from({ length: count }, (_, index) => ({
      id: `flag-${index + 1}`,
      title: `Flag ${index + 1}`,
      detail: `Flag detail ${index + 1}`,
    })),
    sitemapReview: {
      exceptionCount: count,
      coverageReviewCount: count,
      coverageResolution: 'keep-existing',
      items: Array.from({ length: count }, (_, index) => ({
        url: `https://example.com/unmatched/${index + 1}`,
        reason: `Reason ${index + 1}`,
      })),
      coverageItems: Array.from({ length: count }, (_, index) => ({
        property: `Property ${index + 1}`,
        savedUrls: [`https://example.com/saved/${index + 1}`],
        currentSitemapUrls: [`https://example.com/current/${index + 1}`],
      })),
      onCoverageResolutionChange: vi.fn(),
      onResolve: vi.fn(),
    },
  })

  expect(screen.getAllByText('Showing 20 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/20')).toBeTruthy()
  expect(screen.queryByText('https://example.com/unmatched/21')).toBeNull()
  expect(screen.getByText('Property 20')).toBeTruthy()
  expect(screen.queryByText('Property 21')).toBeNull()
  expect(screen.getByText('Flag 20')).toBeTruthy()
  expect(screen.queryByText('Flag 21')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URLs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URL changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 exceptions' }))

  expect(screen.getAllByText('Showing 70 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/70')).toBeTruthy()
  expect(screen.getByText('Property 70')).toBeTruthy()
  expect(screen.getByText('Flag 70')).toBeTruthy()
  expect(screen.queryByText('Flag 71')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URLs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 URL changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show next 50 exceptions' }))

  expect(screen.getAllByText('Showing 75 of 75')).toHaveLength(3)
  expect(screen.getByText('https://example.com/unmatched/75')).toBeTruthy()
  expect(screen.getByText('Property 75')).toBeTruthy()
  expect(screen.getByText('Flag 75')).toBeTruthy()
})

test('leaves the single unpublished-changes banner to the surrounding setup shell', () => {
  renderReview()

  expect(screen.queryByText('Unpublished changes')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
})

test('viewer access is inspect-only across the three steps', () => {
  const queryView = renderQueries({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(queryView.container.querySelectorAll('button, select, textarea, input:not([type="search"])')).toHaveLength(0)
  expect(screen.getByRole('searchbox', { name: 'Search queries' })).toBeTruthy()
  queryView.unmount()

  const groupView = renderGroups({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(groupView.container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
  groupView.unmount()

  const reviewView = renderReview({ access: 'viewer' })
  expect(screen.getByText('Viewer access')).toBeTruthy()
  expect(reviewView.container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
})

test('never renders implementation vocabulary that belongs outside the browser', () => {
  const queryView = renderQueries()
  const queryText = queryView.container.textContent?.toLowerCase() ?? ''
  queryView.unmount()
  const groupView = renderGroups()
  const groupText = groupView.container.textContent?.toLowerCase() ?? ''
  groupView.unmount()
  const reviewView = renderReview()
  const reviewText = reviewView.container.textContent?.toLowerCase() ?? ''

  const renderedText = `${queryText} ${groupText} ${reviewText}`
  for (const term of ['target', 'edge', 'node', 'manifest', 'revision', 'checksum', 'stablekey']) {
    expect(renderedText).not.toContain(term)
  }
})

test('renders an unavailable state without controls', () => {
  const { container } = renderReview({
    availability: { status: 'unavailable', message: 'Properties are not ready for setup.' },
  })

  expect(screen.getByText('Measurement setup unavailable')).toBeTruthy()
  expect(screen.getByText('Properties are not ready for setup.')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Review and publish' })).toBeTruthy()
  expect(container.querySelectorAll('button, input, select, textarea')).toHaveLength(0)
})

test('review states why assignments outrun queries, and never puts a button name in a number column', () => {
  renderReview({
    counts: { properties: 6, queries: 1, groups: 3, assignments: 3 },
  })

  // Was: the provider-requests cell rendered the literal string 'Review changes'
  // — the name of the button beside it — inside a numeric column, which reads as
  // a value rather than as "not computed yet".
  expect(screen.queryByText('Review changes', { selector: 'td' })).toBeNull()

  // One query aimed at a market writes one assignment per Property in it, so
  // 1 query and 3 assignments is correct and needs saying.
  expect(screen.getByText(/a query aimed at a market is measured on every Property in it/)).toBeTruthy()
})

test('the assignment impact slot keeps a reserved height so ticking a box cannot move the table', () => {
  // Four mutually exclusive states share this slot — calculating, the impact
  // sentence, an error with buttons, and the fallback count — and the sentence
  // itself rewraps as the counts grow. Without a reserved height, selecting a
  // query shifted the table under the operator's cursor.
  // The apply controls only render once queries exist, so use the defaults.
  const { container } = renderQueries({ onCreateQueries: vi.fn() })

  const slot = container.querySelector('.min-h-\\[2\\.75rem\\]')
  expect(slot).toBeTruthy()
  // The fallback count lives inside it, so every state shares the reservation.
  expect(slot!.textContent).toContain('assignments')
})
