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
