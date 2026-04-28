import { z } from 'zod'
import { citationStateSchema } from './run.js'
import type { LatestProjectRunDto } from './run.js'
import type { ProjectDto } from './project.js'
import type { HealthSnapshotDto, InsightDto } from './intelligence.js'

// One-call summary for "how is project X doing?". The shape stays stable so
// agents can build prompts on it without falling back to four list endpoints.
export interface ProjectOverviewKeywordCountsDto {
  totalKeywords: number
  citedKeywords: number
  notCitedKeywords: number
  citedRate: number
}

export interface ProjectOverviewProviderEntryDto {
  provider: string
  citedRate: number
  cited: number
  total: number
}

// `since` is the createdAt of the run before `latestRun`, so callers can render
// "2 of 8 keywords transitioned since the previous sweep" without a second
// fetch. Null when no prior run exists.
export interface ProjectOverviewTransitionsDto {
  since: string | null
  gained: number
  lost: number
  emerging: number
}

export interface ProjectOverviewDto {
  project: ProjectDto
  latestRun: LatestProjectRunDto
  health: HealthSnapshotDto | null
  topInsights: InsightDto[]
  keywordCounts: ProjectOverviewKeywordCountsDto
  providers: ProjectOverviewProviderEntryDto[]
  transitions: ProjectOverviewTransitionsDto
}

export const searchHitKindSchema = z.enum(['snapshot', 'insight'])
export type SearchHitKind = z.infer<typeof searchHitKindSchema>

export const projectSearchSnapshotHitSchema = z.object({
  kind: z.literal('snapshot'),
  id: z.string(),
  runId: z.string(),
  keyword: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  citationState: citationStateSchema,
  matchedField: z.enum(['answerText', 'citedDomains', 'searchQueries', 'keyword']),
  snippet: z.string(),
  createdAt: z.string(),
})

export type ProjectSearchSnapshotHitDto = z.infer<typeof projectSearchSnapshotHitSchema>

export const projectSearchInsightHitSchema = z.object({
  kind: z.literal('insight'),
  id: z.string(),
  runId: z.string().nullable(),
  type: z.enum(['regression', 'gain', 'opportunity']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  keyword: z.string(),
  provider: z.string(),
  matchedField: z.enum(['title', 'keyword', 'recommendation', 'cause']),
  snippet: z.string(),
  dismissed: z.boolean(),
  createdAt: z.string(),
})

export type ProjectSearchInsightHitDto = z.infer<typeof projectSearchInsightHitSchema>

export const projectSearchHitSchema = z.discriminatedUnion('kind', [
  projectSearchSnapshotHitSchema,
  projectSearchInsightHitSchema,
])

export type ProjectSearchHitDto = z.infer<typeof projectSearchHitSchema>

export const projectSearchResponseSchema = z.object({
  query: z.string(),
  totalHits: z.number().int().nonnegative(),
  truncated: z.boolean(),
  hits: z.array(projectSearchHitSchema),
})

export type ProjectSearchResponseDto = z.infer<typeof projectSearchResponseSchema>
