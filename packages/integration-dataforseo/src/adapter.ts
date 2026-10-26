import { createHash } from 'node:crypto'
import {
  SeoAdapterOutcomes, SeoCapabilities, SeoProviders, SeoTargetKinds,
  dollarsToMicros, emptySeoResults, normalizeHostname, registrableDomain, seoDeviceSchema, seoProfileInputSchema, seoRankingSettingsSchema, validationError,
  type SeoAdapter, type SeoAdapterEstimate, type SeoAdapterRequest, type SeoAdapterResult,
  type SeoResults, type SeoTarget,
} from '@canonry/canonry-contracts'
import { dataForSeoFetch, DataForSeoTransportError, type DataForSeoCredentials } from './client.js'
import { normalizeDataForSeoResults } from './normalize.js'

/** API paths under `/v3/`. Labs reads DataForSEO's stored database; SERP collects a live results page. */
const ENDPOINTS = {
  [SeoCapabilities['keyword-metrics']]: 'dataforseo_labs/google/keyword_overview/live',
  [SeoCapabilities['domain-intelligence']]: 'dataforseo_labs/google/domain_rank_overview/live',
  [SeoCapabilities['ranked-keywords']]: 'dataforseo_labs/google/ranked_keywords/live',
  [SeoCapabilities['market-rankings']]: 'serp/google/organic/live/advanced',
} as const

/** DataForSEO accepts a SERP keyword of up to 700 characters, counted after it decodes escapes: the text as searched. */
const MAX_SEARCH_TEXT_LENGTH = 700

/**
 * Google search operators that multiply a SERP task's charge by 5, as the `keyword` field of
 * https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ lists them (checked 2026-10-25).
 */
const SURCHARGED_OPERATORS = [
  'allinanchor:', 'allintext:', 'allintitle:', 'allinurl:', 'cache:', 'define:', 'definition:', 'filetype:',
  'id:', 'inanchor:', 'info:', 'intext:', 'intitle:', 'inurl:', 'link:', 'site:',
] as const
const OPERATOR_SURCHARGE = 5

/**
 * Whether a search may be charged as an operator search. DataForSEO does not publish how it matches
 * operators, so this matches them anywhere, ignoring case, without the help center's `-site:` exemption:
 * a false match only reserves more than the search spends, while a missed one spends past its reservation.
 */
function usesSurchargedOperator(searchText: string): boolean {
  const text = searchText.toLowerCase()
  return SURCHARGED_OPERATORS.some(operator => text.includes(operator))
}

/** DataForSEO decodes `%##` in a SERP keyword and reads `+` as a space, so both are sent escaped, `%` first. */
function serpKeyword(searchText: string): string {
  return searchText.replaceAll('%', '%25').replaceAll('+', '%2B')
}

// https://docs.dataforseo.com/v3/appendix/errors/ documents these request refusals,
// distinct from execution or timeout
// failures. Without task receipts, even these require an explicit zero total cost.
const REQUEST_REFUSALS = new Set([40000, 40006, 40100, 40104, 40200, 40203, 40205, 40206, 40207, 40210, 40501, 40502, 40503, 40506])
/**
 * "Task completed with partial results": a live search that could not retrieve some of its
 * results pages returns the ones it got and charges only for those (same appendix). They are
 * kept; discarding them lost a rank already paid for.
 */
const PARTIAL_RESULTS = 40106
/**
 * "Internal SE server error": the search engine itself answered with an error (same appendix).
 * Nothing was collected, so the search is worth sending once more at the end of the refresh.
 */
const SEARCH_ENGINE_ERROR = 40101

/** The bare hostname a target names, after the shared domain/host scope rules. */
function targetHost(target: SeoTarget | null): string {
  const host = target ? normalizeHostname(target.value) : null
  if (!target || !host || !registrableDomain(host)) {
    throw validationError('SEO requires a bare public domain or hostname.')
  }
  const domain = registrableDomain(host)
  if (target.kind === SeoTargetKinds.domain && (host !== domain || !target.includeSubdomains)) {
    throw validationError('Use the root domain with subdomains included, or choose exact host scope.')
  }
  if (target.kind === SeoTargetKinds.host && target.includeSubdomains) {
    throw validationError('Exact host scope cannot include subdomains.')
  }
  return host
}

