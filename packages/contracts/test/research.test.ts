import { describe, expect, it } from 'vitest'
import { deduplicateResearchQueries, expandResearchTemplate, MAX_RESEARCH_BATCH_QUERIES, MAX_RESEARCH_BATCH_RUNS, researchBatchCreateSchema, researchTemplateBindings } from '../src/research.js'

describe('research input helpers', () => {
  it('keeps the first exact query while removing blank and equivalent entries', () => {
    expect(deduplicateResearchQueries(['  Local services?  ', '', 'LOCAL SERVICES?', ' \t', 'Local  services?', 'Local services'])).toEqual([
      '  Local services?  ', 'Local  services?', 'Local services',
    ])
    expect(deduplicateResearchQueries([])).toEqual([])
  })

  it('binds declared market names and rejects undeclared placeholders', () => {
    expect(() => expandResearchTemplate({ pattern: 'Compare {market} with {submarket}', variables: ['market'] }, { kind: 'market', label: 'Downtown' })).toThrow(/undeclared placeholders/i)
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

  it('binds configured locations without a scope and validates bounded explicit destinations', () => {
    expect(expandResearchTemplate({ pattern: 'Services in {location}', variables: ['location'] }, null, { label: 'New York' })).toEqual({
      bindings: { location: 'New York' }, output: 'Services in New York',
    })
    expect(researchTemplateBindings(undefined, { label: 'New York' })).toEqual({ location: 'New York' })
    const run = { queries: ['one'], provider: 'openai', model: 'gpt-4.1', location: null }
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: Array.from({ length: MAX_RESEARCH_BATCH_RUNS }, () => run) }).success).toBe(true)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: Array.from({ length: MAX_RESEARCH_BATCH_RUNS + 1 }, () => run) }).success).toBe(false)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, queries: Array.from({ length: MAX_RESEARCH_BATCH_QUERIES + 1 }, () => 'one') }] }).success).toBe(false)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, scope: { kind: 'market', key: 'north' } }] }).success).toBe(false)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, idempotencyKey: 'child' }] }).success).toBe(false)
  })
})
