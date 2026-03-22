import { z } from 'zod'

export const bingConnectionDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  siteUrl: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type BingConnectionDto = z.infer<typeof bingConnectionDtoSchema>

export const bingUrlInspectionDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  httpCode: z.number().nullable().optional(),
  inIndex: z.boolean().nullable().optional(),
  lastCrawledDate: z.string().nullable().optional(),
  inIndexDate: z.string().nullable().optional(),
  inspectedAt: z.string(),
  // Fields derived from GetUrlInfo response (more reliable than InIndex)
  documentSize: z.number().nullable().optional(),
  anchorCount: z.number().nullable().optional(),
  discoveryDate: z.string().nullable().optional(),
})
export type BingUrlInspectionDto = z.infer<typeof bingUrlInspectionDtoSchema>

export const bingCoverageSummaryDtoSchema = z.object({
  summary: z.object({
    total: z.number(),
    indexed: z.number(),
    notIndexed: z.number(),
    unknown: z.number().optional(),
    percentage: z.number(),
  }),
  lastInspectedAt: z.string().nullable(),
  indexed: z.array(bingUrlInspectionDtoSchema).default([]),
  notIndexed: z.array(bingUrlInspectionDtoSchema).default([]),
  unknown: z.array(bingUrlInspectionDtoSchema).default([]).optional(),
})
export type BingCoverageSummaryDto = z.infer<typeof bingCoverageSummaryDtoSchema>

export const bingKeywordStatsDtoSchema = z.object({
  query: z.string(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),
  averagePosition: z.number(),
})
export type BingKeywordStatsDto = z.infer<typeof bingKeywordStatsDtoSchema>

export const bingSubmitResultDtoSchema = z.object({
  url: z.string(),
  status: z.enum(['success', 'error']),
  submittedAt: z.string(),
  error: z.string().optional(),
})
export type BingSubmitResultDto = z.infer<typeof bingSubmitResultDtoSchema>
