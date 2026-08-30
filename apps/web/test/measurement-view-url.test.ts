import { describe, expect, it, test } from 'vitest'

import {
  DEFAULT_MEASUREMENT_VIEW,
  measurementPropertyViewSearch,
  measurementViewSearch,
  parseMeasurementPropertyViewSearch,
  parseMeasurementViewSearch,
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
    expect(parseMeasurementViewSearch({ class: cls }).queryClass).toBe('non-brand')
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
  expect(measurementViewSearch({ scope: 'group', groupKey: 'north', queryClass: 'non-brand' }))
    .toEqual({ scope: 'group:north', class: undefined })
  expect(measurementViewSearch({ scope: 'all', queryClass: 'branded' }))
    .toEqual({ scope: undefined, class: 'branded' })
  expect(measurementViewSearch({ scope: 'all', queryClass: 'all' }))
    .toEqual({ scope: undefined, class: 'all' })
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

// Branded and non-brand answer different questions. The first headline stays
// actionable by defaulting to non-brand; pooling remains an explicit choice.
test('the default view is non-brand and all queries remains explicit', () => {
  expect(DEFAULT_MEASUREMENT_VIEW.queryClass).toBe('non-brand')
  expect(parseMeasurementViewSearch({}).queryClass).toBe('non-brand')
  // Still absent from the URL, because it is the default.
  expect(measurementViewSearch(DEFAULT_MEASUREMENT_VIEW).class).toBeUndefined()
  expect(parseMeasurementViewSearch({ class: 'all' }).queryClass).toBe('all')
  expect(parseMeasurementViewSearch({ class: 'branded' }).queryClass).toBe('branded')
})

describe('Property measurement view state', () => {
  it('only accepts Property-compatible classes from a URL', () => {
    expect(parseMeasurementPropertyViewSearch({ class: 'branded' })).toEqual({ queryClass: 'branded' })
    expect(parseMeasurementPropertyViewSearch({ class: 'non-brand' })).toEqual({ queryClass: 'non-brand' })
  })

  it('treats pooled, malformed, and absent classes as the actionable Property default', () => {
    for (const queryClass of [undefined, '', 'all', 'ALL', 'nonbrand', 'both']) {
      expect(parseMeasurementPropertyViewSearch({ class: queryClass })).toEqual({ queryClass: 'non-brand' })
    }
  })

  it('always writes an explicit Property class', () => {
    expect(measurementPropertyViewSearch({ queryClass: 'non-brand' })).toEqual({ class: 'non-brand' })
    expect(measurementPropertyViewSearch({ queryClass: 'branded' })).toEqual({ class: 'branded' })
  })
})
