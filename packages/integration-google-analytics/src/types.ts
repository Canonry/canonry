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
  limit?: number
  offset?: number
}

export interface GA4RunReportResponse {
  rows?: Array<{
    dimensionValues: Array<{ value: string }>
    metricValues: Array<{ value: string }>
  }>
  rowCount?: number
  metadata?: {
    currencyCode?: string
    timeZone?: string
  }
}

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

export type { GA4SourceDimension } from '@ainyc/canonry-contracts'
import type { GA4SourceDimension } from '@ainyc/canonry-contracts'

export interface GA4AiReferralRow {
  date: string
  source: string
  medium: string
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
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GA4ApiError'
    this.status = status
  }
}
