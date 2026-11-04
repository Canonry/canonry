import { z } from 'zod'

/**
 * Sitemaps across the site and both search engines, from stored data only
 * (`GET /projects/:name/sitemaps`, `canonry sitemaps`). Canonry compares three
 * lists: the sitemap files the latest Site Health scan read pages from, what
 * Search Console lists, and what Bing lists. A sitemap one source has and an
 * engine lacks is `missing` for that engine.
 */

export const sitemapEngineSchema = z.enum(['google', 'bing'])
export type SitemapEngine = z.infer<typeof sitemapEngineSchema>
export const SitemapEngines = sitemapEngineSchema.enum

export const sitemapSourceSchema = z.enum(['site', 'google', 'bing'])
export type SitemapSource = z.infer<typeof sitemapSourceSchema>

/** The engine's verdict, in one vocabulary for both: `ok`, still `pending`, `warnings`, `errors`, or a word Canonry does not know (`other`). */
export const sitemapStateSchema = z.enum(['ok', 'pending', 'warnings', 'errors', 'other'])
export type SitemapState = z.infer<typeof sitemapStateSchema>
export const SitemapStates = sitemapStateSchema.enum

export const engineSitemapDtoSchema = z.object({
  url: z.string(),
  /** The index this file was read from; null for a sitemap listed on its own. */
  parentUrl: z.string().nullable(),
  isIndex: z.boolean(),
  /** The engine's own type word (Bing: `Sitemap`, `Sitemap Index`, `RSS`; Google: `sitemap`, `rssFeed`). */
  type: z.string().nullable(),
  state: sitemapStateSchema,
  /** The engine's status as it reads in its own console (Google: Success, Processing, Warnings, Errors; Bing's word as sent). */
  statusLabel: z.string(),
  warnings: z.number().int().nonnegative().nullable(),
  errors: z.number().int().nonnegative().nullable(),
  /** URLs the engine counted in the sitemap; null when it reported none. */
  urlCount: z.number().int().nonnegative().nullable(),
  /** Null when nobody submitted it: the engine found it itself. */
  submittedAt: z.string().nullable(),
  /** When the engine last read the file (Google: downloaded; Bing: crawled). */
  lastReadAt: z.string().nullable(),
})
export type EngineSitemapDto = z.infer<typeof engineSitemapDtoSchema>

export const sitemapMissingDtoSchema = z.object({
  url: z.string(),
  /** Where Canonry saw it: the site's own sitemaps, or the other engine's list. */
  foundIn: z.array(sitemapSourceSchema),
})
export type SitemapMissingDto = z.infer<typeof sitemapMissingDtoSchema>

export const engineSitemapsDtoSchema = z.object({
  /** When this engine's list was last read in full. */
  syncedAt: z.string(),
  /** Every sitemap the engine lists, files inside an index included (`parentUrl`). */
  sitemaps: z.array(engineSitemapDtoSchema),
  /**
   * Sitemaps the site declares or the other engine lists that this engine does
   * not have, by URL. A file inside an index that is itself missing is left
   * out: adding the index covers it. Google lists only sitemaps inside the
   * connected property.
   */
  missing: z.array(sitemapMissingDtoSchema),
})
export type EngineSitemapsDto = z.infer<typeof engineSitemapsDtoSchema>

export const sitemapCoverageResponseDtoSchema = z.object({
  site: z.object({
    /** When the scan behind `sitemaps` ran; null before the first Site Health scan. */
    scannedAt: z.string().nullable(),
    runId: z.string().nullable(),
    /** Sitemap files the scan read pages from. An index appears through its files. */
    sitemaps: z.array(z.string()),
  }),
  /** Null when the engine is not connected or its list was never read. */
  google: engineSitemapsDtoSchema.nullable(),
  bing: engineSitemapsDtoSchema.nullable(),
})
export type SitemapCoverageResponseDto = z.infer<typeof sitemapCoverageResponseDtoSchema>

/** `POST /projects/:name/bing/sitemaps`: ask Bing to read a sitemap (add it, or read a listed one again). */
export const bingSubmitSitemapRequestSchema = z.object({
  sitemapUrl: z.string().url(),
})
export type BingSubmitSitemapRequest = z.infer<typeof bingSubmitSitemapRequestSchema>

export const bingSubmitSitemapResponseDtoSchema = z.object({
  sitemapUrl: z.string(),
  /** Bing accepted the request. It lists a new sitemap after it reads it, so it shows from the next sync. */
  accepted: z.literal(true),
})
export type BingSubmitSitemapResponseDto = z.infer<typeof bingSubmitSitemapResponseDtoSchema>
