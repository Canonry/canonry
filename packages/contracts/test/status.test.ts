import { describe, expect, it } from 'vitest'
import { instanceStatusDtoSchema, mcpHealthSchema } from '../src/index.js'

describe('instance status contract', () => {
  it('accepts an instance status payload', () => {
    const result = instanceStatusDtoSchema.safeParse({
      generatedAt: '2026-10-11T00:00:00.000Z',
      summary: { projects: 0, ok: 0, failing: 0, stale: 0, neverSynced: 0 },
      projects: [],
    })
    expect(result.success).toBe(true)
  })

  it.each([
    { status: 'available' },
    { status: 'available', hosted: { status: 'ready', url: 'https://canonry.example/team/api/v1/mcp' } },
    { status: 'available', hosted: { status: 'unavailable', reason: 'account-required' } },
    { status: 'not-supported', hosted: { status: 'unavailable', reason: 'transport-unavailable' } },
  ])('preserves transport and hosted readiness independently: %j', mcp => {
    const result = instanceStatusDtoSchema.parse({
      generatedAt: '2026-10-22T00:00:00.000Z',
      mcp,
      summary: { projects: 0, ok: 0, failing: 0, stale: 0, neverSynced: 0 },
      projects: [],
    })
    expect(result.mcp).toEqual(mcp)
  })

  it.each([
    { status: 'ready' },
    { status: 'ready', url: 'not a URL' },
    { status: 'unavailable' },
    { status: 'unavailable', reason: 'unexpected' },
  ])('rejects hosted readiness without its required URL or known recovery reason: %j', hosted => {
    expect(mcpHealthSchema.safeParse({ status: 'available', hosted }).success).toBe(false)
  })
})
