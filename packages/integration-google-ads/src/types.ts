import type { RetryOptions } from '@ainyc/canonry-contracts'

export interface GoogleAdsCredentials {
  accessToken: string
  developerToken: string
  loginCustomerId?: string
}

export type GoogleAdsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface GoogleAdsRetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: boolean
  sleep?: RetryOptions['sleep']
}

export interface GoogleAdsClientOptions {
  fetch?: GoogleAdsFetch
  requestTimeoutMs?: number
  retry?: GoogleAdsRetryOptions
}

export type GoogleAdsReadOperation =
  | 'list-accessible-customers'
  | 'customer-details'
  | 'customer-clients'
  | 'campaigns'
  | 'conversion-actions'
  | 'customer-conversion-goals'
  | 'campaign-conversion-goals'
  | 'custom-conversion-goals'
  | 'conversion-goal-campaign-configs'
  | 'campaign-spend-ranking'
  | 'daily-campaign-metrics'
  | 'daily-conversion-metrics'

export interface GoogleAdsRequestMetadata {
  apiVersion: string
  operation: GoogleAdsReadOperation
  requestId?: string
}

export interface GoogleAdsCompositeMetadata {
  apiVersion: string
  requests: GoogleAdsRequestMetadata[]
}

export interface GoogleAdsResult<T> {
  data: T
  metadata: GoogleAdsRequestMetadata
}

export interface GoogleAdsCompositeResult<T> {
  data: T
  metadata: GoogleAdsCompositeMetadata
}

export class GoogleAdsApiError extends Error {
  override readonly name = 'GoogleAdsApiError'

  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerStatus?: string,
    public readonly requestId?: string,
    public readonly retryAfter?: string,
  ) {
    super(message)
  }
}

export interface GoogleAdsAccessibleCustomers {
  resourceNames: string[]
}

export interface GoogleAdsConversionTrackingSetting {
  conversionTrackingId?: string
  conversionTrackingStatus?: string
  crossAccountConversionTrackingId?: string
  googleAdsConversionCustomer?: string
}

export interface GoogleAdsCustomer {
  resourceName: string
  id: string
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  manager?: boolean
  testAccount?: boolean
  status?: string
  autoTaggingEnabled?: boolean
  conversionTrackingSetting?: GoogleAdsConversionTrackingSetting
}

export interface GoogleAdsCustomerRow {
  customer: GoogleAdsCustomer
}

export interface GoogleAdsAccessibleCustomerDetailsOptions {
  maxCustomers?: number
}

export interface GoogleAdsCustomerDetailFailure {
  resourceName: string
  customerId?: string
  status?: number
  providerStatus?: string
  requestId?: string
  message: string
}

export interface GoogleAdsAccessibleCustomerDetailsData {
  customers: GoogleAdsCustomer[]
  failures: GoogleAdsCustomerDetailFailure[]
  totalAccessible: number
  attempted: number
  returned: number
  truncated: boolean
  omitted: number
}

export interface GoogleAdsCustomerClient {
  resourceName: string
  clientCustomer: string
  id: string
  descriptiveName?: string
  currencyCode?: string
  timeZone?: string
  manager?: boolean
  testAccount?: boolean
  hidden?: boolean
  status?: string
  level?: string
}

export interface GoogleAdsCustomerClientRow {
  customerClient: GoogleAdsCustomerClient
}

export interface GoogleAdsCustomerClientsOptions {
  maxDepth?: number
  maxCustomers?: number
}

export interface GoogleAdsCustomerClientsData {
  customerClients: GoogleAdsCustomerClient[]
  maxDepth: number
  returned: number
  truncated: boolean
}

export interface GoogleAdsMaximizeConversions {
  targetCpaMicros?: string
}

export interface GoogleAdsMaximizeConversionValue {
  targetRoas?: number
}

export interface GoogleAdsTargetCpa {
  targetCpaMicros?: string
  cpcBidCeilingMicros?: string
  cpcBidFloorMicros?: string
}

export interface GoogleAdsTargetRoas {
  targetRoas?: number
  cpcBidCeilingMicros?: string
  cpcBidFloorMicros?: string
}

export interface GoogleAdsTargetImpressionShare {
  cpcBidCeilingMicros?: string
  location?: string
  locationFractionMicros?: string
}

export interface GoogleAdsTargetSpend {
  cpcBidCeilingMicros?: string
  targetSpendMicros?: string
}

export interface GoogleAdsCampaign {
  resourceName: string
  id: string
  name: string
  status: string
  primaryStatus?: string
  servingStatus?: string
  advertisingChannelType?: string
  advertisingChannelSubType?: string
  campaignBudget?: string
  biddingStrategy?: string
  biddingStrategyType?: string
  maximizeConversions?: GoogleAdsMaximizeConversions
  maximizeConversionValue?: GoogleAdsMaximizeConversionValue
  targetCpa?: GoogleAdsTargetCpa
  targetRoas?: GoogleAdsTargetRoas
  targetImpressionShare?: GoogleAdsTargetImpressionShare
  targetSpend?: GoogleAdsTargetSpend
}

