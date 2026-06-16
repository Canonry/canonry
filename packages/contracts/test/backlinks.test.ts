import { describe, it, expect } from 'vitest'
import {
  BacklinkSources,
  backlinkSourceSchema,
  backlinkDomainDtoSchema,
  backlinkSummaryDtoSchema,
  backlinkHistoryEntrySchema,
  backlinkListResponseSchema,
  backlinkSourceAvailabilityDtoSchema,
  backlinkSourcesResponseSchema,
  computeBacklinkSummaryMetrics,
} from '../src/index.js'

describe('computeBacklinkSummaryMetrics', () => {
  it('returns zeros and "0" share for no rows', () => {
    expect(computeBacklinkSummaryMetrics([])).toEqual({
      totalLinkingDomains: 0,
      totalHosts: 0,
      top10HostsShare: '0',
    })
  })

  it('sums hosts and rounds the top-10 concentration share to six decimals', () => {
    const m = computeBacklinkSummaryMetrics([{ numHosts: 60 }, { numHosts: 30 }, { numHosts: 10 }])
    expect(m.totalLinkingDomains).toBe(3)
    expect(m.totalHosts).toBe(100)
    expect(m.top10HostsShare).toBe('1.000000') // all 3 within the top 10
  })

  it('top-10 share excludes the long tail beyond the 10 strongest', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ numHosts: i + 1 }))
    // numHosts 1..12, total = 78; top 10 strongest = 12+11+…+3 = 75; share = 75/78.
    const m = computeBacklinkSummaryMetrics(rows)
    expect(m.totalLinkingDomains).toBe(12)
    expect(m.totalHosts).toBe(78)
    expect(Number(m.top10HostsShare)).toBeCloseTo(75 / 78, 6)
  })
})

describe('backlink source enum', () => {
  it('exposes the two sources as enum constants', () => {
    expect(BacklinkSources.commoncrawl).toBe('commoncrawl')
    expect(BacklinkSources['bing-webmaster']).toBe('bing-webmaster')
  })

  it('accepts the known sources and rejects anything else', () => {
    expect(backlinkSourceSchema.safeParse('commoncrawl').success).toBe(true)
    expect(backlinkSourceSchema.safeParse('bing-webmaster').success).toBe(true)
    expect(backlinkSourceSchema.safeParse('ahrefs').success).toBe(false)
    expect(backlinkSourceSchema.safeParse('').success).toBe(false)
  })
})

describe('source-tagged backlink DTOs', () => {
  it('domain dto carries the source discriminator', () => {
    const parsed = backlinkDomainDtoSchema.parse({ linkingDomain: 'foo.com', numHosts: 3, source: 'bing-webmaster' })
    expect(parsed.source).toBe('bing-webmaster')
  })

  it('summary dto carries the source discriminator', () => {
    const parsed = backlinkSummaryDtoSchema.parse({
      projectId: 'p',
      release: 'bing-2026-06-15',
      targetDomain: 'foo.com',
      totalLinkingDomains: 2,
      totalHosts: 5,
      top10HostsShare: '1.000000',
      queriedAt: '2026-06-15T00:00:00Z',
      source: 'bing-webmaster',
    })
    expect(parsed.source).toBe('bing-webmaster')
  })

  it('history entry carries the source discriminator', () => {
    const parsed = backlinkHistoryEntrySchema.parse({
      release: 'cc-main-2026-jan-feb-mar',
      totalLinkingDomains: 1,
      totalHosts: 1,
      top10HostsShare: '1.000000',
      queriedAt: '2026-06-15T00:00:00Z',
      source: 'commoncrawl',
    })
    expect(parsed.source).toBe('commoncrawl')
  })

  it('list response echoes the source it was filtered to', () => {
    const parsed = backlinkListResponseSchema.parse({
      source: 'commoncrawl',
      summary: null,
      total: 0,
      rows: [],
    })
    expect(parsed.source).toBe('commoncrawl')
  })
})

describe('backlink source availability response', () => {
  it('parses a both-connected payload', () => {
    const payload = {
      projectId: 'p1',
      targetDomain: 'foo.com',
      sources: [
        {
          source: 'commoncrawl',
          connected: true,
          hasData: true,
          latestRelease: 'cc-main-2026-jan-feb-mar',
          totalLinkingDomains: 42,
          lastSyncedAt: '2026-06-01T00:00:00Z',
        },
        {
          source: 'bing-webmaster',
          connected: true,
          hasData: false,
          latestRelease: null,
          totalLinkingDomains: 0,
          lastSyncedAt: null,
        },
      ],
      anyConnected: true,
      anyData: true,
    }
    const parsed = backlinkSourcesResponseSchema.parse(payload)
    expect(parsed.sources.length).toBe(2)
    expect(parsed.anyConnected).toBe(true)
    expect(parsed.anyData).toBe(true)
    expect(parsed.sources[1]!.source).toBe('bing-webmaster')
  })

  it('requires the source discriminator on each availability entry', () => {
    const bad = backlinkSourceAvailabilityDtoSchema.safeParse({
      connected: true,
      hasData: false,
      latestRelease: null,
      totalLinkingDomains: 0,
      lastSyncedAt: null,
    })
    expect(bad.success).toBe(false)
  })
})
