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
    filter?: {
      fieldName: string
      stringFilter?: { matchType: string; value: string }
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
  users: number
}

export class GA4ApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GA4ApiError'
    this.status = status
  }
}
