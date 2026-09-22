import { expect, it } from 'vitest'
import { aeroViewFromLocation } from '../src/lib/aero-view.js'

it('carries Advanced report scope, market, provider, class, dates, revision and run together', () => {
  expect(aeroViewFromLocation('/projects/demo', {
    measurementScope: 'property', measurementScopeKey: 'hotel', measurementMarketKey: 'london',
    queryClass: 'non-brand', measurementProvider: 'openai', measurementModel: 'model',
    measurementLocation: 'none', measurementFrom: '2026-09-01T00:00:00.000Z', measurementTo: '2026-09-20T00:00:00.000Z',
    measurementRevision: '3', measurementRunId: 'run-3',
  })).toEqual({ view: 'visibility', selection: {
    mode: 'auto', scope: 'property', scopeKey: 'hotel', marketKey: 'london', queryClass: 'non-brand', provider: 'openai',
    model: 'model', location: 'none', from: '2026-09-01T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z', revision: 3, runId: 'run-3', limit: 25,
  } })
})

it('does not apply carried measurement filters to Property details or Site Health', () => {
  const carried = { measurementMarketKey: 'london', measurementRunId: 'old-run', measurementProvider: 'openai', queryClass: 'branded' }
  expect(aeroViewFromLocation('/projects/demo/properties/hotel', carried)).toEqual({ view: 'property', selection: { mode: 'auto', scope: 'property', scopeKey: 'hotel', queryClass: 'branded', limit: 10 } })
  expect(aeroViewFromLocation('/projects/demo/technical-aeo', carried)).toEqual({ view: 'site-health' })
  expect(aeroViewFromLocation('/projects/demo/backlinks', carried)).toEqual({ view: 'project' })
})

it('keeps Simple context project-wide and does not treat the run drawer as a measurement filter', () => {
  expect(aeroViewFromLocation('/projects/demo', { runId: 'drawer-run' })).toEqual({ view: 'visibility', selection: { mode: 'auto', scope: 'project', queryClass: 'all', limit: 25 } })
})


it('refuses invalid dates instead of broadening the evidence scope', () => {
  expect(aeroViewFromLocation('/projects/demo', { measurementFrom: 'bad-date' })).toMatchObject({ view: 'visibility', unavailableReason: expect.any(String) })
})

it('does not claim a research workspace displays carried measurement evidence', () => {
  expect(aeroViewFromLocation('/projects/demo/queries', { queryWorkspace: 'research', measurementScope: 'property', measurementScopeKey: 'hotel' })).toEqual({ view: 'project' })
})


it('uses only applied assignment filters for tracked queries', () => {
  expect(aeroViewFromLocation('/projects/demo/queries', { measurementScope: 'property', measurementScopeKey: 'hotel', measurementMarketKey: 'london', measurementRunId: 'old-run', measurementProvider: 'openai', queryClass: 'branded' })).toEqual({ view: 'queries', selection: { mode: 'auto', scope: 'property', scopeKey: 'hotel', queryClass: 'branded', limit: 25 } })
})
