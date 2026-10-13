import { describe, expect, it } from 'vitest'
import { instanceStatusDtoSchema } from '../src/index.js'

describe('instance status contract', () => {
  it('accepts an instance status payload', () => {
    const result = instanceStatusDtoSchema.safeParse({
      generatedAt: '2026-10-11T00:00:00.000Z',
      summary: { projects: 0, ok: 0, failing: 0, stale: 0, neverSynced: 0 },
      projects: [],
    })
    expect(result.success).toBe(true)
  })
})
