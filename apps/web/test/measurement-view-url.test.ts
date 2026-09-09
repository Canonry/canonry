import { describe, expect, it, test } from 'vitest'

import {
  DEFAULT_MEASUREMENT_VIEW,
  measurementViewSearch,
  parseMeasurementViewSearch,
  parseVisibilitySelection,
  patchVisibilitySelection,
  shouldResetMeasurementView,
} from '../src/lib/measurement-view-url.js'

test('reads a group scope and a query class out of the URL', () => {
  expect(parseMeasurementViewSearch({ scope: 'group:north', class: 'branded' }))
    .toEqual({ scope: 'group', groupKey: 'north', queryClass: 'branded' })
})

test('an absent search is the default view, not an error', () => {
  expect(parseMeasurementViewSearch({})).toEqual(DEFAULT_MEASUREMENT_VIEW)
})

test('a malformed scope degrades to all properties rather than throwing', () => {
  // These arrive from hand-edited links and months-old bookmarks. Each must
  // land on the default; none may throw.
  for (const scope of ['', 'group:', 'group', 'nonsense', 'all', 'GROUP:north']) {
    expect(parseMeasurementViewSearch({ scope }).scope).toBe('all')
  }
})

test('a malformed class degrades to the default, which is never pooled with branded', () => {
  for (const cls of ['', 'BRANDED', 'nonbrand', 'both']) {
    expect(parseMeasurementViewSearch({ class: cls }).queryClass).toBe('all')
  }
})

test('a group key containing a colon survives the round trip', () => {
  // Stable keys are slugs today, but the format must not silently truncate a
  // key that happens to contain the separator.
  const view = parseMeasurementViewSearch({ scope: 'group:north:west' })
  expect(view.groupKey).toBe('north:west')
  expect(measurementViewSearch(view).scope).toBe('group:north:west')
})

test('defaults are written as absent, so the common case leaves a clean URL', () => {
  expect(measurementViewSearch(DEFAULT_MEASUREMENT_VIEW)).toEqual({ scope: undefined, class: undefined })
})

test('a deliberate choice is written, and only that choice', () => {
  // Non-brand is no longer the default, so choosing it is a deliberate choice
  // and must survive a reload.
  expect(measurementViewSearch({ scope: 'group', groupKey: 'north', queryClass: 'non-brand' }))
    .toEqual({ scope: 'group:north', class: 'non-brand' })
  expect(measurementViewSearch({ scope: 'all', queryClass: 'branded' }))
    .toEqual({ scope: undefined, class: 'branded' })
})

test('every state survives a URL round trip', () => {
  const states = [
    DEFAULT_MEASUREMENT_VIEW,
    { scope: 'all' as const, queryClass: 'branded' as const },
    { scope: 'group' as const, groupKey: 'north', queryClass: 'all' as const },
    { scope: 'group' as const, groupKey: 'south', queryClass: 'branded' as const },
  ]
  for (const state of states) {
    expect(parseMeasurementViewSearch(measurementViewSearch(state))).toEqual(state)
  }
})

describe('shouldResetMeasurementView', () => {
  // The reset exists because a scope names a group inside one project's plan
  // revision; carry it across a different plan and it points at nothing.
  it('resets when the plan identity genuinely changes', () => {
    expect(shouldResetMeasurementView('acme:4', 'acme:5')).toBe(true)
    expect(shouldResetMeasurementView('acme:4', 'other:4')).toBe(true)
  })

  // The bug this pins: on first mount there is no previous identity, and the
  // URL's scope is precisely what the reader asked for. Resetting there throws
  // away every shared or bookmarked link the moment it opens.
  it('never resets on the first identity it sees', () => {
    expect(shouldResetMeasurementView(null, 'acme:4')).toBe(false)
  })

  // The plan arrives asynchronously, so the identity is unknown for the first
  // render or two. An unknown value is not a change.
  it('does not treat a not-yet-loaded plan as a change', () => {
    expect(shouldResetMeasurementView(null, null)).toBe(false)
    expect(shouldResetMeasurementView('acme:4', null)).toBe(false)
  })

  it('does not reset on a re-render with the same identity', () => {
    expect(shouldResetMeasurementView('acme:4', 'acme:4')).toBe(false)
  })
})

// Branded and non-brand answer different questions and are never pooled INTO a
// single rate — but the operator arriving at the page has not yet said which he
// is asking, and defaulting to one silently hides the other half of the basket.
test('the default view is all queries', () => {
  expect(DEFAULT_MEASUREMENT_VIEW.queryClass).toBe('all')
  expect(parseMeasurementViewSearch({}).queryClass).toBe('all')
  // Still absent from the URL, because it is the default.
  expect(measurementViewSearch(DEFAULT_MEASUREMENT_VIEW).class).toBeUndefined()
  // And an explicit narrower choice still round-trips.
  expect(parseMeasurementViewSearch({ class: 'branded' }).queryClass).toBe('branded')
})

test('the shared visibility workspace opens all query types for clean and malformed URLs', () => {
  for (const search of [{}, { queryClass: '' }, { queryClass: 'invalid' }, { class: 'invalid' }]) {
    expect(parseVisibilitySelection(search)).toEqual({ measurementScope: 'project', queryClass: 'all' })
  }
})

test('explicit query types survive navigation and reload without losing unrelated URL state', () => {
  for (const queryClass of ['all', 'branded', 'non-brand', 'unknown'] as const) {
    expect(parseVisibilitySelection({ queryClass }).queryClass).toBe(queryClass)
    expect(parseVisibilitySelection({ class: queryClass }).queryClass).toBe(queryClass)
    const next = patchVisibilitySelection({ class: 'branded', runId: 'drawer-run', measurementProvider: 'gemini' }, { queryClass })
    expect(parseVisibilitySelection(next)).toEqual({ measurementScope: 'project', queryClass, provider: 'gemini' })
    expect(next.runId).toBe('drawer-run')
  }
})
