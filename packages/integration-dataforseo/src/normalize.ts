import { z } from 'zod'
import {
  SeoCapabilities, SeoProviders, SeoTargetKinds, emptySeoResults, registrableDomain, type SeoAdapterRequest, type SeoKeywordMetrics,
  type SeoProvenance, type SeoResults,
} from '@canonry/canonry-contracts'

const count = z.number().int().nonnegative().nullish()
const amount = z.number().nonnegative().nullish()
const keywordInfoSchema = z.object({
  last_updated_time: z.string().nullish(), search_volume: count, cpc: amount,
  competition: z.number().min(0).max(1).nullish(),
  monthly_searches: z.array(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), search_volume: count })).nullish(),
})
const keywordDataSchema = z.object({
  keyword: z.string(), keyword_info: keywordInfoSchema.nullish(),
  keyword_properties: z.object({ keyword_difficulty: z.number().min(0).max(100).nullish(), core_keyword: z.string().nullish() }).nullish(),
  search_intent_info: z.object({ main_intent: z.string().nullish() }).nullish(),
  serp_info: z.object({ serp_item_types: z.array(z.string()).nullish(), last_updated_time: z.string().nullish() }).nullish(),
})
const domainItemSchema = z.object({
  location_code: z.number().int(), language_code: z.string(),
  metrics: z.object({ organic: z.object({
    count, etv: amount, estimated_paid_traffic_cost: amount,
    pos_1: count, pos_2_3: count, pos_4_10: count, pos_11_20: count,
  }).nullish() }),
})
const rankedItemSchema = z.object({
  keyword_data: keywordDataSchema,
  ranked_serp_element: z.object({
    last_updated_time: z.string().nullish(),
    serp_item: z.object({
      type: z.literal('organic'), domain: z.string().nullish(), url: z.string().nullish(),
      rank_group: z.number().int().positive().nullish(),
      rank_absolute: z.number().int().positive().nullish(), etv: amount,
    }),
  }),
})
const resultSchema = z.object({
  location_code: z.number().int(), language_code: z.string(), target: z.string().optional(),
  items: z.array(z.unknown()).nullable(),
})

function provenance(request: SeoAdapterRequest, collectedAt: string, sourceUpdatedAt: string | null): SeoProvenance {
  return {
    provider: SeoProviders.dataforseo, dataset: `dataforseo-labs/google/${request.capability}`,
    engine: 'google', locationCode: request.locationCode, languageCode: request.languageCode,
    device: 'unspecified', collectedAt, sourceUpdatedAt,
  }
}

function keywordMetrics(
  item: z.infer<typeof keywordDataSchema>, request: SeoAdapterRequest, collectedAt: string,
): SeoKeywordMetrics {
  return {
    keyword: item.keyword, searchVolume: item.keyword_info?.search_volume ?? null,
    cpcUsd: item.keyword_info?.cpc ?? null, adCompetition: item.keyword_info?.competition ?? null,
    keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
    searchIntent: item.search_intent_info?.main_intent ?? null,
    coreKeyword: item.keyword_properties?.core_keyword ?? null,
    monthlySearches: (item.keyword_info?.monthly_searches ?? []).map(month => ({
      year: month.year, month: month.month, searchVolume: month.search_volume ?? null,
    })),
    provenance: provenance(request, collectedAt, item.keyword_info?.last_updated_time ?? null),
  }
}

/** Verify returned identity before attaching request provenance to any observation. */
export function normalizeDataForSeoResults(rawResults: unknown[], request: SeoAdapterRequest, collectedAt: string): SeoResults {
  const output = emptySeoResults()
  for (const raw of rawResults) {
    const result = resultSchema.parse(raw)
    if (result.location_code !== request.locationCode || result.language_code !== request.languageCode) {
      throw new Error('SEO provider returned a different market.')
    }
    const providerTarget = request.target?.kind === SeoTargetKinds.host ? registrableDomain(request.target.value) : request.target?.value.toLowerCase()
    if (request.target && result.target?.toLowerCase() !== providerTarget) {
      throw new Error('SEO provider returned a different target.')
    }
    const items = result.items ?? []
    switch (request.capability) {
      case SeoCapabilities['keyword-metrics']: {
        const requested = new Map(request.keywords.map(keyword => [keyword.toLowerCase(), keyword]))
        for (const rawItem of items) {
          const item = keywordDataSchema.parse(rawItem)
          const original = requested.get(item.keyword.toLowerCase())
          if (!original) throw new Error('SEO provider returned an unrequested keyword.')
          output.keywordMetrics.push({ ...keywordMetrics(item, request, collectedAt), keyword: original })
        }
        break
      }
      case SeoCapabilities['domain-intelligence']: {
        if (!request.target) throw new Error('SEO target is required.')
        for (const rawItem of items) {
          const item = domainItemSchema.parse(rawItem)
          if (item.location_code !== request.locationCode || item.language_code !== request.languageCode) {
            throw new Error('SEO provider returned a different market.')
          }
          const organic = item.metrics.organic
          output.domainIntelligence.push({
            target: request.target, organicKeywords: organic?.count ?? null,
            estimatedOrganicTraffic: organic?.etv ?? null,
            estimatedOrganicTrafficValueUsd: organic?.estimated_paid_traffic_cost ?? null,
            top1: organic?.pos_1 ?? null, top2To3: organic?.pos_2_3 ?? null,
            top4To10: organic?.pos_4_10 ?? null, top11To20: organic?.pos_11_20 ?? null,
            // This endpoint has no per-result dataset timestamp. Fetch time is not substituted.
            provenance: provenance(request, collectedAt, null),
          })
        }
        break
      }
      case SeoCapabilities['ranked-keywords']: {
        if (!request.target) throw new Error('SEO target is required.')
        for (const rawItem of items) {
          const item = rankedItemSchema.parse(rawItem)
          const metric = keywordMetrics(item.keyword_data, request, collectedAt)
          const serp = item.ranked_serp_element
          if (request.target.kind === SeoTargetKinds.host && serp.serp_item.domain?.toLowerCase() !== request.target.value.toLowerCase()) {
            throw new Error('SEO provider returned evidence outside the exact host scope.')
          }
          output.rankedKeywords.push({
            target: request.target, keyword: metric.keyword, url: serp.serp_item.url ?? null,
            rankOrganic: serp.serp_item.rank_group ?? null, rankAbsolute: serp.serp_item.rank_absolute ?? null,
            searchVolume: metric.searchVolume, cpcUsd: metric.cpcUsd, keywordDifficulty: metric.keywordDifficulty,
            estimatedTraffic: serp.serp_item.etv ?? null,
            serpFeatures: item.keyword_data.serp_info?.serp_item_types ?? [],
            provenance: provenance(request, collectedAt, serp.last_updated_time ?? null),
          })
        }
        break
      }
    }
  }
  return output
}
