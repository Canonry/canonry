import { describe, expect, it } from 'vitest'
import { runDtoSchema, runTriggerRequestSchema, runTriggerSchema, RunTriggers } from '../src/run.js'

describe('runDtoSchema.queries', () => {
  it('parses a run row with a queries array', () => {
    const result = runDtoSchema.parse({
      id: 'run_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'queued',
      queries: ['alpha', 'beta'],
      createdAt: '2026-05-13T00:00:00.000Z',
    })
    expect(result.queries).toEqual(['alpha', 'beta'])
  })

  it('parses a run row with queries explicitly null (full sweep)', () => {
    const result = runDtoSchema.parse({
      id: 'run_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'queued',
      queries: null,
      createdAt: '2026-05-13T00:00:00.000Z',
    })
    expect(result.queries).toBeNull()
  })
})

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

describe("runTriggerSchema: 'probe' as a first-class trigger", () => {
  // Probe runs are operator/agent test runs that exercise a (queries × providers)
  // slice without affecting the dashboard, analytics, or notifications. They
  // share the answer-visibility code path but are excluded from aggregations.
  it("accepts 'probe' as a valid trigger value", () => {
    expect(runTriggerSchema.safeParse('probe').success).toBe(true)
  })

  it("exposes RunTriggers.probe = 'probe'", () => {
    expect(RunTriggers.probe).toBe('probe')
  })

  it("runDtoSchema parses a row with trigger='probe'", () => {
    const result = runDtoSchema.parse({
      id: 'run_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'probe',
      createdAt: '2026-05-17T02:28:00.000Z',
    })
    expect(result.trigger).toBe('probe')
  })

  it("runTriggerRequestSchema accepts trigger='probe' from API/CLI callers", () => {
    const result = runTriggerRequestSchema.safeParse({ trigger: 'probe' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.trigger).toBe('probe')
    }
  })

  it("runTriggerRequestSchema still accepts trigger='manual' (no regression)", () => {
    const result = runTriggerRequestSchema.safeParse({ trigger: 'manual' })
    expect(result.success).toBe(true)
  })

  it('runTriggerRequestSchema rejects unknown trigger values', () => {
    const result = runTriggerRequestSchema.safeParse({ trigger: 'scheduled' })
    // Only manual/probe are operator-supplied; 'scheduled'/'config-apply'/'backfill' are server-set
    expect(result.success).toBe(false)
  })
})
