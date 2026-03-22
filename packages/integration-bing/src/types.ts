export interface BingSite {
  Url: string
  Verified?: boolean
}

export interface BingUrlInfo {
  Url: string
  // InIndex and HttpCode are in the SOAP schema but never populated by the API
  HttpCode?: number
  InIndex?: boolean
  InIndexDate?: string
  CacheDate?: string
  // These fields are actually returned and are the reliable index signals
  DocumentSize?: number
  AnchorCount?: number
  DiscoveryDate?: string
  LastCrawledDate?: string
  IsPage?: boolean
  HttpStatus?: number
  TotalChildUrlCount?: number
}

export interface BingPageStats {
  Date: string
  Impressions: number
  Clicks: number
  Ctr: number
  AveragePosition: number
  Query?: string
  Page?: string
}

export interface BingKeywordStats {
  Query: string
  Impressions: number
  Clicks: number
  Ctr: number
  AverageClickPosition: number
  AverageImpressionPosition: number
}

export interface BingCrawlStats {
  Date: string
  CrawledPages: number
  InIndex: number
  CrawlErrors: number
  BlockedByRobotsTxt?: number
  HttpErrors?: Record<string, number>
}

export interface BingCrawlIssue {
  Url: string
  HttpCode: number
  Date: string
  IssueType?: string
}

export interface BingSubmitUrlResponse {
  d?: null
}

export interface BingSubmitUrlBatchResponse {
  d?: null
}

export class BingApiError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'BingApiError'
    this.status = status
  }
}
