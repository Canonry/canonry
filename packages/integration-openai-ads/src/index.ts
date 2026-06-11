export {
  getAdAccount,
  listCampaigns,
  listAdGroups,
  listAds,
  getAdAccountInsights,
  getCampaignInsights,
  getAdGroupInsights,
} from './ads-client.js'
export {
  OpenAiAdsApiError,
  parseErrorEnvelope,
} from './types.js'
export type {
  OpenAiAdsAccount,
  OpenAiAdsAd,
  OpenAiAdsAdGroup,
  OpenAiAdsBiddingConfig,
  OpenAiAdsCampaign,
  OpenAiAdsCampaignBudget,
  OpenAiAdsCreative,
  OpenAiAdsInsightRow,
  OpenAiAdsInsightsOptions,
  OpenAiAdsListResponse,
  OpenAiAdsLocationTarget,
  OpenAiAdsReviewState,
  OpenAiAdsTargeting,
} from './types.js'
export { OPENAI_ADS_API_BASE, OPENAI_ADS_MAX_PAGES, OPENAI_ADS_REQUEST_TIMEOUT_MS } from './constants.js'
