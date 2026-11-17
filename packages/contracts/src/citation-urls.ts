import { z } from 'zod'
import { metricsWindowSchema } from './analytics.js'
import { queryClassFilterSchema } from './query-class.js'
import { sourceCategorySchema, type SourceCategory } from './source-categories.js'

/**
 * One cited page, as the cited-URL read groups it. Two links to the same page
 * written differently count as one URL:
 * - the scheme becomes https, the host is lowercased and loses `www.`, `m.`
 *   and `old.` (so old.reddit.com and www.reddit.com are one site);
 * - the fragment, a trailing slash and `utm_*` tracking parameters are
 *   dropped, while every other parameter is kept, because some pages are
 *   named by one (YouTube's `?v=`);
 * - a Reddit thread keeps only `/r/<sub>/comments/<id>`, because engines cite
 *   the same thread with and without its title slug.
 * Returns null for a value that is not an http(s) URL.
 */
export function canonicalCitedUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|old)\./, '')
  let path = url.pathname.replace(/\/+$/, '')
  const reddit = /^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i.exec(path)
  if ((host === 'reddit.com' || host.endsWith('.reddit.com')) && reddit) {
    path = `/r/${reddit[1]}/comments/${reddit[2]!.toLowerCase()}`
  }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !/^utm_/i.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
  return `https://${host}${path}${query}`
}

/** What the read's `category` accepts: one source category or a comma-separated list. */
export const CITATION_URL_CATEGORY_HINT = `one or more (comma-separated) of: ${sourceCategorySchema.options.join(', ')}`

/** Parses `category`: each category once, in the order given, or null when empty or unknown. */
export function parseCitationUrlCategories(value: string): SourceCategory[] | null {
  const categories: SourceCategory[] = []
  for (const member of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const parsed = sourceCategorySchema.safeParse(member)
    if (!parsed.success) return null
    if (!categories.includes(parsed.data)) categories.push(parsed.data)
  }
  return categories.length > 0 ? categories : null
}

export const citationUrlSortSchema = z.enum(['answers', 'newest'])
export type CitationUrlSort = z.infer<typeof citationUrlSortSchema>

export const CITATION_URLS_DEFAULT_LIMIT = 100
export const CITATION_URLS_MAX_LIMIT = 1000

export const citationUrlEntrySchema = z.object({
  /** The page, written one way (see `canonicalCitedUrl`). */
  url: z.string(),
  /** Host without `www.`. */
  domain: z.string(),
  category: sourceCategorySchema,
  label: z.string(),
  /** Answers in scope that cite this page; one credit per answer however often it links it. */
  answers: z.number().int().nonnegative(),
  /** Of those answers, how many name the brand in their text. */
  answersNamingBrand: z.number().int().nonnegative(),
  /** Of those answers, how many were never checked for the brand (no stored text). Never read these as "not named". */
  answersBrandUnchecked: z.number().int().nonnegative(),
  /** Answers citing the page, per engine. */
  providers: z.record(z.string(), z.number().int().nonnegative()),
  /** Every tracked question whose answers cite the page, most answers first. */
  queries: z.array(z.object({
    query: z.string(),
    answers: z.number().int().nonnegative(),
  })),
  /** Sweeps in scope that cite the page. */
  runs: z.number().int().nonnegative(),
  /** First sweep in scope that cited the page. "First" means within the window: read window=all for all history. */
  firstSeenAt: z.string(),
  firstRunId: z.string(),
  lastSeenAt: z.string(),
  lastRunId: z.string(),
  /** True when the latest sweep in scope cites the page and no earlier sweep in scope did. */
  newInLatest: z.boolean(),
  /** True when the latest sweep in scope cites the page. */
  citedInLatest: z.boolean(),
})
export type CitationUrlEntry = z.infer<typeof citationUrlEntrySchema>

export const citationUrlsResponseSchema = z.object({
  filters: z.object({
    window: metricsWindowSchema,
    /** Host filter: the host or any subdomain of it. */
    domain: z.string().nullable(),
    categories: z.array(sourceCategorySchema),
    provider: z.string().nullable(),
    queryClass: queryClassFilterSchema,
    newInLatest: z.boolean(),
    sort: citationUrlSortSchema,
  }),
  /** The latest sweep in scope, or null when no sweep is. A multi-location sweep is one sweep. */
  latestRun: z.object({ id: z.string(), createdAt: z.string() }).nullable(),
  /** Sweeps in scope: completed or partial, never probes, inside the window. */
  runCount: z.number().int().nonnegative(),
  /** Answers in scope whose engine returns sources. An engine that returns none is left out, as in the sources read. */
  answerTotal: z.number().int().nonnegative(),
  /** Answers left out because their question has no class for `queryClass`. */
  unclassifiedAnswers: z.number().int().nonnegative(),
  /** Pages that match, before `limit`. */
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** Pass as `cursor`, with the same filters, for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  urls: z.array(citationUrlEntrySchema),
})
export type CitationUrlsResponse = z.infer<typeof citationUrlsResponseSchema>
