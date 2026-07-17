import type {
  OpenAiAdsCreateAdGroupRequest,
  OpenAiAdsCreateAdRequest,
  OpenAiAdsCreateCampaignRequest,
  OpenAiAdsUpdateAdGroupRequest,
  OpenAiAdsUpdateAdRequest,
  OpenAiAdsUpdateCampaignRequest,
} from './index.js'

type Assert<T extends true> = T
type AssertFalse<T extends false> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? true
    : false
type AcceptsActiveStatus<T> = { name: string; status: 'active' } extends T ? true : false

export type CampaignCreateIsPausedOnly = Assert<Equal<OpenAiAdsCreateCampaignRequest['status'], 'paused'>>
export type AdGroupCreateIsPausedOnly = Assert<Equal<OpenAiAdsCreateAdGroupRequest['status'], 'paused'>>
export type AdCreateIsPausedOnly = Assert<Equal<OpenAiAdsCreateAdRequest['status'], 'paused'>>
export type CampaignUpdateRejectsActive = AssertFalse<AcceptsActiveStatus<OpenAiAdsUpdateCampaignRequest>>
export type AdGroupUpdateRejectsActive = AssertFalse<AcceptsActiveStatus<OpenAiAdsUpdateAdGroupRequest>>
export type AdUpdateRejectsActive = AssertFalse<AcceptsActiveStatus<OpenAiAdsUpdateAdRequest>>
export type CampaignUpdateRejectsNullTargeting = AssertFalse<
  { targeting: null } extends OpenAiAdsUpdateCampaignRequest ? true : false
>
