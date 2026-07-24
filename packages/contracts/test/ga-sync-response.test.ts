import { describe, expect, it } from 'vitest'
import { ga4SyncResponseDtoSchema } from '../src/index.js'

describe('ga4SyncResponseDtoSchema', () => {
  it('documents independent acquisition and lead measurement outcomes', () => {
    const response = {
      synced: true,
      rowCount: 5,
      aiReferralCount: 1,
      socialReferralCount: 2,
      days: 30,
      syncedAt: '2026-07-23T12:00:00.000Z',
      measurement: {
        acquisition: {
          days: 90,
          status: 'ready',
          rowCount: 42,
        },
        leads: {
          days: 30,
          status: 'error',
          rowCount: 0,
          error: 'GA4 quota exhausted',
        },
      },
    }

    expect(ga4SyncResponseDtoSchema.parse(response)).toEqual(response)
    expect(() => ga4SyncResponseDtoSchema.parse({
      ...response,
      measurement: {
        acquisition: { status: 'ready', rowCount: 42 },
        leads: { status: 'ready', rowCount: 3 },
      },
    })).toThrow()
  })
})
