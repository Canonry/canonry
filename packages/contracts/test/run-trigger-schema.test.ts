import { describe, expect, it } from 'vitest'
import { runTriggerRequestSchema } from '../src/run.js'

describe('runTriggerRequestSchema.queries', () => {
  it('accepts requests with no queries field (full-sweep default)', () => {
    const result = runTriggerRequestSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.queries).toBeUndefined()
    }
  })

  it('accepts a non-empty array of query strings', () => {
    const result = runTriggerRequestSchema.safeParse({ queries: ['alpha', 'beta'] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.queries).toEqual(['alpha', 'beta'])
    }
  })

  it('rejects an empty queries array', () => {
    const result = runTriggerRequestSchema.safeParse({ queries: [] })
    expect(result.success).toBe(false)
  })

  it('rejects queries with empty strings', () => {
    const result = runTriggerRequestSchema.safeParse({ queries: [''] })
    expect(result.success).toBe(false)
  })

  it('rejects non-string queries entries', () => {
    const result = runTriggerRequestSchema.safeParse({ queries: [42] })
    expect(result.success).toBe(false)
  })

  it('allows queries to combine with location', () => {
    const result = runTriggerRequestSchema.safeParse({
      queries: ['alpha'],
      location: 'michigan',
    })
    expect(result.success).toBe(true)
  })

  it('allows queries to combine with allLocations', () => {
    const result = runTriggerRequestSchema.safeParse({
      queries: ['alpha'],
      allLocations: true,
    })
    expect(result.success).toBe(true)
  })
})
