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
    expect(MAX_RESEARCH_BATCH_RUNS).toBe(20)
    expect(MAX_RESEARCH_BATCH_QUERIES).toBe(50)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: Array.from({ length: 20 }, () => run) }).success).toBe(true)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: Array.from({ length: 21 }, () => run) }).success).toBe(false)
    const queries = (length: number) => Array.from({ length }, (_, index) => `query ${index}`)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, queries: queries(50) }] }).success).toBe(true)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, queries: queries(51) }] }).success).toBe(false)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, queries: queries(25) }, { ...run, queries: queries(25) }] }).success).toBe(true)
    const aggregate = researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, queries: queries(25) }, { ...run, queries: queries(26) }] })
    expect(aggregate.success).toBe(false)
    if (!aggregate.success) expect(aggregate.error.issues).toEqual([
      expect.objectContaining({ path: ['runs'], code: 'custom' }),
    ])
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, scope: { kind: 'market', key: 'north' } }] }).success).toBe(false)
    expect(researchBatchCreateSchema.safeParse({ idempotencyKey: 'batch', runs: [{ ...run, idempotencyKey: 'child' }] }).success).toBe(false)
  })
})
