import { z } from 'zod'
import { formatNumber } from './formatting.js'

/**
 * Paid vs organic for an AI referral.
 *
 * Two ingest paths decide this — GA4 (`ga_ai_referrals.traffic_class`) and the
 * server-side request classifier (`ai_referral_events_hourly`) — so the rules
 * live here rather than in either consumer. Both mean the same thing by
 * `organic`: no paid attribution evidence was found. An untagged ad click is
 * indistinguishable from an organic click on both surfaces.
 */
export const aiReferralTrafficClassSchema = z.enum(['organic', 'paid'])
export type AiReferralTrafficClass = z.infer<typeof aiReferralTrafficClassSchema>
export const AiReferralTrafficClasses = aiReferralTrafficClassSchema.enum

const PAID_CHANNEL_GROUPS = new Set([
  'paid search',
  'paid social',
  'paid shopping',
  'paid video',
  'paid other',
  'display',
  'cross-network',
])

const PAID_SOURCE_OR_MEDIUM_VALUES = new Set([
  'ad',
  'ads',
  'cpa',
  'cpc',
  'cpm',
  'cpv',
  'display',
  'openai-ads',
  'openai_ads',
  'paid',
  'paid-ai',
  'paid_ai',
  'paidai',
  'ppc',
  'retargeting',
  'sponsored',
])

const PAID_QUERY_PARAMS = ['utm_medium', 'utm_campaign', 'utm_content', 'utm_term']

function normalizedTokens(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function hasPaidToken(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return false
  if (PAID_SOURCE_OR_MEDIUM_VALUES.has(normalized)) return true
  return normalizedTokens(normalized).some((token) => PAID_SOURCE_OR_MEDIUM_VALUES.has(token))
}

function hasPaidLandingPageParam(landingPage: string | null | undefined): boolean {
  if (!landingPage) return false
  try {
    const url = new URL(landingPage, 'https://canonry.local')
    return PAID_QUERY_PARAMS.some((key) => hasPaidToken(url.searchParams.get(key)))
  } catch {
    return false
  }
}

/**
 * Decide paid vs organic from whatever attribution evidence a surface has.
 *
 * `channelGroup` is GA4's strongest discriminator and has no server-side
 * equivalent; pass `null` when the caller cannot observe one. Returning
 * `organic` means "no paid evidence", never "confirmed organic".
 */
export function classifyAiReferralTrafficClass(input: {
  source?: string | null
  medium?: string | null
  channelGroup?: string | null
  landingPage?: string | null
}): AiReferralTrafficClass {
  const channelGroup = (input.channelGroup ?? '').trim().toLowerCase()
  if (PAID_CHANNEL_GROUPS.has(channelGroup) || channelGroup.startsWith('paid ')) {
    return AiReferralTrafficClasses.paid
  }
  if (
    hasPaidToken(input.medium) ||
    hasPaidToken(input.source) ||
    hasPaidLandingPageParam(input.landingPage)
  ) {
    return AiReferralTrafficClasses.paid
  }
  return AiReferralTrafficClasses.organic
}

/**
 * Server-side AI-referral session counts, split by traffic class.
 *
 * `unknown` is a residual, not a stored class: `total - paid - organic`. Rows
 * written before the ingest classifier shipped carry `paid = organic = 0`, so
 * their whole total surfaces as unknown rather than masquerading as organic —
 * the mistake migration v95 made on the GA4 side.
 */
export interface AiReferralClassCounts {
  total: number
  paid: number
  organic: number
  unknown: number
}

export function aiReferralClassCounts(total: number, paid: number, organic: number): AiReferralClassCounts {
  return { total, paid, organic, unknown: Math.max(0, total - paid - organic) }
}

/**
 * One-line class breakdown for the AI-referral tile, e.g. `Paid 1.2K · Organic 24`.
 *
 * Computed once in the API so the HTML report and the SPA render the identical
 * string (report parity), and so no surface can quietly drop `Unclassified`.
 * Zero-count classes are omitted; an all-zero window renders as `''`.
 */
export function formatAiReferralClassSummary(counts: AiReferralClassCounts): string {
  const parts: string[] = []
  if (counts.paid > 0) parts.push(`Paid ${formatNumber(counts.paid)}`)
  if (counts.organic > 0) parts.push(`Organic ${formatNumber(counts.organic)}`)
  if (counts.unknown > 0) parts.push(`Unclassified ${formatNumber(counts.unknown)}`)
  return parts.join(' · ')
}
