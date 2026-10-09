export interface GA4ServiceAccountKey {
  client_email: string
  private_key: string
  project_id?: string
  type?: string
}

export interface GA4RunReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>
  dimensions: Array<{ name: string }>
  metrics: Array<{ name: string }>
  dimensionFilter?: {
    filter: {
      fieldName: string
      stringFilter?: { matchType: string; value: string }
    }
  } | {
    orGroup: {
      expressions: Array<{
        filter: {
          fieldName: string
          stringFilter: { matchType: string; value: string }
        }
      }>
    }
  }
  /** Ask GA4 to compute aggregate rows (returned in `totals` for `TOTAL`). */
  metricAggregations?: Array<'TOTAL' | 'MAXIMUM' | 'MINIMUM' | 'COUNT'>
  orderBys?: Array<{
    metric?: { metricName: string }
    dimension?: { dimensionName: string }
    desc?: boolean
  }>
  limit?: number
  offset?: number
}

export interface GA4ReportRow {
  dimensionValues: Array<{ value: string }>
  metricValues: Array<{ value: string }>
}

export interface GA4RunReportResponse {
  dimensionHeaders?: Array<{ name: string }>
  metricHeaders?: Array<{ name: string; type?: string }>
  rows?: GA4ReportRow[]
  /**
   * Rows GA4 computed for `metricAggregations`, each with its dimension values
   * set to `RESERVED_<AGGREGATION>` (`RESERVED_TOTAL` for `TOTAL`).
   */
  totals?: GA4ReportRow[]
  /** Every row the report has, not just this page's. */
  rowCount?: number
  metadata?: {
    currencyCode?: string
    timeZone?: string
    emptyReason?: string
    subjectToThresholding?: boolean
    dataLossFromOtherRow?: boolean
  }
  kind?: string
}

/** One landing page's metrics, or the report's Total, as GA4 reported them. */
export interface GA4SearchLandingMetrics {
  clicks: number
  impressions: number
  /** GA4's click-through rate (0..1); null when there were no impressions. */
  ctr: number | null
  /** GA4's average position; null when there were no impressions. */
  averagePosition: number | null
  activeUsers: number
}

export interface GA4SearchLandingPageRow extends GA4SearchLandingMetrics {
  /** GA4's `landingPagePlusQueryString`, exactly as reported. */
  landingPage: string
}

export interface GA4SearchLandingWindowReport {
  window: GaSearchLandingWindow
  /** Inclusive first day, in the property's time zone. */
  periodStart: string
  /** Inclusive last day (yesterday at request time, in the property's time zone). */
  periodEnd: string
  /** `metadata.timeZone`; null when GA4 did not report one (dates then fall back to UTC). */
  timeZone: string | null
  /** GA4's own TOTAL row. Never a sum of `rows`. */
  total: GA4SearchLandingMetrics
  rows: GA4SearchLandingPageRow[]
  /** Rows GA4 reported for the window (`rowCount`). */
  reportRowCount: number
  /** True when fewer rows were read than GA4 reported. */
  rowsCapped: boolean
  subjectToThresholding: boolean
  dataLossFromOtherRow: boolean
}

export type GA4SearchLandingReport =
  | { status: 'ready'; windows: GA4SearchLandingWindowReport[] }
  | { status: 'unavailable'; reason: string }

export interface GA4TrafficRow {
  date: string
  landingPage: string
  sessions: number
  organicSessions: number
  /**
   * Sessions whose `sessionDefaultChannelGrouping` is `Direct` — i.e., GA4
   * couldn't attribute a source. The dark-traffic bucket lives here on
   * deep pages with no UTM, which is also where AI-driven traffic
   * (referrer-stripped) lands. Captured via a separate filtered Reports
   * API pass; defaults to 0 for landing pages absent from the Direct
   * channel response.
   */
  directSessions: number
  users: number
}

export interface GA4AcquisitionRow {
  date: string
  channelGroup: string
  source: string
  medium: string
  hostName: string
  landingPage: string
  sessions: number
}

export interface GA4LeadEventRow {
  date: string
  eventName: string
  channelGroup: string
  source: string
  medium: string
  hostName: string
  landingPage: string
  eventCount: number
}

export interface GA4AcquisitionReport {
  startDate: string
  endDate: string
  rows: GA4AcquisitionRow[]
}

export interface GA4LeadEventReport {
  startDate: string
  endDate: string
  attributionScope: 'landing-page' | 'channel'
  rows: GA4LeadEventRow[]
}


export type { AiReferralTrafficClass, GA4SourceDimension } from '@ainyc/canonry-contracts'
import type { AiReferralTrafficClass, GA4SourceDimension, GaSearchLandingWindow } from '@ainyc/canonry-contracts'

export interface GA4AiReferralRow {
  date: string
  source: string
  medium: string
  trafficClass: AiReferralTrafficClass
  /** GA4 default channel group for the current session. */
  channelGroup: string
  landingPage: string
  sessions: number
  users: number
  sourceDimension: GA4SourceDimension
}

export interface GA4SocialReferralRow {
  date: string
  source: string
  medium: string
  sessions: number
  users: number
  /** GA4 default channel group that classified this as social (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: string
}

export class GA4ApiError extends Error {
  public status: number
  /** Seconds the GA4 API asked us to wait before retrying. Populated from the
   *  `Retry-After` response header on 429 and 5xx responses when present. */
  public retryAfterSeconds?: number
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'GA4ApiError'
    this.status = status
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}
