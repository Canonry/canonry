import { z } from 'zod'

// ── Indexing sweep contracts ───────────────────────────────────────────────

export const topPageSchema = z.object({
  url: z.string(),
  title: z.string(),
})

export const sweepResultSchema = z.object({
  id: z.string(),
  sweepId: z.string(),
  keywordId: z.string(),
  keyword: z.string().optional(),
  domain: z.string(),
  domainRole: z.enum(['client', 'competitor']),
  indexedPageCount: z.number().int().nonnegative(),
  topPages: z.array(topPageSchema),
  createdAt: z.string(),
})

export const indexingSweepSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  trigger: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
})

export const indexingSweepWithResultsSchema = indexingSweepSchema.extend({
  results: z.array(sweepResultSchema),
})

export type TopPage = z.infer<typeof topPageSchema>
export type SweepResult = z.infer<typeof sweepResultSchema>
export type IndexingSweep = z.infer<typeof indexingSweepSchema>
export type IndexingSweepWithResults = z.infer<typeof indexingSweepWithResultsSchema>

// ── Web search provider config ─────────────────────────────────────────────

export const webSearchBackendSchema = z.enum(['serper', 'google-cse'])
export type WebSearchBackend = z.infer<typeof webSearchBackendSchema>

export const webSearchProviderConfigSchema = z.object({
  apiKey: z.string().min(1),
  backend: webSearchBackendSchema.default('serper'),
  /** For Google CSE — the search engine ID (cx parameter) */
  cx: z.string().optional(),
})
export type WebSearchProviderConfig = z.infer<typeof webSearchProviderConfigSchema>
