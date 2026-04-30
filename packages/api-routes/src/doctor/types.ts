import type { DatabaseClient } from '@ainyc/canonry-db'
import type { CheckCategory, CheckResultDto, CheckScope, CheckStatus } from '@ainyc/canonry-contracts'
import type { GoogleConnectionStore } from '../google.js'
import type { BingConnectionStore } from '../bing.js'
import type { Ga4CredentialStore } from '../ga.js'
import type { ProviderSummaryEntry } from '../settings.js'

export interface DoctorContext {
  db: DatabaseClient
  /** When the check is project-scoped, this resolves to the project row. */
  project: ProjectInfo | null
  googleConnectionStore?: GoogleConnectionStore
  bingConnectionStore?: BingConnectionStore
  ga4CredentialStore?: Ga4CredentialStore
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  /** Resolved redirect URI (publicUrl + /api/v1/google/callback) used by the OAuth flow. */
  redirectUri?: string
  providerSummary?: ProviderSummaryEntry[]
}

export interface ProjectInfo {
  id: string
  name: string
  canonicalDomain: string
  displayName: string
}

/**
 * Output from a check. Always include `code`, `summary`, and `status`. The
 * runner adds `id`, `category`, `scope`, `title`, and `durationMs` from the
 * check definition + measurement.
 */
export type CheckOutput = Pick<CheckResultDto, 'status' | 'code' | 'summary'> & {
  remediation?: string | null
  details?: Record<string, unknown>
}

export interface CheckDefinition {
  id: string
  category: CheckCategory
  scope: CheckScope
  title: string
  /** When true and the project is missing for a project-scoped run, the runner emits a `skipped` result. */
  run: (ctx: DoctorContext) => Promise<CheckOutput> | CheckOutput
}

export interface RunChecksOptions {
  /** Filter check IDs. Each filter may be exact (`google.auth.connection`) or a prefix-with-wildcard (`google.auth.*`, `google.*`). */
  checkIds?: string[]
}

export type { CheckResultDto, CheckStatus, CheckCategory, CheckScope }
