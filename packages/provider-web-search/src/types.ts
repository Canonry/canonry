import type { WebSearchBackend } from '@ainyc/canonry-contracts'

export interface WebSearchConfig {
  apiKey: string
  backend: WebSearchBackend
  /** Google CSE search engine ID (cx parameter) — required when backend is 'google-cse' */
  cx?: string
}

export interface IndexPage {
  url: string
  title: string
}

export interface SiteQueryResult {
  domain: string
  keyword: string
  indexedPageCount: number
  topPages: IndexPage[]
}
