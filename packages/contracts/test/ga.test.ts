import { describe, expect, it } from 'vitest'
import {
  ga4AiReferralHistoryEntrySchema,
  ga4TrafficSummaryDtoSchema,
} from '../src/ga.js'

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
          sourceDimension: 'session',
          landingPage: '/pricing',
          sessions: 12,
          users: 9,
        },
      ],
      aiSessionsDeduped: 12,
      aiUsersDeduped: 9,
      aiSessionsBySession: 12,
      aiUsersBySession: 9,
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
      directSharePct: 20,
      socialSharePct: 0,
      organicSharePctDisplay: '30%',
      aiSharePctDisplay: '12%',
      aiSharePctBySessionDisplay: '12%',
      directSharePctDisplay: '20%',
      socialSharePctDisplay: '0%',
      otherSessions: 38,
      otherSharePct: 38,
      otherSharePctDisplay: '38%',
      lastSyncedAt: null,
    })

    expect(parsed.aiReferralLandingPages[0]!.landingPage).toBe('/pricing')
  })

  it('includes landingPage in AI referral history entries', () => {
    const parsed = ga4AiReferralHistoryEntrySchema.parse({
      date: '2026-03-20',
      source: 'perplexity.ai',
      medium: 'referral',
      sourceDimension: 'session',
      landingPage: '/guide',
      sessions: 7,
      users: 6,
    })

    expect(parsed.landingPage).toBe('/guide')
  })
})
