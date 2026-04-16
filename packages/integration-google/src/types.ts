export interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

export interface GscSite {
  siteUrl: string
  permissionLevel: string
}

export interface GscSearchAnalyticsRequest {
  startDate: string
  endDate: string
  dimensions: string[]
  rowLimit?: number
  startRow?: number
  dimensionFilterGroups?: Array<{
    groupType?: string
    filters: Array<{
      dimension: string
      operator: string
      expression: string
    }>
  }>
}

export interface GscSearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[]
  responseAggregationType?: string
}

export interface GscUrlInspectionResult {
  inspectionResult: {
    inspectionResultLink?: string
    indexStatusResult?: {
      verdict?: string
      coverageState?: string
      robotsTxtState?: string
      indexingState?: string
      lastCrawlTime?: string
      pageFetchState?: string
      googleCanonical?: string
      userCanonical?: string
      referringUrls?: string[]
      crawlResult?: string
    }
    mobileUsabilityResult?: {
      verdict?: string
      issues?: Array<{ issueType: string; severity: string; message: string }>
    }
    richResultsResult?: {
      verdict?: string
      detectedItems?: Array<{ richResultType: string; items: unknown[] }>
    }
  }
}

export interface GscSitemapContent {
  type: string
  submitted: string
  indexed: string
}

export interface GscSitemap {
  path: string
  lastSubmitted?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  type?: string
  lastDownloaded?: string
  warnings?: string
  errors?: string
  contents?: GscSitemapContent[]
}

export interface IndexingApiNotification {
  url: string
  type: 'URL_UPDATED' | 'URL_DELETED'
}

export interface IndexingApiResponse {
  urlNotificationMetadata: {
    url: string
    latestUpdate?: {
      url: string
      type: string
      notifyTime: string
    }
    latestRemove?: {
      url: string
      type: string
      notifyTime: string
    }
  }
}

export class GoogleAuthError extends Error {
  public statusCode?: number
  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'GoogleAuthError'
    this.statusCode = statusCode
  }
}

export class GoogleApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GoogleApiError'
    this.status = status
  }
}
