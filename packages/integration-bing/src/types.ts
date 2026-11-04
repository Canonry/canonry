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

/**
 * Bing serializes every date as a WCF JSON date: `/Date(<epoch ms>)/`, with an
 * optional `+hhmm` / `-hhmm` offset. Kept as the raw string here so the client
 * never guesses a timezone; `parseBingDate` turns it into ISO.
 */
export type BingWcfDate = string

/**
 * One row of `GetQueryStats`, `GetPageStats`, `GetQueryPageStats` and
 * `GetPageQueryStats` (Bing's `QueryStats` contract). Field names follow the
 * captured payload exactly.
 *
 * - `Query` is overloaded by Bing: it holds the search query for
 *   `GetQueryStats` / `GetPageQueryStats` and the PAGE URL for `GetPageStats` /
 *   `GetQueryPageStats`.
 * - `Date` is a weekly bucket, not a day: a site's rows repeat once per week.
 * - `AvgClickPosition` is `-1` when the row had no clicks (Bing sentinel).
 */
export interface BingQueryStats {
  Query: string
  Date: BingWcfDate
  Impressions: number
  Clicks: number
  AvgClickPosition: number
  AvgImpressionPosition: number
}

/** `GetRankAndTrafficStats` / `GetQueryTrafficStats`: one row per DAY. */
export interface BingRankAndTrafficStats {
  Date: BingWcfDate
  Clicks: number
  Impressions: number
}

/** `GetQueryPageDetailStats`: one row per week for a single query on a single page. */
export interface BingDetailedQueryStats {
  Date: BingWcfDate
  Clicks: number
  Impressions: number
  Position: number
}

/** `GetCrawlStats`: one row per day. Every field below is in the captured payload. */
export interface BingCrawlStats {
  Date: BingWcfDate
  CrawledPages: number
  InIndex: number
  CrawlErrors: number
  InLinks?: number
  Code2xx?: number
  Code301?: number
  Code302?: number
  Code4xx?: number
  Code5xx?: number
  AllOtherCodes?: number
  BlockedByRobotsTxt?: number
  ConnectionTimeout?: number
  ContainsMalware?: number
  DnsFailures?: number
}

/**
 * `GetCrawlIssues` (Bing's `UrlWithCrawlIssues`). Microsoft documents `Url`,
 * `HttpCode`, `InLinks` and `Issues` (a flags enum). Every live capture so far
 * returned an empty list, so `IssueType` / `Date` stay as the legacy fallbacks
 * the inspection path already reads.
 */
export interface BingCrawlIssue {
  Url: string
  HttpCode: number
  InLinks?: number
  Issues?: number | string
  Date?: string
  IssueType?: string
}

/** `GetUrlTrafficInfo` / `GetChildrenUrlTrafficInfo`. */
export interface BingUrlTrafficInfo {
  Url: string
  Clicks: number
  Impressions: number
  IsPage: boolean
}

/** `GetFeeds` / `GetFeedDetails`: a submitted sitemap, sitemap index or feed. */
export interface BingFeed {
  Url: string
  Type: string
  Status: string
  UrlCount: number
  FileSize: number
  Compressed: boolean
  Submitted?: BingWcfDate | null
  LastCrawled?: BingWcfDate | null
}

/**
 * `GetUrlSubmissionQuota` / `GetContentSubmissionQuota`. Both figures are what
 * is LEFT: a site with no submissions on 4 Nov reported `DailyQuota: 100` and
 * `MonthlyQuota: 2700`, i.e. 100 a day for the 27 days remaining in the month.
 */
export interface BingSubmissionQuota {
  DailyQuota: number
  MonthlyQuota: number
}

/** `GetCrawlSettings`. `CrawlRate` is 24 hourly values (Bing's 1 to 10 scale). */
export interface BingCrawlSettings {
  CrawlBoostAvailable: boolean
  CrawlBoostEnabled: boolean
  CrawlRate: number[]
}

