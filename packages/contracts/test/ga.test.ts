import { describe, expect, it } from 'vitest'
import {
  ga4AiReferralHistoryEntrySchema,
  ga4TrafficSummaryDtoSchema,
  gaSearchLandingHasSearchData,
  gaSearchLandingPageLabel,
} from '../src/ga.js'
import type { GaSearchLandingMetrics } from '../src/ga.js'

describe('GA contracts', () => {
  it('includes known-AI referral landing-page rows in the traffic summary contract', () => {
    const parsed = ga4TrafficSummaryDtoSchema.parse({
      totalSessions: 100,
      totalOrganicSessions: 30,
      totalDirectSessions: 20,
      totalUsers: 80,
      topPages: [],
      aiReferrals: [],
      aiReferralLandingPages: [
        {
          source: 'chatgpt.com',
          medium: 'referral',
          trafficClass: 'organic',
          sourceDimension: 'session',
          landingPage: '/pricing',
          sessions: 12,
        },
      ],
      aiSessionsDeduped: 12,
      paidAiSessionsDeduped: 0,
      organicAiSessionsDeduped: 12,
      aiSessionsBySession: 12,
      paidAiSessionsBySession: 0,
      organicAiSessionsBySession: 12,
      socialReferrals: [],
      socialSessions: 0,
      socialUsers: 0,
      channelBreakdown: {
        organic: { sessions: 30, sharePct: 30, sharePctDisplay: '30%' },
        social: { sessions: 0, sharePct: 0, sharePctDisplay: '0%' },
        direct: { sessions: 20, sharePct: 20, sharePctDisplay: '20%' },
        ai: { sessions: 12, sharePct: 12, sharePctDisplay: '12%' },
        other: { sessions: 38, sharePct: 38, sharePctDisplay: '38%' },
      },
      organicSharePct: 30,
      aiSharePct: 12,
      aiSharePctBySession: 12,
      paidAiSharePct: 0,
      paidAiSharePctBySession: 0,
      organicAiSharePct: 12,
      organicAiSharePctBySession: 12,
      directSharePct: 20,
      socialSharePct: 0,
      organicSharePctDisplay: '30%',
      aiSharePctDisplay: '12%',
      aiSharePctBySessionDisplay: '12%',
      paidAiSharePctDisplay: '0%',
      paidAiSharePctBySessionDisplay: '0%',
      organicAiSharePctDisplay: '12%',
      organicAiSharePctBySessionDisplay: '12%',
      directSharePctDisplay: '20%',
      socialSharePctDisplay: '0%',
      otherSessions: 38,
      otherSharePct: 38,
      otherSharePctDisplay: '38%',
      lastSyncedAt: null,
    })

    expect(parsed.aiReferralLandingPages[0]!.landingPage).toBe('/pricing')

    // The AI-referral user counts were withdrawn in 4.135.0: /ga/traffic stops
    // emitting them, and the schema keeps them optional so an existing consumer
    // still parses the response and reads `undefined` rather than throwing on a
    // missing required field (or reading an inflated number).
    expect(parsed.aiUsersDeduped).toBeUndefined()
    expect(parsed.paidAiUsersDeduped).toBeUndefined()
    expect(parsed.organicAiUsersDeduped).toBeUndefined()
    expect(parsed.aiUsersBySession).toBeUndefined()
    expect(parsed.paidAiUsersBySession).toBeUndefined()
    expect(parsed.organicAiUsersBySession).toBeUndefined()
    expect(parsed.aiReferralLandingPages[0]!.users).toBeUndefined()
  })

  it('includes landingPage in AI referral history entries', () => {
    const parsed = ga4AiReferralHistoryEntrySchema.parse({
      date: '2026-03-20',
      source: 'perplexity.ai',
      medium: 'referral',
      trafficClass: 'organic',
      sourceDimension: 'session',
      landingPage: '/guide',
      sessions: 7,
      users: 6,
    })

    expect(parsed.landingPage).toBe('/guide')
  })

  it('reads Google organic search data from the Total\'s clicks and impressions, never from rows or users', () => {
    const total = (clicks: number, impressions: number, activeUsers: number): GaSearchLandingMetrics => ({
      organicGoogleSearchClicks: clicks,
      organicGoogleSearchImpressions: impressions,
      organicGoogleSearchClickThroughRate: impressions > 0 ? clicks / impressions : null,
      organicGoogleSearchAveragePosition: impressions > 0 ? 6.5 : null,
      activeUsers,
    })

    // 0 clicks and 0 impressions is no search data, even with active users
    // (GA4 lists such pages as rows).
    expect(gaSearchLandingHasSearchData(total(0, 0, 0))).toBe(false)
    expect(gaSearchLandingHasSearchData(total(0, 0, 41))).toBe(false)
    // Impressions alone are search data: the pages showed in Google results.
    expect(gaSearchLandingHasSearchData(total(0, 380, 0))).toBe(true)
    expect(gaSearchLandingHasSearchData(total(12, 380, 9))).toBe(true)
  })
})

describe('gaSearchLandingPageLabel', () => {
  it('labels only the empty landing page and passes every GA4 value through', () => {
    expect(gaSearchLandingPageLabel('')).toBe('(empty)')
    expect(gaSearchLandingPageLabel('(not set)')).toBe('(not set)')
    expect(gaSearchLandingPageLabel('/')).toBe('/')
    expect(gaSearchLandingPageLabel('/pricing?ref=a')).toBe('/pricing?ref=a')
  })
})
