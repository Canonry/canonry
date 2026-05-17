import type { DatabaseClient } from '@ainyc/canonry-db'
import type { CheckCategory, CheckResultDto, CheckScope, CheckStatus } from '@ainyc/canonry-contracts'
import type { GoogleConnectionStore } from '../google.js'
import type { BingConnectionStore } from '../bing.js'
import type { Ga4CredentialStore } from '../ga.js'
import type { ProviderSummaryEntry } from '../settings.js'

/**
 * Generic traffic-source row shape passed to a `TrafficSourceValidator`.
 * Mirrors the public columns of `trafficSources`; this surface stays
 * deliberately loose so future adapters (WordPress plugin, others) don't
 * need to teach the doctor framework anything new.
 */
export interface TrafficSourceProbe {
  id: string
  projectId: string
  projectName: string
  sourceType: string
  displayName: string
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  configJson: Record<string, unknown>
}

/**
 * Per-source-type validation hook. Adapters register a validator under their
 * `sourceType` key (e.g. `'cloud-run'`, `'wp-plugin'`). Each method returns a
 * `CheckOutput` (ok / warn / fail / skipped) for a single source row, or null
 * to indicate the validator does not implement that check (the runner will
 * surface a `skipped` result with `code: '<id>.no-validator'`).
 */
export interface TrafficSourceValidator {
  validateCredentials?(source: TrafficSourceProbe): Promise<CheckOutput | null> | CheckOutput | null
  validateScopes?(source: TrafficSourceProbe): Promise<CheckOutput | null> | CheckOutput | null
}

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
  /**
   * Map of `traffic_sources.source_type` → adapter-specific validator. The
   * generic `traffic.source.credentials` / `traffic.source.scopes` checks
   * dispatch to the matching entry. Sources whose type has no validator
   * registered surface a `skipped` result rather than a fail.
   */
  trafficSourceValidators?: Record<string, TrafficSourceValidator>
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
