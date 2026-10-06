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
      requestedDays: 30,
      clamped: false,
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
    for (const component of ['acquisition', 'leads'] as const) {
      const { days: _days, ...withoutDays } = response.measurement[component]
      const parsed = ga4SyncResponseDtoSchema.safeParse({
        ...response,
        measurement: { ...response.measurement, [component]: withoutDays },
      })
      expect(parsed.success).toBe(false)
      expect(parsed.success ? [] : parsed.error.issues.map(issue => issue.path))
        .toEqual([['measurement', component, 'days']])
    }
  })

  it('carries the effective window, the request, and the clamp flag', () => {
    // A truncated sync must be self-describing: `days` is what was written,
    // `requestedDays` is what was asked for.
    const clampedResponse = {
      synced: true,
      rowCount: 0,
      aiReferralCount: 0,
      socialReferralCount: 0,
      days: 90,
      requestedDays: 500,
      clamped: true,
      syncedAt: '2026-08-16T12:00:00.000Z',
      measurement: {
        acquisition: { days: 90, status: 'ready', rowCount: 0 },
        leads: { days: 0, status: 'not-configured', rowCount: 0 },
      },
    }

    expect(ga4SyncResponseDtoSchema.parse(clampedResponse)).toEqual(clampedResponse)
  })

  it('rejects a response that omits the clamp fields', () => {
    // Both are REQUIRED, not optional. An optional `clamped` would let a
    // consumer read a missing field as "not truncated" — the exact bug the
    // fields exist to close.
    const base = {
      synced: true,
      rowCount: 0,
      aiReferralCount: 0,
      socialReferralCount: 0,
      days: 90,
      requestedDays: 500,
      clamped: true,
      syncedAt: '2026-08-16T12:00:00.000Z',
      measurement: {
        acquisition: { days: 90, status: 'ready', rowCount: 0 },
        leads: { days: 0, status: 'not-configured', rowCount: 0 },
      },
    }

    for (const omitted of ['requestedDays', 'clamped'] as const) {
      const { [omitted]: _dropped, ...withoutField } = base
      expect(() => ga4SyncResponseDtoSchema.parse(withoutField)).toThrow()
    }
  })
})
