import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  SeoAdapterOutcomes, SeoCapabilities, SeoMarketRankingSearchStatuses, SeoProviders, SeoTargetKinds,
  compareText, emptySeoResults, normalizeHostname, registrableDomain, seoDeviceSchema, seoRankingSettingsSchema, validationError,
  type SeoAdapter, type SeoAdapterEstimate, type SeoAdapterReceipt, type SeoAdapterRequest, type SeoAdapterResult, type SeoMarketRanking, type SeoTarget,
} from '@canonry/canonry-contracts'
import { cloroFetch, CloroTransportError, REQUEST_DEADLINE_MS, type CloroCredentials } from './client.js'
import { countryOfCriterion, countryOfName } from './countries.js'

/** cloro accepts a Google query of up to 10,000 characters. */
const MAX_SEARCH_TEXT_LENGTH = 10_000
const RESULTS_PER_PAGE = 10

/**
 * Credits for one sync Google search, from cloro's pricing guide (checked 2026-11-18): 3 for the
 * first results page, 2 for each further page, and 2 more because the request is sync. A live
 * 2-page search was charged 7. Location and device do not change the price.
 */
function searchCredits(depth: number): number {
  return 3 + 2 * (depth / RESULTS_PER_PAGE - 1) + 2
}

/**
 * At most one `/v1/monitor/google/goto` call per search, to resolve the target's page address.
 * cloro charges it 0 credits on a paid account; the estimate keeps 1 credit for an unpaid one.
 */
const REDIRECT_CREDITS = 1

/**
 * Where cloro searches from. A Google Ads country criterion (2840 is the United States) is sent
 * as its country. Any other location must carry its Google canonical name as its label
 * ("Dallas,Texas,United States"), because cloro geo-targets by name, not by criterion id. The
 * last part of the name gives the country.
 */
function searchLocation(locationCode: number, label: string): { country: string; location?: string } {
  const country = countryOfCriterion(locationCode)
  if (country) return { country }
  const parts = label.split(',').map(part => part.trim()).filter(Boolean)
  const named = parts.length >= 2 ? countryOfName(parts.at(-1)!) : null
  if (!named) {
    throw validationError('cloro needs a country location code, or a market location whose label is its Google canonical name, such as "Dallas,Texas,United States".')
  }
  return { country: named, location: parts.join(',') }
}

/** The bare hostname a target names. Market rankings take one of the project's own domains or hosts. */
function targetHost(target: SeoTarget | null): string {
  const host = target ? normalizeHostname(target.value) : null
  if (!target || !host || !registrableDomain(host)) throw validationError('SEO requires a bare public domain or hostname.')
  return host
}

function searchPayload(request: SeoAdapterRequest): Record<string, unknown> {
  if (request.capability !== SeoCapabilities['market-rankings']) throw validationError('This SEO connection supports market rankings only.')
  const search = request.search
  const text = request.keywords[0]?.trim() ?? ''
  if (!search || request.keywords.length !== 1 || !text || text.length > MAX_SEARCH_TEXT_LENGTH) {
    throw validationError('Market rankings search one tracked query of up to 10,000 characters at a time.')
  }
  if (!seoRankingSettingsSchema.shape.depth.safeParse(search.depth).success || !seoDeviceSchema.safeParse(search.device).success) {
    throw validationError('Market rankings need a result depth from 10 to 100 in steps of 10 and a device.')
  }
  if (search.markets.length === 0) throw validationError('Market rankings need at least one market for each search.')
  if (!Number.isSafeInteger(request.locationCode) || request.locationCode <= 0 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(request.languageCode)) {
    throw validationError('Check the SEO provider location and language.')
  }
  targetHost(request.target)
  const pages = search.depth / RESULTS_PER_PAGE
  return {
    query: text, ...searchLocation(request.locationCode, search.locationLabel), hl: request.languageCode,
    device: search.device, ...(pages > 1 ? { pages } : {}),
  }
}

// Only the fields the rankings read. Other result blocks (ads, maps, AI Overview) are ignored.
const organicSchema = z.object({
  position: z.number().int().positive(),
  /** The results page the result came from, 1 for the first page. */
  page: z.number().int().positive().nullish(),
  link: z.string().nullish(),
  /** The address Google shows above the title, such as `https://www.example.com`. */
  displayedLink: z.string().nullish(),
  /** Google's redirect for the result, sent beside an empty `link`. */
  redirectLink: z.string().nullish(),
})
const gotoSchema = z.object({ url: z.string() })
const responseSchema = z.object({
  success: z.boolean(),
  result: z.object({ organicResults: z.array(z.unknown()).nullish() }).nullish(),
})

/** A Google redirect such as `https://www.google.com/goto?url=…`, which hides the result's own address. */
function isGoogleRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  return /^google\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host) && (url.pathname === '/goto' || url.pathname === '/url')
}

