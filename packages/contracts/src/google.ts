import { z } from 'zod'

export const googleConnectionTypeSchema = z.enum(['gsc', 'ga4'])
export type GoogleConnectionType = z.infer<typeof googleConnectionTypeSchema>

export const googleConnectionDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  connectionType: googleConnectionTypeSchema,
  propertyId: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GoogleConnectionDto = z.infer<typeof googleConnectionDtoSchema>

export const gscSearchDataDtoSchema = z.object({
  date: z.string(),
  query: z.string(),
  page: z.string(),
  country: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})
export type GscSearchDataDto = z.infer<typeof gscSearchDataDtoSchema>

export const gscUrlInspectionDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  indexingState: z.string().nullable().optional(),
  verdict: z.string().nullable().optional(),
  coverageState: z.string().nullable().optional(),
  pageFetchState: z.string().nullable().optional(),
  robotsTxtState: z.string().nullable().optional(),
  crawlTime: z.string().nullable().optional(),
  lastCrawlResult: z.string().nullable().optional(),
  isMobileFriendly: z.boolean().nullable().optional(),
  richResults: z.array(z.string()).default([]),
  inspectedAt: z.string(),
})
export type GscUrlInspectionDto = z.infer<typeof gscUrlInspectionDtoSchema>

export const indexTransitionSchema = z.enum(['stable', 'reindexed', 'deindexed', 'still-missing', 'new'])
export type IndexTransition = z.infer<typeof indexTransitionSchema>

export const gscDeindexedRowSchema = z.object({
  url: z.string(),
  previousState: z.string().nullable(),
  currentState: z.string().nullable(),
  transitionDate: z.string(),
})

export const gscCoverageSummaryDtoSchema = z.object({
  summary: z.object({
    total: z.number(),
    indexed: z.number(),
    notIndexed: z.number(),
    deindexed: z.number(),
    percentage: z.number(),
  }),
  lastInspectedAt: z.string().nullable(),
  indexed: z.array(gscUrlInspectionDtoSchema).default([]),
  notIndexed: z.array(gscUrlInspectionDtoSchema).default([]),
  deindexed: z.array(gscDeindexedRowSchema).default([]),
})
export type GscCoverageSummaryDto = z.infer<typeof gscCoverageSummaryDtoSchema>
