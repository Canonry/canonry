export interface BingSite {
  Url: string
  /**
   * Whether the site is verified in Bing Webmaster Tools (DNS / HTML file /
   * Meta tag). Field name follows Bing's actual `GetUserSites` JSON payload
   * exactly — historically this was modelled as `Verified` here, but the
   * live API returns `IsVerified` and the `Verified` field was always
   * undefined, which made every doctor "site-access" check fail.
   */
  IsVerified?: boolean
}

export interface BingUrlInfo {
  Url: string
  // Documented UrlInfo fields from Bing's published contract:
  // https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.urlinfo?view=bing-webmaster-dotnet
  // WSDL: https://ssl.bing.com/webmaster/api.svc?singleWsdl
  DocumentSize?: number
  AnchorCount?: number
  DiscoveryDate?: string
  LastCrawledDate?: string
  IsPage?: boolean
  HttpStatus?: number
  TotalChildUrlCount?: number
  // Legacy/undocumented fields observed in older integrations. Keep as fallbacks.
  // Note: `InIndex` was retired from the public UrlInfo contract — Microsoft's
  // current schema (https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.urlinfo)
  // lists only the eight crawl-related properties above.
  HttpCode?: number
  InIndexDate?: string
  CacheDate?: string
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
  /** -1 when there are zero clicks (Bing sentinel). */
  AvgClickPosition: number
  AvgImpressionPosition: number
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
