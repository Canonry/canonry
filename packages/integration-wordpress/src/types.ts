import type { WordpressEnv } from '@ainyc/canonry-contracts'

export interface WordpressConnectionRecord {
  projectName: string
  url: string
  stagingUrl?: string
  username: string
  appPassword: string
  defaultEnv: WordpressEnv
  createdAt: string
  updatedAt: string
}

/**
 * The fetch every request the client makes goes through, the site's REST API,
 * its rendered pages and its llms.txt alike. Defaults to global `fetch`. A host
 * that must not let a site steer it to internal addresses passes one that
 * checks every address it dials and every redirect hop.
 */
export type WordpressFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * A stored connection plus how to reach it. `fetchImpl` is a runtime value:
 * hand the client this shape, and the store only the record without it.
 */
export interface WordpressClientConnection extends WordpressConnectionRecord {
  fetchImpl?: WordpressFetch
}

export interface WordpressSiteContext {
  env: WordpressEnv
  siteUrl: string
}

export interface WordpressRestPage {
  id: number
  slug: string
  status: string
  link?: string
  modified?: string
  modified_gmt?: string
  title?: { rendered?: string }
  content?: { rendered?: string; raw?: string }
  meta?: Record<string, unknown>
}

export class WordpressApiError extends Error {
  readonly statusCode: number
  readonly code: 'AUTH_INVALID' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'UPSTREAM_ERROR' | 'UNSUPPORTED'

  constructor(
    code: WordpressApiError['code'],
    message: string,
    statusCode: number,
  ) {
    super(message)
    this.name = 'WordpressApiError'
    this.code = code
    this.statusCode = statusCode
  }
}
