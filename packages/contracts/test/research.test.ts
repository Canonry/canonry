import { describe, expect, it } from 'vitest'
import { deduplicateResearchQueries, expandResearchTemplate, researchTemplateBindings } from '../src/research.js'

describe('research input helpers', () => {
  it('keeps the first exact query while removing blank and equivalent entries', () => {
    expect(deduplicateResearchQueries(['  Local services?  ', '', 'LOCAL SERVICES?', ' \t', 'Local  services?', 'Local services'])).toEqual([
      '  Local services?  ', 'Local  services?', 'Local services',
    ])
    expect(deduplicateResearchQueries([])).toEqual([])
  })

  it('binds declared market names only, leaving undeclared placeholders unchanged', () => {
    expect(expandResearchTemplate({ pattern: 'Compare {market} with {submarket}', variables: ['market'] }, { kind: 'market', label: 'Downtown' })).toEqual({
      bindings: { market: 'Downtown' }, output: 'Compare Downtown with {submarket}',
    })
  })

  it('binds declared property aliases and supports templates without variables', () => {
    const scope = { kind: 'property' as const, label: 'Harbor Clinic' }
    expect(expandResearchTemplate({ pattern: 'Services at {propertyBrand}', variables: ['propertyBrand'] }, scope)).toEqual({
      bindings: { propertyBrand: scope.label }, output: 'Services at Harbor Clinic',
    })
    expect(expandResearchTemplate({ pattern: 'Local services', variables: [] }, scope)).toEqual({ bindings: {}, output: 'Local services' })
    expect(researchTemplateBindings(null)).toEqual({})
    expect(() => expandResearchTemplate({ pattern: 'Services in {market}', variables: ['market'] }, scope)).toThrow()
  })
})
