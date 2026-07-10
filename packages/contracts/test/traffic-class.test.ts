import { describe, expect, it } from 'vitest'
import {
  aiReferralClassCounts,
  classifyAiReferralTrafficClass,
  formatAiReferralClassSummary,
} from '../src/traffic-class.js'

describe('classifyAiReferralTrafficClass', () => {
  it('classifies tagged ChatGPT ad traffic as paid and ordinary AI referrals as organic', () => {
    expect(classifyAiReferralTrafficClass({
      source: 'chatgpt.com',
      medium: 'cpc',
      channelGroup: 'Paid Other',
      landingPage: '/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=openai_ads',
    })).toBe('paid')

    expect(classifyAiReferralTrafficClass({
      source: 'chatgpt.com',
      medium: 'referral',
      channelGroup: 'Referral',
      landingPage: '/pricing?utm_source=chatgpt',
    })).toBe('organic')
  })

  it('finds paid intent in each evidence field independently', () => {
    const organic = { source: 'chatgpt', medium: 'referral', channelGroup: 'Referral', landingPage: '/x' }
    expect(classifyAiReferralTrafficClass(organic)).toBe('organic')

    expect(classifyAiReferralTrafficClass({ ...organic, channelGroup: 'Paid Search' })).toBe('paid')
    expect(classifyAiReferralTrafficClass({ ...organic, medium: 'cpc' })).toBe('paid')
    expect(classifyAiReferralTrafficClass({ ...organic, source: 'openai-ads' })).toBe('paid')
    expect(classifyAiReferralTrafficClass({ ...organic, landingPage: '/x?utm_campaign=paid_ai' })).toBe('paid')
  })

  it('treats a channelGroup with a "paid " prefix as paid even when unlisted', () => {
    expect(classifyAiReferralTrafficClass({ channelGroup: 'Paid Something New' })).toBe('paid')
  })

  it('does not read paid intent out of a substring of a longer word', () => {
    // "adsense" tokenizes to a single token, not "ad" + "sense".
    expect(classifyAiReferralTrafficClass({ medium: 'adsense' })).toBe('organic')
    // "broadcast" contains "ad" but is one token.
    expect(classifyAiReferralTrafficClass({ source: 'broadcast' })).toBe('organic')
    // Delimiters do split, so a compound carrying a real token is paid.
    expect(classifyAiReferralTrafficClass({ medium: 'social-cpc' })).toBe('paid')
  })

  it('returns organic when nothing is known', () => {
    expect(classifyAiReferralTrafficClass({})).toBe('organic')
    expect(classifyAiReferralTrafficClass({
      source: null, medium: null, channelGroup: null, landingPage: null,
    })).toBe('organic')
  })

  it('ignores an unparseable landing page rather than throwing', () => {
    expect(classifyAiReferralTrafficClass({ landingPage: '::::' })).toBe('organic')
  })
})

describe('aiReferralClassCounts', () => {
  it('derives unknown as the residual so unclassified rows never read as organic', () => {
    // A bucket written before the ingest classifier shipped: total, no split.
    expect(aiReferralClassCounts(37, 0, 0)).toEqual({ total: 37, paid: 0, organic: 0, unknown: 37 })
  })

  it('reports zero unknown once every session in the bucket is classified', () => {
    expect(aiReferralClassCounts(10, 7, 3)).toEqual({ total: 10, paid: 7, organic: 3, unknown: 0 })
  })

  it('splits a bucket that mixes paid and organic with a legacy remainder', () => {
    expect(aiReferralClassCounts(10, 6, 1)).toEqual({ total: 10, paid: 6, organic: 1, unknown: 3 })
  })

  it('clamps a negative residual to zero rather than emitting a nonsense count', () => {
    // Defensive: the writers keep paid + organic <= total, but a corrupt row
    // must not produce a negative "unknown" that a caller would sum.
    expect(aiReferralClassCounts(5, 4, 4)).toEqual({ total: 5, paid: 4, organic: 4, unknown: 0 })
  })

  it('handles an empty window', () => {
    expect(aiReferralClassCounts(0, 0, 0)).toEqual({ total: 0, paid: 0, organic: 0, unknown: 0 })
  })
})

describe('formatAiReferralClassSummary', () => {
  it('renders every non-zero class, in paid → organic → unclassified order', () => {
    expect(formatAiReferralClassSummary(aiReferralClassCounts(10, 6, 1)))
      .toBe('Paid 6 · Organic 1 · Unclassified 3')
  })

  it('omits zero classes', () => {
    expect(formatAiReferralClassSummary(aiReferralClassCounts(10, 7, 3))).toBe('Paid 7 · Organic 3')
    expect(formatAiReferralClassSummary(aiReferralClassCounts(4, 0, 4))).toBe('Organic 4')
  })

  it('names a fully unclassified window rather than leaving it blank', () => {
    expect(formatAiReferralClassSummary(aiReferralClassCounts(37, 0, 0))).toBe('Unclassified 37')
  })

  it('abbreviates large counts the way the rest of the report does', () => {
    expect(formatAiReferralClassSummary(aiReferralClassCounts(1500, 1200, 300)))
      .toBe('Paid 1.2K · Organic 300')
  })

  it('renders an empty string for an empty window so the tile shows no stray separator', () => {
    expect(formatAiReferralClassSummary(aiReferralClassCounts(0, 0, 0))).toBe('')
  })
})
