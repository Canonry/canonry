export {
  createServiceAccountJwt,
  getAccessToken,
  fetchTrafficByLandingPage,
  fetchAggregateSummary,
  fetchWindowSummary,
  fetchDailyTotals,
  fetchAiReferrals,
  fetchSocialReferrals,
  verifyConnection,
  verifyConnectionWithToken,
} from './ga4-client.js'
export type { GA4AggregateSummary, GA4WindowSummary, GA4DailyTotalRow } from './ga4-client.js'
export * from './constants.js'
export * from './types.js'