function marketRankingPayload(request: SeoAdapterRequest): Record<string, unknown> {
  const search = request.search
  const text = request.keywords[0]?.trim() ?? ''
  if (!search || request.keywords.length !== 1 || !text || text.length > MAX_SEARCH_TEXT_LENGTH) {
    throw validationError('Market rankings search one tracked query of up to 700 characters at a time.')
  }
  if (!seoRankingSettingsSchema.shape.depth.safeParse(search.depth).success || !seoDeviceSchema.safeParse(search.device).success) {
    throw validationError('Market rankings need a result depth from 10 to 100 in steps of 10 and a device.')
  }
  if (search.markets.length === 0) throw validationError('Market rankings need at least one market for each search.')
  if (!Number.isSafeInteger(request.locationCode) || request.locationCode <= 0 || request.languageCode.length < 2 || request.languageCode.length > 10) {
    throw validationError('Check the SEO provider location and language.')
  }
  if (request.tag.length > 255) throw validationError('SEO task identifier is too long.')
  targetHost(request.target)
  return {
    keyword: serpKeyword(text), location_code: request.locationCode, language_code: request.languageCode,
    device: search.device, depth: search.depth, tag: request.tag,
  }
}

function taskPayload(request: SeoAdapterRequest): Record<string, unknown> {
  if (request.capability === SeoCapabilities['market-rankings']) return marketRankingPayload(request)
  const parsed = seoProfileInputSchema.pick({ keywords: true, locationCode: true, languageCode: true, limit: true }).safeParse({
    keywords: request.keywords, locationCode: request.locationCode,
    languageCode: request.languageCode, limit: request.limit,
  })
  if (!parsed.success) throw validationError('Check the SEO keywords, provider location, language, and row limit.')
  if (request.tag.length > 255) throw validationError('SEO task identifier is too long.')
  const common = { location_code: request.locationCode, language_code: request.languageCode, tag: request.tag }
  if (request.capability === SeoCapabilities['keyword-metrics']) {
    if (request.keywords.length === 0 || new Set(request.keywords.map(keyword => keyword.toLowerCase())).size !== request.keywords.length) {
      throw validationError('SEO keyword metrics require distinct keywords, ignoring case.')
    }
    return { ...common, keywords: request.keywords, include_clickstream_data: false, include_serp_info: true }
  }
  const target = request.target!
  const host = targetHost(target)
  const domain = registrableDomain(host)
  switch (request.capability) {
    case SeoCapabilities['domain-intelligence']:
      if (target.kind !== SeoTargetKinds.domain) throw validationError('Domain intelligence requires a whole-domain scope.')
      return { ...common, target: host, limit: 1, ignore_synonyms: false }
    case SeoCapabilities['ranked-keywords']:
      return {
        // Root-domain lookup plus an exact domain filter avoids DataForSEO treating
        // a leading www hostname as a single-page URL.
        ...common, target: target.kind === SeoTargetKinds.host ? domain : host, limit: request.limit, offset: 0, item_types: ['organic'],
        include_clickstream_data: false, ignore_synonyms: false, historical_serp_mode: 'live',
        order_by: ['ranked_serp_element.serp_item.etv,desc'],
        ...(target.kind === SeoTargetKinds.host ? { filters: ['ranked_serp_element.serp_item.domain', '=', host] } : {}),
      }
  }
}

function estimate(request: SeoAdapterRequest): SeoAdapterEstimate {
  taskPayload(request)
  if (request.capability === SeoCapabilities['market-rankings']) {
    // Published live SERP prices checked 2026-10-25: $0.002 for each 10 results requested, five
    // times that for a search using an operator. Location and device do not change the price.
    const surcharge = usesSurchargedOperator(request.keywords[0]!) ? OPERATOR_SURCHARGE : 1
    return { maxCostMicros: 2_000 * (request.search!.depth / 10) * surcharge, catalogRevision: 'dataforseo-google-serp-live-2026-10-25-operators' }
  }
  const rows = request.capability === SeoCapabilities['keyword-metrics']
    ? request.keywords.length
    : request.capability === SeoCapabilities['domain-intelligence'] ? 1 : request.limit
  // Published Google Labs prices checked 2026-10-22; optional clickstream is disabled.
  return { maxCostMicros: 12_000 + 120 * rows, catalogRevision: 'dataforseo-google-labs-2026-10-22' }
}