/** `GetBlockedUrls` (Bing's `BlockedUrl`). `EntityType` 0 = page, 1 = directory; `RequestType` 0 = cache only, 1 = full removal. */
export interface BingBlockedUrl {
  Url: string
  Date?: BingWcfDate | null
  DaysToExpire?: number
  EntityType?: number
  RequestType?: number
}

/** `GetQueryParameters` (URL normalization parameters). */
export interface BingQueryParameter {
  Parameter: string
  IsEnabled?: boolean
  Date?: BingWcfDate | null
  Source?: string | number
}

/** `GetCountryRegionSettings`. `Type` 0 = page, 1 = directory, 2 = domain, 3 = subdomain. */
export interface BingCountryRegionSettings {
  Url: string
  TwoLetterIsoCountryCode: string
  Type?: number
  Date?: BingWcfDate | null
}

/** `GetFetchedUrls` (Fetch as Bingbot history). */
export interface BingFetchedUrl {
  Url: string
  Date?: BingWcfDate | null
  Expired?: boolean
  Fetched?: boolean
}

/** `GetFetchedUrlDetails`. `Document` and `Headers` are what Bingbot received. */
export interface BingFetchedUrlDetails {
  Url: string
  Date?: BingWcfDate | null
  Status?: string
  Headers?: string
  Document?: string
}

/** `GetSiteRoles`. Needs an owner-level key; a delegated key gets `NotAuthorized`. */
export interface BingSiteRole {
  Site?: string
  Email?: string
  Role?: number
  Date?: BingWcfDate | null
  Expired?: boolean
  DelegatedCode?: string
  DelegatedCodeOwnerEmail?: string
  DelegatorEmail?: string
  VerificationSite?: string
}

/** `GetLinkCounts`: pages on the site with inbound links. 0-indexed `page`. */
export interface BingLinkCounts {
  Links: Array<{ Url: string; Count: number }>
  TotalPages: number
}

/** `GetUrlLinks`: inbound links to one page. `Url` is the EXTERNAL linking page. */
export interface BingLinkDetails {
  Details: Array<{ Url: string; AnchorText?: string }>
  TotalPages: number
}

/** `GetKeyword` / `GetRelatedKeywords`: Bing search volume for a keyword over a date range. */
export interface BingKeyword {
  Query: string
  Impressions: number
  BroadImpressions: number
}

/** `GetKeywordStats`: weekly Bing search volume history for one keyword. */
export interface BingKeywordHistory {
  Query: string
  Date: BingWcfDate
  Impressions: number
  BroadImpressions: number
}

/** `GetChildrenUrlInfo` filter (Bing's `FilterProperties`). 0 everywhere means "any". */
export interface BingUrlFilterProperties {
  CrawlDateFilter: number
  DiscoveredDateFilter: number
  DocFlagsFilters: number
  HttpCodeFilters: number
}

export interface BingSubmitUrlResponse {
  d?: null
}

export interface BingSubmitUrlBatchResponse {
  d?: null
}

/**
 * Bing Webmaster Tools error codes that mean "you are going too fast".
 *
 * Bing does not use HTTP 429 for this. A throttled request comes back as a
 * `400` whose body carries the real condition, e.g.
 * `{"ErrorCode":5,"Message":"ERROR!!! ThrottleHost"}` — 5 is a per-host limit
 * (every project on this instance shares it) and 4 is per-API-key.
 */
export const BING_THROTTLE_ERROR_CODES = new Set([4, 5])

export class BingApiError extends Error {
  public status: number
  /** Bing's own `ErrorCode` from the response body, when it sent one. */
  public bingErrorCode: number | null
  /**
   * True when Bing was throttling. Kept as a field rather than re-derived from
   * the message so `isRetryableHttpError` sees the condition structurally and
   * callers do not have to parse prose.
   */
  public isThrottle: boolean

  constructor(message: string, status: number, bingErrorCode: number | null = null) {
    super(message)
    this.name = 'BingApiError'
    this.status = status
    this.bingErrorCode = bingErrorCode
    // 429 is rate limiting by definition; Bing's own codes cover the 400 form.
    this.isThrottle = status === 429 || (bingErrorCode != null && BING_THROTTLE_ERROR_CODES.has(bingErrorCode))
  }
}
