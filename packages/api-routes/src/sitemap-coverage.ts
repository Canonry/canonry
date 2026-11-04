import type {
  EngineSitemapDto,
  EngineSitemapsDto,
  SitemapCoverageResponseDto,
  SitemapEngine,
  SitemapMissingDto,
  SitemapSource,
  SitemapState,
} from '@canonry/canonry-contracts'

/**
 * Compare the site's own sitemaps with what each engine lists.
 *
 * No DB, no clock, no I/O, like `gsc-period-comparison.ts`, so every rule here
 * is testable from literals. The route gathers the three lists; this decides
 * what is missing where.
 */

export interface EngineList {
  syncedAt: string
  sitemaps: EngineSitemapDto[]
}

export interface SitemapCoverageInput {
  site: SitemapCoverageResponseDto['site']
  google: EngineList | null
  bing: EngineList | null
  /** Whether an engine can take this sitemap at all (Google: inside the property). Defaults to yes. */
  accepts?: Partial<Record<SitemapEngine, (url: string) => boolean>>
}

/**
 * The comparison key for a sitemap URL. Host case and a default port do not
 * make two sitemaps; the scheme, path and query do (an `http://` sitemap is a
 * different file to an engine than the `https://` one).
 */
export function sitemapKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/** Search Console's verdict as the dashboard has always worded it. */
export function googleSitemapState(row: { isPending: boolean; errors: number | null; warnings: number | null }): { state: SitemapState; statusLabel: string } {
  if (row.isPending) return { state: 'pending', statusLabel: 'Processing' }
  if ((row.errors ?? 0) > 0) return { state: 'errors', statusLabel: 'Errors' }
  if ((row.warnings ?? 0) > 0) return { state: 'warnings', statusLabel: 'Warnings' }
  return { state: 'ok', statusLabel: 'Success' }
}

/** Bing's status word in the shared vocabulary; the word itself stays the label. */
export function bingSitemapState(status: string): SitemapState {
  const word = status.trim().toLowerCase()
  if (word === 'success') return 'ok'
  if (word === 'pending' || word === 'processing') return 'pending'
  if (word.includes('error') || word.includes('fail')) return 'errors'
  if (word.includes('warn')) return 'warnings'
  return 'other'
}

function missingFor(
  list: EngineList,
  other: { name: SitemapEngine; list: EngineList } | null,
  site: string[],
  parents: Map<string, string>,
  accepts: (url: string) => boolean,
): SitemapMissingDto[] {
  const have = new Set(list.sitemaps.map((row) => sitemapKey(row.url)))
  const candidates = new Map<string, { url: string; foundIn: Set<SitemapSource> }>()
  const add = (url: string, source: SitemapSource) => {
    const key = sitemapKey(url)
    if (have.has(key) || !accepts(url)) return
    const entry = candidates.get(key) ?? { url, foundIn: new Set<SitemapSource>() }
    entry.foundIn.add(source)
    candidates.set(key, entry)
  }
  for (const url of site) add(url, 'site')
  // The other engine's own submissions; its index files come with their index.
  for (const row of other?.list.sitemaps ?? []) if (row.parentUrl === null) add(row.url, other!.name)
  return [...candidates.entries()]
    .filter(([key]) => {
      const parent = parents.get(key)
      return parent === undefined || !candidates.has(parent)
    })
    .map(([, entry]) => ({ url: entry.url, foundIn: (['site', 'google', 'bing'] as const).filter((source) => entry.foundIn.has(source)) }))
    .sort((a, b) => a.url.localeCompare(b.url))
}

export function buildSitemapCoverage(input: SitemapCoverageInput): SitemapCoverageResponseDto {
  // Which index each known file sits in, from either engine.
  const parents = new Map<string, string>()
  for (const list of [input.google, input.bing]) {
    for (const row of list?.sitemaps ?? []) if (row.parentUrl !== null) parents.set(sitemapKey(row.url), sitemapKey(row.parentUrl))
  }
  const engine = (name: SitemapEngine, list: EngineList | null, otherName: SitemapEngine, other: EngineList | null): EngineSitemapsDto | null =>
    list === null
      ? null
      : {
          syncedAt: list.syncedAt,
          sitemaps: list.sitemaps,
          missing: missingFor(list, other ? { name: otherName, list: other } : null, input.site.sitemaps, parents, input.accepts?.[name] ?? (() => true)),
        }
  return {
    site: input.site,
    google: engine('google', input.google, 'bing', input.bing),
    bing: engine('bing', input.bing, 'google', input.google),
  }
}