function appendResults(target: SeoResults, source: SeoResults): void {
  target.keywordMetrics.push(...source.keywordMetrics)
  target.domainIntelligence.push(...source.domainIntelligence)
  target.rankedKeywords.push(...source.rankedKeywords)
  target.marketRankings.push(...source.marketRankings)
}

/** Construction is local and free. Configuration never probes the account. */
export function createDataForSeoAdapter(credentials: DataForSeoCredentials): SeoAdapter {
  const auth = { login: credentials.login.trim(), password: credentials.password }
  const accountKey = createHash('sha256').update(`dataforseo:${credentials.login.trim().toLowerCase()}`).digest('hex')
  return {
    provider: SeoProviders.dataforseo,
    accountKey,
    capabilities: seoProfileInputSchema.shape.capabilities.element.options,
    estimate,
    async execute(request, options): Promise<SeoAdapterResult> {
      const payload = taskPayload(request)
      const results = emptySeoResults()
      if (options?.signal?.aborted) return { outcome: SeoAdapterOutcomes.failed, tasks: [{ remoteTaskId: null, statusCode: null, costMicros: 0 }], results, fetchedAt: new Date().toISOString(), error: 'SEO request was cancelled before submission.' }
      try {
        const envelope = await dataForSeoFetch(auth, ENDPOINTS[request.capability], payload, options?.signal)
        const fetchedAt = new Date().toISOString()
        const tasks = envelope.tasks ?? []
        if (tasks.length === 0) {
          const refused = envelope.cost === 0 && REQUEST_REFUSALS.has(envelope.status_code)
          return {
            outcome: refused ? SeoAdapterOutcomes.failed : SeoAdapterOutcomes.unknown, results, fetchedAt,
            tasks: [{ remoteTaskId: null, statusCode: envelope.status_code, costMicros: refused ? 0 : null }],
            error: refused ? 'SEO provider rejected the request.' : 'SEO provider returned no task receipt; reconciliation is required.',
          }
        }
        const receipts = tasks.map(task => ({
          remoteTaskId: task.id ?? null, statusCode: task.status_code,
          costMicros: task.cost == null ? null : dollarsToMicros(task.cost),
        }))
        let complete = 0
        let partial = 0
        for (const task of tasks) {
          // Only a results page can arrive partly collected; Labs reads are kept only when complete.
          const partly = task.status_code === PARTIAL_RESULTS && request.capability === SeoCapabilities['market-rankings']
          if (task.status_code !== 20000 && !partly) continue
          try {
            appendResults(results, normalizeDataForSeoResults(task.result ?? [], request, fetchedAt, { partial: partly }))
            if (partly) partial++
            else complete++
          } catch {
            // Preserve the financial receipt even when a changed payload cannot be decoded.
          }
        }
        const outcome = complete === tasks.length ? SeoAdapterOutcomes.completed
          : complete + partial > 0 ? SeoAdapterOutcomes.partial : SeoAdapterOutcomes.failed
        // Only a definite search-engine error with a known charge may be sent again; anything uncertain may already be paid for.
        const retryable = request.capability === SeoCapabilities['market-rankings'] && outcome === SeoAdapterOutcomes.failed
          && receipts.every(receipt => receipt.statusCode === SEARCH_ENGINE_ERROR && receipt.costMicros !== null)
        return {
          outcome, tasks: receipts, results, fetchedAt,
          error: outcome === SeoAdapterOutcomes.completed ? null : 'Some SEO provider results could not be collected.',
          ...(retryable ? { retryable: true } : {}),
        }
      } catch (error) {
        const unaccepted = error instanceof DataForSeoTransportError && error.unaccepted
        return {
          outcome: unaccepted ? SeoAdapterOutcomes.failed : SeoAdapterOutcomes.unknown,
          tasks: [{ remoteTaskId: null, statusCode: error instanceof DataForSeoTransportError ? error.status : null, costMicros: unaccepted ? 0 : null }],
          results, fetchedAt: new Date().toISOString(),
          error: unaccepted ? 'SEO provider rejected the request.' : 'SEO provider acceptance is unknown; reconciliation is required.',
        }
      }
    },
  }
}
