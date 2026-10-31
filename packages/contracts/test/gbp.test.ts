import { describe, it, expect } from 'vitest'
import {
  formatGbpMetricLabel,
  classifyGbpMetric,
  GBP_CONVERSION_METRICS,
  GBP_REACH_METRICS,
} from '../src/gbp.js'

describe('formatGbpMetricLabel', () => {
  it('maps known GBP DailyMetric keys to human labels', () => {
    expect(formatGbpMetricLabel('BUSINESS_DIRECTION_REQUESTS')).toBe('Direction requests')
    expect(formatGbpMetricLabel('WEBSITE_CLICKS')).toBe('Website clicks')
    expect(formatGbpMetricLabel('CALL_CLICKS')).toBe('Call clicks')
    expect(formatGbpMetricLabel('BUSINESS_IMPRESSIONS_MOBILE_MAPS')).toBe('Maps impressions (mobile)')
    expect(formatGbpMetricLabel('BUSINESS_FOOD_MENU_CLICKS')).toBe('Food menu clicks')
  })

  it('never returns a raw BUSINESS_* token for an unmapped key — it humanizes', () => {
    // The exact failure the issue calls out: raw enum keys leaking into the UI.
    expect(formatGbpMetricLabel('BUSINESS_FOOD_ORDERS')).toBe('Food orders')
    expect(formatGbpMetricLabel('BUSINESS_SOMETHING_NEW')).toBe('Something new')
    expect(formatGbpMetricLabel('BUSINESS_SOMETHING_NEW')).not.toMatch(/BUSINESS_|_/)
  })

  it('humanizes a key with no BUSINESS_ prefix', () => {
    expect(formatGbpMetricLabel('CALL_FORWARDING_EVENTS')).toBe('Call forwarding events')
  })

  it('falls back to the raw value only for a degenerate empty-ish key', () => {
    expect(formatGbpMetricLabel('BUSINESS_')).toBe('BUSINESS_')
  })
})

describe('classifyGbpMetric', () => {
  it('classifies the three conversion outcomes', () => {
    const metrics = ['BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS', 'CALL_CLICKS']
    expect(GBP_CONVERSION_METRICS).toEqual(metrics)
    expect(metrics.map(classifyGbpMetric)).toEqual(['conversion', 'conversion', 'conversion'])
  })

  it('classifies the four impression metrics as reach', () => {
    const metrics = ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS']
    expect(GBP_REACH_METRICS).toEqual(metrics)
    expect(metrics.map(classifyGbpMetric)).toEqual(['reach', 'reach', 'reach', 'reach'])
  })

  it('classifies everything else as other', () => {
    expect(classifyGbpMetric('BUSINESS_BOOKINGS')).toBe('other')
    expect(classifyGbpMetric('BUSINESS_CONVERSATIONS')).toBe('other')
    expect(classifyGbpMetric('BUSINESS_FOOD_ORDERS')).toBe('other')
    expect(classifyGbpMetric('SOMETHING_UNKNOWN')).toBe('other')
  })

})
