import { describe, expect, it } from 'vitest'
import { parseVisibilitySelection, patchVisibilitySelection } from '../src/lib/measurement-view-url.js'

describe('shared visibility selection URL', () => {
  it('defaults to non-brand for simple and advanced projects', () => {
    expect(parseVisibilitySelection({})).toEqual({ measurementScope: 'project', queryClass: 'non-brand' })
  })

  it('preserves the legacy group bookmark without widening it', () => {
    expect(parseVisibilitySelection({ scope: 'group:metro-alpha', class: 'branded' }))
      .toEqual({ measurementScope: 'group', measurementScopeKey: 'metro-alpha', queryClass: 'branded' })
  })

  it('keeps a measurement run distinct from the global drawer', () => {
    const search = { runId: 'drawer-run', measurementRunId: 'measured-run', queryClass: 'branded', measurementProvider: 'gemini' }
    const next = patchVisibilitySelection(search, { measurementScope: 'market', measurementScopeKey: 'alpha' })
    expect(next).toMatchObject({ ...search, measurementScope: 'market', measurementScopeKey: 'alpha' })
    expect(parseVisibilitySelection(next)).toMatchObject({ measurementRunId: 'measured-run', provider: 'gemini', queryClass: 'branded' })
  })

  it('carries time, exact location, engine and model across scope navigation', () => {
    const search = { measurementProvider: 'gemini', measurementModel: 'frozen-model', measurementLocation: '__none__', measurementFrom: '2026-08-01', measurementTo: '2026-08-31', measurementRevision: '4' }
    expect(parseVisibilitySelection(patchVisibilitySelection(search, { measurementScope: 'property', measurementScopeKey: 'house-1' })))
      .toMatchObject({ measurementScope: 'property', measurementScopeKey: 'house-1', provider: 'gemini', model: 'frozen-model', location: '__none__', from: '2026-08-01', to: '2026-08-31', revision: 4 })
  })

  it('removes only scoped evidence focus on a scope change', () => {
    const next = patchVisibilitySelection({ measurementQueryKey: 'query-1', runId: 'drawer', queryWorkspace: 'tracked' }, { measurementScope: 'project' })
    expect(next).toMatchObject({ runId: 'drawer', queryWorkspace: 'tracked', measurementQueryKey: undefined, measurementScopeKey: undefined })
  })

  it('does not fabricate a valid scope from a missing scope key', () => {
    expect(parseVisibilitySelection({ measurementScope: 'market', queryClass: 'unknown' }))
      .toEqual({ measurementScope: 'project', queryClass: 'unknown' })
  })
})
