/**
 * Web search adapter for indexing sweep queries.
 *
 * Supports two backends:
 *  - serper   → https://serper.dev  (simple JSON POST, fast)
 *  - google-cse → Google Custom Search JSON API (requires cx)
 *
 * Usage:
 *   const adapter = new WebSearchAdapter({ apiKey: '...', backend: 'serper' })
 *   const result  = await adapter.siteQuery('example.com', 'keyword phrase')
 */

import type { WebSearchConfig, SiteQueryResult, IndexPage } from './types.js'

const SERPER_ENDPOINT = 'https://google.serper.dev/search'
const GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1'

export class WebSearchAdapter {
  private config: WebSearchConfig

  constructor(config: WebSearchConfig) {
    if (!config.apiKey) {
      throw new Error('WebSearchAdapter: apiKey is required')
    }
    if (config.backend === 'google-cse' && !config.cx) {
      throw new Error('WebSearchAdapter: cx (search engine ID) is required for google-cse backend')
    }
    this.config = config
  }

  /**
   * Execute a `site:<domain> <keyword>` query and return indexed page data.
   *
   * @param domain  The domain to scope the query to (e.g. "example.com")
   * @param keyword The keyword phrase to search for
   * @param maxResults Maximum number of top pages to return (default 10)
   */
  async siteQuery(domain: string, keyword: string, maxResults = 10): Promise<SiteQueryResult> {
    const query = `site:${domain} ${keyword}`

    if (this.config.backend === 'serper') {
      return this.serperQuery(domain, keyword, query, maxResults)
    }
    return this.googleCseQuery(domain, keyword, query, maxResults)
  }

  private async serperQuery(
    domain: string,
    keyword: string,
    query: string,
    maxResults: number,
  ): Promise<SiteQueryResult> {
    const res = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: Math.min(maxResults, 10) }),
    })

    if (!res.ok) {
      throw new Error(`Serper API error: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as {
      organic?: Array<{ title?: string; link?: string }>
      searchInformation?: { totalResults?: string }
    }

    const organic = data.organic ?? []
    const topPages: IndexPage[] = organic.slice(0, maxResults).map(r => ({
      url: r.link ?? '',
      title: r.title ?? '',
    }))

    // Serper returns the estimated total result count in searchInformation
    const totalStr = data.searchInformation?.totalResults
    const indexedPageCount = totalStr ? parseInt(totalStr.replace(/,/g, ''), 10) || topPages.length : topPages.length

    return { domain, keyword, indexedPageCount, topPages }
  }

  private async googleCseQuery(
    domain: string,
    keyword: string,
    query: string,
    maxResults: number,
  ): Promise<SiteQueryResult> {
    const params = new URLSearchParams({
      key: this.config.apiKey,
      cx: this.config.cx!,
      q: query,
      num: String(Math.min(maxResults, 10)),
    })

    const res = await fetch(`${GOOGLE_CSE_ENDPOINT}?${params.toString()}`)

    if (!res.ok) {
      // NOTE: Google CSE does not support bearer-token auth; the API key is in the query string.
      // Redact the key from error messages to avoid leaking it in logs.
      throw new Error(`Google CSE API error: ${res.status} ${res.statusText} (key redacted from URL)`)
    }

    const data = (await res.json()) as {
      items?: Array<{ title?: string; link?: string }>
      searchInformation?: { totalResults?: string }
    }

    const items = data.items ?? []
    const topPages: IndexPage[] = items.slice(0, maxResults).map(r => ({
      url: r.link ?? '',
      title: r.title ?? '',
    }))

    // Google CSE returns formatted strings like "1,230" — strip commas before parsing
    const totalStr = data.searchInformation?.totalResults
    const indexedPageCount = totalStr
      ? parseInt(totalStr.replace(/,/g, ''), 10) || topPages.length
      : topPages.length

    return { domain, keyword, indexedPageCount, topPages }
  }

  /** Validate configuration without making an API call */
  validateConfig(): { ok: boolean; message: string } {
    if (!this.config.apiKey) {
      return { ok: false, message: 'Missing apiKey for web_search provider' }
    }
    if (this.config.backend === 'google-cse' && !this.config.cx) {
      return { ok: false, message: 'Missing cx (search engine ID) for google-cse backend' }
    }
    return { ok: true, message: `web_search (${this.config.backend}) configured` }
  }
}

export function createWebSearchAdapter(
  apiKey: string,
  backend: WebSearchConfig['backend'] = 'serper',
  cx?: string,
): WebSearchAdapter {
  return new WebSearchAdapter({ apiKey, backend, cx })
}
