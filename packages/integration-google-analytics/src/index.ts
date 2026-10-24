export {
  createServiceAccountJwt,
  getAccessToken,
  fetchTrafficByLandingPage,
  fetchAcquisitionByChannel,
  fetchLeadEvents,
  fetchAggregateSummary,
  fetchWindowSummary,
  fetchWindowMetrics,
  fetchDailyTotals,
  fetchAiReferrals,
  fetchSocialReferrals,
  fetchSearchLandingPages,
  verifyConnection,
  verifyConnectionWithToken,
  listProperties,
} from './ga4-client.js'
export type { GA4AggregateSummary, GA4WindowSummary, GA4WindowMetrics, GA4WindowMetricsPeriod, GA4DailyTotals, GA4DailyTotalRow, GA4PropertySummary } from './ga4-client.js'
export * from './constants.js'
export * from './types.js'