export interface GoogleAdsCampaignBudget {
  resourceName: string
  id?: string
  name?: string
  amountMicros?: string
  totalAmountMicros?: string
  status?: string
  explicitlyShared?: boolean
}

export interface GoogleAdsBiddingStrategy {
  resourceName: string
  id?: string
  name?: string
  status?: string
  type?: string
  maximizeConversions?: GoogleAdsMaximizeConversions
  maximizeConversionValue?: GoogleAdsMaximizeConversionValue
  targetCpa?: GoogleAdsTargetCpa
  targetRoas?: GoogleAdsTargetRoas
}

export interface GoogleAdsCampaignRow {
  campaign: GoogleAdsCampaign
  campaignBudget?: GoogleAdsCampaignBudget
  biddingStrategy?: GoogleAdsBiddingStrategy
}

export interface GoogleAdsConversionValueSettings {
  alwaysUseDefaultValue?: boolean
  defaultCurrencyCode?: string
  defaultValue?: number
}

export interface GoogleAdsAttributionModelSettings {
  attributionModel?: string
}

export interface GoogleAdsAnalytics4Settings {
  eventName?: string
  propertyId?: string
  propertyName?: string
}

export interface GoogleAdsTagSnippet {
  type?: string
  pageFormat?: string
  globalSiteTag?: string
  eventSnippet?: string
}

export interface GoogleAdsConversionAction {
  resourceName: string
  id: string
  name: string
  status: string
  type: string
  category: string
  origin: string
  ownerCustomer?: string
  primaryForGoal?: boolean
  includeInConversionsMetric?: boolean
  countingType?: string
  clickThroughLookbackWindowDays?: string
  viewThroughLookbackWindowDays?: string
  attributionModelSettings?: GoogleAdsAttributionModelSettings
  valueSettings?: GoogleAdsConversionValueSettings
  googleAnalytics4Settings?: GoogleAdsAnalytics4Settings
  tagSnippets?: GoogleAdsTagSnippet[]
}

export interface GoogleAdsConversionActionRow {
  conversionAction: GoogleAdsConversionAction
}

export interface GoogleAdsCustomerConversionGoal {
  resourceName: string
  category: string
  origin: string
  biddable?: boolean
}

export interface GoogleAdsCustomerConversionGoalRow {
  customerConversionGoal: GoogleAdsCustomerConversionGoal
}

export interface GoogleAdsCampaignConversionGoal {
  resourceName: string
  campaign: string
  category: string
  origin: string
  biddable?: boolean
}

export interface GoogleAdsCampaignConversionGoalRow {
  campaignConversionGoal: GoogleAdsCampaignConversionGoal
  campaign: GoogleAdsCampaign
}

export interface GoogleAdsCustomConversionGoal {
  resourceName: string
  id: string
  name: string
  status: string
  conversionActions?: string[]
}

export interface GoogleAdsCustomConversionGoalRow {
  customConversionGoal: GoogleAdsCustomConversionGoal
}

export type GoogleAdsGoalConfigLevel = 'CUSTOMER' | 'CAMPAIGN' | 'UNKNOWN' | 'UNSPECIFIED'

export interface GoogleAdsConversionGoalCampaignConfig {
  resourceName: string
  campaign: string
  customConversionGoal?: string
  goalConfigLevel: GoogleAdsGoalConfigLevel
}

export interface GoogleAdsConversionGoalCampaignConfigRow {
  conversionGoalCampaignConfig: GoogleAdsConversionGoalCampaignConfig
  campaign: GoogleAdsCampaign
}

export interface GoogleAdsConversionGoalData {
  conversionActions: GoogleAdsConversionActionRow[]
  customerGoals: GoogleAdsCustomerConversionGoalRow[]
  campaignGoals: GoogleAdsCampaignConversionGoalRow[]
  /** False when the bounded campaign-goal query reached its row cap. */
  campaignGoalsComplete: boolean
  customGoals: GoogleAdsCustomConversionGoalRow[]
  campaignConfigs: GoogleAdsConversionGoalCampaignConfigRow[]
}

export interface GoogleAdsSegments {
  date: string
  conversionAction?: string
  conversionActionName?: string
  conversionActionCategory?: string
}

export interface GoogleAdsCampaignMetrics {
  impressions?: string
  clicks?: string
  costMicros?: string
  averageCpc?: string
  ctr?: number
  conversions?: number
  conversionsValue?: number
  allConversions?: number
  allConversionsValue?: number
  searchImpressionShare?: number
}

export interface GoogleAdsDailyCampaignMetricsRow {
  segments: GoogleAdsSegments
  campaign: GoogleAdsCampaign
  metrics: GoogleAdsCampaignMetrics
}

export interface GoogleAdsDailyConversionMetricsRow {
  segments: GoogleAdsSegments
  campaign: GoogleAdsCampaign
  metrics: Pick<
    GoogleAdsCampaignMetrics,
    'conversions' | 'conversionsValue' | 'allConversions' | 'allConversionsValue'
  >
}

export interface GoogleAdsListOptions {
  includeRemoved?: boolean
  limit?: number
}

export interface GoogleAdsDailyMetricsOptions {
  startDate: string
  endDate: string
  campaignIds?: string[]
  limit?: number
}