function parseUrl(value: string | null | undefined): URL | null {
  try {
    return value ? new URL(value.trim()) : null
  } catch {
    return null
  }
}

/**
 * The site and address of one organic result. On mobile, Google serves most links through its
 * own redirect, and cloro then returns an empty `link` with a `redirectLink` beside it. The
 * displayed link still names the site, so the host comes from there, and the redirect is kept so
 * the target's page address can be resolved. A result with neither names no site.
 */
function resultSite(item: z.infer<typeof organicSchema>): { host: string | null; url: string | null; redirect: string | null } {
  const link = parseUrl(item.link)
  if (link && /^https?:$/.test(link.protocol) && !isGoogleRedirect(link)) return { host: normalizeHostname(link.hostname), url: link.href, redirect: null }
  const shown = parseUrl(item.displayedLink?.trim().split(/[\s›]/)[0])
  const redirect = [link, parseUrl(item.redirectLink)].find(candidate => candidate && candidate.protocol === 'https:' && isGoogleRedirect(candidate))
  return { host: shown && /^https?:$/.test(shown.protocol) ? normalizeHostname(shown.hostname) : null, url: null, redirect: redirect?.href ?? null }
}

type OrganicSite = ReturnType<typeof resultSite> & { rank: number; page: number }

/** The organic results of one answer, each with its site. Throws when the answer checked nothing. */
function organicSites(body: unknown): OrganicSite[] {
  const response = responseSchema.parse(body)
  if (!response.success) throw new Error('SEO provider reported an unsuccessful search.')
  const organic = (response.result?.organicResults ?? []).flatMap(item => {
    const parsed = organicSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  if (organic.length === 0) throw new Error('SEO provider returned no organic results.')
  // A result without a page number is placed on the page its position falls on.
  const sites = organic.map(item => ({ rank: item.position, page: item.page ?? Math.ceil(item.position / RESULTS_PER_PAGE), ...resultSite(item) }))
  if (!sites.some(site => site.host)) throw new Error('SEO provider returned no organic result with a known site.')
  return sites
}

/** The target's best result within the depth, or null when the target does not rank. */
function targetResult(sites: OrganicSite[], request: SeoAdapterRequest): OrganicSite | null {
  const depth = request.search!.depth
  return sites.filter(site => site.host && site.rank <= depth && hostBelongsTo(site.host, request.target!))
    .reduce<OrganicSite | null>((best, site) => !best || site.rank < best.rank ? site : best, null)
}

/** Whether a result's host belongs to the target: the exact host, or any subdomain of a whole-domain target. */
function hostBelongsTo(host: string, target: SeoTarget): boolean {
  const value = target.value.toLowerCase()
  return host === value || (target.kind === SeoTargetKinds.domain && target.includeSubdomains && host.endsWith(`.${value}`))
}

/**
 * How deep the results reach. A search that returned results from every requested page checked
 * the requested depth. When the last pages are missing, the search is partial: it checked only
 * as deep as its deepest organic result, so a site that is not in them is not a top-N miss.
 */
function checkedDepth(sites: OrganicSite[], request: SeoAdapterRequest): { depth: number; partial: boolean } {
  const depth = request.search!.depth
  const lastPage = Math.max(...sites.map(site => site.page))
  if (lastPage >= depth / RESULTS_PER_PAGE) return { depth, partial: false }
  return { depth: Math.min(depth, Math.max(...sites.map(site => site.rank))), partial: true }
}

/**
 * One results set into one ranking row per market the search answers. `position` counts organic
 * results across all pages. A set with no organic result, or none that names its site, checked
 * nothing, so it is a failed search and never reads as "not in the top N".
 */
function marketRankings(sites: OrganicSite[], request: SeoAdapterRequest, collectedAt: string, resolvedUrl: string | null): SeoMarketRanking[] {
  const search = request.search!
  const target = request.target!
  const searchText = request.keywords[0]!
  const { depth, partial } = checkedDepth(sites, request)
  const best = targetResult(sites, request)
  const bestUrl = best?.url ?? resolvedUrl
  const competitorRanks = new Map<string, number>()
  const competitors = new Set(search.markets.flatMap(market => market.competitors))
  for (const { rank, host } of sites) {
    if (!host || rank > search.depth || hostBelongsTo(host, target)) continue
    const domain = registrableDomain(host)
    const seen = competitorRanks.get(domain)
    if (domain && competitors.has(domain) && (seen === undefined || rank < seen)) competitorRanks.set(domain, rank)
  }
  const ranked = [...competitorRanks].map(([domain, rankOrganic]) => ({ domain, rankOrganic }))
    .sort((a, b) => a.rankOrganic - b.rankOrganic || compareText(a.domain, b.domain))
  const provenance = {
    provider: SeoProviders.cloro, dataset: 'cloro-serp/google/market-rankings', engine: 'google' as const,
    locationCode: request.locationCode, languageCode: request.languageCode, device: search.device,
    collectedAt, sourceUpdatedAt: null,
  }
  return search.markets.map(market => {
    const tracked = new Set(market.competitors)
    return {
      ...market.context, searchText, locationLabel: search.locationLabel, target,
      searchStatus: partial ? SeoMarketRankingSearchStatuses.partial : SeoMarketRankingSearchStatuses.completed,
      // cloro gives the organic position only, not a position among all the page's results.
      rankOrganic: best?.rank ?? null, rankAbsolute: null, url: bestUrl,
      depth, competitors: ranked.filter(competitor => tracked.has(competitor.domain)), provenance,
    }
  })
}

/**
 * The page address behind a Google redirect, through `/v1/monitor/google/goto`. A failed lookup
 * leaves the address unknown and never fails the search; its receipt still records the charge.
 */
async function resolveRedirect(auth: CloroCredentials, redirect: string, signal?: AbortSignal): Promise<{ url: string | null; task: SeoAdapterReceipt }> {
  try {
    const response = await cloroFetch(auth, 'monitor/google/goto', { url: redirect }, signal)
    const parsed = gotoSchema.safeParse(response.body)
    const url = parsed.success ? parseUrl(parsed.data.url) : null
    const cost = response.creditsCharged === null ? null : response.creditsCharged * auth.creditMicros
    return {
      url: url && /^https?:$/.test(url.protocol) && !isGoogleRedirect(url) ? url.href : null,
      task: { remoteTaskId: response.requestId, statusCode: response.status, costMicros: cost },
    }
  } catch (error) {
    const refused = error instanceof CloroTransportError
    return { url: null, task: { remoteTaskId: null, statusCode: refused ? error.status : null, costMicros: refused ? 0 : null } }
  }
}

/** Construction is local and free. Configuration never probes the account. */
export function createCloroSeoAdapter(credentials: CloroCredentials): SeoAdapter {
  const auth = { apiKey: credentials.apiKey.trim(), creditMicros: credentials.creditMicros }
  // cloro accounts have no login, so the funding identity is a hash of the key: a new key is a new ledger.
  const accountKey = createHash('sha256').update(`cloro:${auth.apiKey}`).digest('hex')
  const micros = (count: number | null) => count === null ? null : count * auth.creditMicros
  return {
    provider: SeoProviders.cloro,
    accountKey,
    capabilities: [SeoCapabilities['market-rankings']],
    requestTimeoutMs: REQUEST_DEADLINE_MS,
    estimate(request): SeoAdapterEstimate {
      searchPayload(request)
      return { maxCostMicros: (searchCredits(request.search!.depth) + REDIRECT_CREDITS) * auth.creditMicros, catalogRevision: 'cloro-google-sync-2026-11-18' }
    },
    async execute(request, options): Promise<SeoAdapterResult> {
      const payload = searchPayload(request)
      const results = emptySeoResults()
      if (options?.signal?.aborted) return { outcome: SeoAdapterOutcomes.failed, tasks: [{ remoteTaskId: null, statusCode: null, costMicros: 0 }], results, fetchedAt: new Date().toISOString(), error: 'SEO request was cancelled before submission.' }
      try {
        const response = await cloroFetch(auth, 'monitor/google', payload, options?.signal)
        const fetchedAt = new Date().toISOString()
        const tasks: SeoAdapterReceipt[] = [{ remoteTaskId: response.requestId, statusCode: response.status, costMicros: micros(response.creditsCharged) }]
        let sites: OrganicSite[]
        try {
          sites = organicSites(response.body)
        } catch {
          // Keep the charge: cloro billed the search even when it found nothing usable.
          return { outcome: SeoAdapterOutcomes.failed, tasks, results, fetchedAt, error: 'Some SEO provider results could not be collected.' }
        }
        const best = targetResult(sites, request)
        const resolved = best && !best.url && best.redirect ? await resolveRedirect(auth, best.redirect, options?.signal) : null
        if (resolved) tasks.push(resolved.task)
        results.marketRankings.push(...marketRankings(sites, request, fetchedAt, resolved?.url ?? null))
        if (checkedDepth(sites, request).partial) {
          return { outcome: SeoAdapterOutcomes.partial, tasks, results, fetchedAt, error: 'Some SEO provider results could not be collected.' }
        }
        return { outcome: SeoAdapterOutcomes.completed, tasks, results, fetchedAt, error: null }
      } catch (error) {
        // A refusal is never charged. A lost or unread response may have been, so it needs reconciliation.
        const refused = error instanceof CloroTransportError
        return {
          outcome: refused ? SeoAdapterOutcomes.failed : SeoAdapterOutcomes.unknown,
          tasks: [{ remoteTaskId: null, statusCode: refused ? error.status : null, costMicros: refused ? 0 : null }],
          results, fetchedAt: new Date().toISOString(),
          error: refused ? 'SEO provider rejected the request.' : 'SEO provider acceptance is unknown; reconciliation is required.',
        }
      }
    },
  }
}
