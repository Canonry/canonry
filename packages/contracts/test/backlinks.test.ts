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
} from '../src/index.js'

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
