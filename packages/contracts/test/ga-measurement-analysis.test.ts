import { describe, expect, it } from 'vitest'
import {
  gaMeasurementAnalysisDtoSchema,
  gaMeasurementAnalysisWindowSchema,
  gaMeasurementHostScopeSchema,
} from '../src/measurement.js'

const period = {
  label: 'latest' as const,
  startDate: '2026-06-23',
  endDate: '2026-07-22',
}

describe('GA measurement analysis contract', () => {
  it('accepts the typed cohort response used by humans and agents', () => {
    expect(gaMeasurementAnalysisDtoSchema).toBeDefined()
    expect(gaMeasurementAnalysisDtoSchema.parse({
      window: '90d',
      bucketDays: 30,
      filters: {
        hostScope: 'marketing',
        marketingHosts: ['demand-iq.com', 'offers.example.net'],
        pathPrefix: '/blog',
        brandTerms: ['DemandIQ', 'Demand IQ'],
        queryMixScope: 'property',
      },
      acquisition: {
        status: 'ready',
        error: null,
        syncedAt: '2026-07-23T12:00:00.000Z',
        periods: [{ ...period, sessions: 42 }],
        channels: [{
          channelGroup: 'Organic Search',
          periods: [{ ...period, sessions: 42 }],
        }],
        pages: [{
          hostName: 'www.demand-iq.com',
          landingPage: '/blog/example',
          periods: [{ ...period, sessions: 42 }],
        }],
      },
      leads: {
        status: 'ready',
        error: null,
        syncedAt: '2026-07-23T12:00:00.000Z',
        attributionScope: 'landing-page',
        hostAndPathFiltersApplied: true,
        periods: [{ ...period, eventCount: 3 }],
        channels: [{
          channelGroup: 'Organic Search',
          periods: [{ ...period, eventCount: 3 }],
        }],
      },
      searchDemand: {
        status: 'ready',
        periods: [{
          ...period,
          propertyClicks: 20,
          propertyImpressions: 300,
          reportedQueryClicks: 16,
          reportedQueryImpressions: 200,
          brandedClicks: 10,
          brandedImpressions: 100,
          nonBrandedClicks: 6,
          nonBrandedImpressions: 100,
          unreportedClicks: 4,
          unreportedImpressions: 100,
        }],
        queries: [{
          query: 'demand iq platform',
          classification: 'branded',
          periods: [{ ...period, clicks: 8, impressions: 80 }],
        }],
        pages: [{
          hostName: 'www.demand-iq.com',
          landingPage: '/blog/example',
          periods: [{ ...period, clicks: 3, impressions: 120 }],
        }],
        latestDate: '2026-07-22',
      },
    })).toMatchObject({
      window: '90d',
      filters: {
        hostScope: 'marketing',
        queryMixScope: 'property',
      },
      acquisition: { status: 'ready' },
      searchDemand: { status: 'ready' },
    })
  })

  it('rejects unsupported windows, host scopes, and dishonest negative residuals', () => {
    expect(gaMeasurementAnalysisWindowSchema).toBeDefined()
    expect(gaMeasurementHostScopeSchema).toBeDefined()
    expect(gaMeasurementAnalysisDtoSchema).toBeDefined()
    expect(() => gaMeasurementAnalysisWindowSchema.parse('45d')).toThrow()
    expect(() => gaMeasurementHostScopeSchema.parse('canonical-only')).toThrow()

    const invalid = {
      window: '30d',
      bucketDays: 30,
      filters: {
        hostScope: 'all',
        marketingHosts: [],
        pathPrefix: null,
        brandTerms: [],
        queryMixScope: 'property',
      },
      acquisition: {
        status: 'never-synced',
        error: null,
        syncedAt: null,
        periods: [],
        channels: [],
        pages: [],
      },
      leads: {
        status: 'never-synced',
        error: null,
        syncedAt: null,
        attributionScope: null,
        hostAndPathFiltersApplied: false,
        periods: [],
        channels: [],
      },
      searchDemand: {
        status: 'ready',
        periods: [{
          ...period,
          propertyClicks: 1,
          propertyImpressions: 1,
          reportedQueryClicks: 2,
          reportedQueryImpressions: 2,
          brandedClicks: 1,
          brandedImpressions: 1,
          nonBrandedClicks: 1,
          nonBrandedImpressions: 1,
          unreportedClicks: -1,
          unreportedImpressions: -1,
        }],
        queries: [],
        pages: [],
        latestDate: '2026-07-22',
      },
    }
    expect(() => gaMeasurementAnalysisDtoSchema.parse(invalid)).toThrow()
  })
})
