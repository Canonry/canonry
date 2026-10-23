import { createHash } from 'node:crypto'
import {
  SeoAdapterOutcomes, SeoCapabilities, SeoProviders, SeoTargetKinds,
  dollarsToMicros, emptySeoResults, normalizeHostname, registrableDomain, seoProfileInputSchema,
  type SeoAdapter, type SeoAdapterEstimate, type SeoAdapterRequest, type SeoAdapterResult,
  type SeoResults,
} from '@canonry/canonry-contracts'
import { dataForSeoFetch, DataForSeoTransportError, type DataForSeoCredentials } from './client.js'
import { normalizeDataForSeoResults } from './normalize.js'

const ENDPOINTS = {
  [SeoCapabilities['keyword-metrics']]: 'keyword_overview',
  [SeoCapabilities['domain-intelligence']]: 'domain_rank_overview',
  [SeoCapabilities['ranked-keywords']]: 'ranked_keywords',
} as const

function taskPayload(request: SeoAdapterRequest): Record<string, unknown> {
  seoProfileInputSchema.pick({ keywords: true, locationCode: true, languageCode: true, limit: true }).parse({
    keywords: request.keywords, locationCode: request.locationCode,
    languageCode: request.languageCode, limit: request.limit,
  })
  if (request.tag.length > 255) throw new Error('SEO task identifier is too long.')
  const common = { location_code: request.locationCode, language_code: request.languageCode, tag: request.tag }
  if (request.capability === SeoCapabilities['keyword-metrics']) {
    if (request.keywords.length === 0 || new Set(request.keywords.map(keyword => keyword.toLowerCase())).size !== request.keywords.length) {
      throw new Error('SEO keyword metrics require distinct keywords.')
    }
    return { ...common, keywords: request.keywords, include_clickstream_data: false, include_serp_info: true }
  }
  const target = request.target
  const host = target ? normalizeHostname(target.value) : null
  if (!target || !host || !registrableDomain(host)) {
    throw new Error('SEO requires a bare public domain or hostname.')
  }
  const domain = registrableDomain(host)
  if (target.kind === SeoTargetKinds.domain && (host !== domain || !target.includeSubdomains)) {
    throw new Error('A domain scope must include its subdomains; exact host scope is separate.')
  }
  if (target.kind === SeoTargetKinds.host && target.includeSubdomains) {
    throw new Error('Subdomain-tree scope is not supported by this SEO adapter.')
  }
  switch (request.capability) {
    case SeoCapabilities['domain-intelligence']:
      if (target.kind !== SeoTargetKinds.domain) throw new Error('Domain intelligence requires a whole-domain scope.')
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
      try {
        const envelope = await dataForSeoFetch(auth, ENDPOINTS[request.capability], payload, options?.signal)
        const fetchedAt = new Date().toISOString()
        const tasks = envelope.tasks ?? []
        if (tasks.length === 0) {
          return {
            outcome: SeoAdapterOutcomes.unknown, results, fetchedAt,
            tasks: [{ remoteTaskId: null, statusCode: envelope.status_code, costMicros: null }],
            error: 'SEO provider returned no task receipt; reconciliation is required.',
          }
        }
        const receipts = tasks.map(task => ({
          remoteTaskId: task.id ?? null, statusCode: task.status_code,
          costMicros: task.cost == null ? null : dollarsToMicros(task.cost),
        }))
        let successes = 0
        for (const task of tasks) {
          if (task.status_code !== 20000) continue
          try {
            appendResults(results, normalizeDataForSeoResults(task.result ?? [], request, fetchedAt))
            successes++
          } catch {
            // Preserve the financial receipt even when a changed payload cannot be decoded.
          }
        }
        const outcome = successes === tasks.length ? SeoAdapterOutcomes.completed
          : successes > 0 ? SeoAdapterOutcomes.partial : SeoAdapterOutcomes.failed
        return {
          outcome, tasks: receipts, results, fetchedAt,
          error: outcome === SeoAdapterOutcomes.completed ? null : 'Some SEO provider results could not be collected.',
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
