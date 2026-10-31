import type {
  AgentTrust,
  AgentTrustReason,
  AiReferralTrafficClass,
  NormalizedTrafficRequest,
  TrafficVerificationManifest,
} from '@canonry/canonry-contracts'

export type CrawlerVerificationStatus = 'verified' | 'claimed_unverified' | 'unknown_ai_like'
export type AiReferralEvidenceType = 'referer' | 'utm' | 'referer-utm'

export interface AiCrawlerRule {
  id: string
  operator: string
  product: string
  purpose: string
  userAgentPatterns: RegExp[]
  /**
   * The operator's published FULL user-agent string(s), for user-triggered
   * agents only. Set it only when the operator labels the string as the full
   * string (not an example). A matching request whose user agent differs is
   * judged likely fake. Leave it unset when no exact string is published.
   */
  documentedUserAgents?: RegExp[]
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
  verificationManifest: TrafficVerificationManifest | null
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
  verificationManifest: TrafficVerificationManifest | null
  matchedUserAgent: string
  trust: AgentTrust
  /** Display order; never empty. */
  trustReasons: AgentTrustReason[]
}

export interface ClassifiedAiReferral {
  operator: string
  product: string
  sourceDomain: string
  evidenceType: AiReferralEvidenceType
  /**
   * Paid vs organic, decided from the event's UTM tags. Orthogonal to
   * `evidenceType`, which only says which signal identified the engine.
   */
  trafficClass: AiReferralTrafficClass
}

export interface CrawlerEventHourlyBucket {
  tsHour: string
  botId: string
  operator: string
  product: string
  verificationStatus: CrawlerVerificationStatus
  verificationManifest: TrafficVerificationManifest | null
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
  verificationManifest: TrafficVerificationManifest | null
  pathNormalized: string
  status: number | null
  hits: number
  sampledUserAgent: string | null
}

/** Likely fake agent requests, keyed by their first reason. Kept out of AI user fetch buckets. */
export interface AiUserFetchLikelyFakeHourlyBucket {
  tsHour: string
  botId: string
  operator: string
  reason: AgentTrustReason
  hits: number
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
  /**
   * Traffic class is a property of the arriving session, not of the bucket's
   * identity — one hour, product, domain, evidence type, and landing path can
   * legitimately carry both paid and organic arrivals. So the class splits the
   * MEASURE rather than joining the key: `paidHits + organicHits === hits` for
   * every bucket this rollup emits.
   */
  paidHits: number
  organicHits: number
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
    /** Events rolled up (after dropping Canonry self-traffic). */
    normalizedEvents: number
    /** Self-traffic events (Canonry's own tooling) dropped before rollup. */
    selfTrafficExcluded: number
    crawlerHits: number
    /** Requests from user-triggered agents, excluding likely fake ones. */
    aiUserFetchHits: number
    /** Requests that claim a user-triggered agent but are judged likely fake. */
    aiUserFetchLikelyFakeHits: number
    aiReferralSessions: number
    /** Sessions carrying paid-attribution UTM evidence. Sums with `aiReferralOrganicSessions` to `aiReferralSessions`. */
    aiReferralPaidSessions: number
    /** Sessions with no paid-attribution evidence. */
    aiReferralOrganicSessions: number
    aiReferralHits: number
    unknownHits: number
  }
  crawlerEventsHourly: CrawlerEventHourlyBucket[]
  aiUserFetchEventsHourly: AiUserFetchEventHourlyBucket[]
  aiUserFetchLikelyFakeHourly: AiUserFetchLikelyFakeHourlyBucket[]
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
