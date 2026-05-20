import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'

export type CrawlerVerificationStatus = 'verified' | 'claimed_unverified' | 'unknown_ai_like'
export type AiReferralEvidenceType = 'referer' | 'utm' | 'referer-utm'

export interface AiCrawlerRule {
  id: string
  operator: string
  product: string
  purpose: string
  userAgentPatterns: RegExp[]
}

export interface AiReferrerRule {
  domain: string
  operator: string
  product: string
}

export interface ClassifiedCrawler {
  botId: string
  operator: string
  product: string
  purpose: string
  verificationStatus: CrawlerVerificationStatus
  matchedUserAgent: string
}

// On-demand per-user fetches from an AI surface (ChatGPT-User, Perplexity-User,
// MistralAI-User, …). Same UA evidence channel as ClassifiedCrawler, but kept
// in a distinct type so the dashboard, API, and report can split "machine
// crawl" from "human-in-the-loop fetch". See rules.ts for the `purpose:
// 'user-agent'` discriminator.
export interface ClassifiedAiUserFetch {
  botId: string
  operator: string
  product: string
  verificationStatus: CrawlerVerificationStatus
  matchedUserAgent: string
}

export interface ClassifiedAiReferral {
  operator: string
  product: string
  sourceDomain: string
  evidenceType: AiReferralEvidenceType
}

export interface CrawlerEventHourlyBucket {
  tsHour: string
  botId: string
  operator: string
  product: string
  verificationStatus: CrawlerVerificationStatus
  pathNormalized: string
  status: number | null
  hits: number
  sampledUserAgent: string | null
}

export interface AiUserFetchEventHourlyBucket {
  tsHour: string
  botId: string
  operator: string
  product: string
  verificationStatus: CrawlerVerificationStatus
  pathNormalized: string
  status: number | null
  hits: number
  sampledUserAgent: string | null
}

export interface AiReferralEventHourlyBucket {
  tsHour: string
  operator: string
  product: string
  sourceDomain: string
  evidenceType: AiReferralEvidenceType
  landingPathNormalized: string
  status: number | null
  hits: number
}

export interface TrafficProbeSample {
  eventId: string
  observedAt: string
  sourceType: NormalizedTrafficRequest['sourceType']
  path: string
  pathNormalized: string
  status: number | null
  userAgent: string | null
  referer: string | null
  crawler: ClassifiedCrawler | null
  aiUserFetch: ClassifiedAiUserFetch | null
  aiReferral: ClassifiedAiReferral | null
}

export interface TrafficProbeReport {
  generatedAt: string
  totals: {
    normalizedEvents: number
    crawlerHits: number
    aiUserFetchHits: number
    aiReferralSessions: number
    aiReferralHits: number
    unknownHits: number
  }
  crawlerEventsHourly: CrawlerEventHourlyBucket[]
  aiUserFetchEventsHourly: AiUserFetchEventHourlyBucket[]
  aiReferralEventsHourly: AiReferralEventHourlyBucket[]
  topBots: Array<{ botId: string; operator: string; hits: number }>
  topCrawlerPaths: Array<{ pathNormalized: string; hits: number }>
  topAiUserFetchBots: Array<{ botId: string; operator: string; hits: number }>
  topAiUserFetchPaths: Array<{ pathNormalized: string; hits: number }>
  topAiReferrers: Array<{ sourceDomain: string; product: string; hits: number }>
  topAiReferralLandingPaths: Array<{ landingPathNormalized: string; hits: number }>
  samples: TrafficProbeSample[]
}

export interface BuildTrafficProbeReportOptions {
  generatedAt?: string
  sampleLimit?: number
  aiReferralSessionWindowMs?: number
}
