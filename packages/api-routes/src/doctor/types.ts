import type { DatabaseClient } from '@ainyc/canonry-db'
import type { AgentPluginState, AgentProviderOption, InstallMethod, BundledSkillSnapshot, CheckCategory, CheckResultDto, CheckScope, CheckStatus } from '@ainyc/canonry-contracts'
import type { GoogleConnectionStore } from '../google.js'
import type { BingConnectionStore } from '../bing.js'
import type { WordpressConnectionStore } from '../wordpress.js'
import type { AdsCredentialStore } from '../ads.js'
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
  /** Worker version reported by the most recently ingested direct or Queue batch, if any. */
  lastWorkerVersion: string | null
  /** Hash of the bearer accepted by a push receiver. Never contains plaintext credentials. */
  ingestTokenHash: string | null
  /** Newest instant a sync clamped past without ingesting; null when none known. */
  skippedThroughAt?: string | null
  /** Residual Cloudflare Queue depth observed after the most recent bounded pull. */
  queueBacklogCount?: number | null
  /** Instant at which `queueBacklogCount` was observed. */
  queueBacklogObservedAt?: string | null
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

/** An `agent.provider` pin as the `config.agent-providers` check sees it. */
export interface AgentPinStatus {
  provider: string
  model: string
  configured: boolean
  /** The env var that supplies this provider's key. */
  envVar: string
  /** Why the pinned model id does not resolve, or null when it does. */
  modelError: string | null
}

export interface DoctorContext {
  db: DatabaseClient
  /** When the check is project-scoped, this resolves to the project row. */
  project: ProjectInfo | null
  googleConnectionStore?: GoogleConnectionStore
  bingConnectionStore?: BingConnectionStore
  wordpressConnectionStore?: WordpressConnectionStore
  ga4CredentialStore?: Ga4CredentialStore
  /** Website probe seam for `site.reachability`. Defaults to the SSRF-guarded live probe. */
  probeSiteReachability?: (url: string) => Promise<import('../site-reachability.js').SiteReachabilityResult>
  adsCredentialStore?: AdsCredentialStore
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  /**
   * Resolved Google Places config (key + tier + refresh cadence) for the
   * `gbp.places.api-key` check. Wired by `canonry serve`; cloud deployments
   * without a canonry config leave it undefined and the check `skipped`.
   */
  getPlacesConfig?: () => { apiKey?: string; tier: 'atmosphere' | 'pro' | 'off'; refreshIntervalDays: number }
  /** Resolved redirect URI (publicUrl + /api/v1/google/callback) used by the OAuth flow. */
  redirectUri?: string
  providerSummary?: ProviderSummaryEntry[]
  /**
   * Resolves which agent LLM providers (claude / openai / gemini / zai /
   * deepinfra) currently have a usable key, for the `config.agent-providers`
   * check. A closure (not a snapshot) so it reflects keys added at runtime
   * via the settings API. Wired by `canonry serve`; cloud deployments that
   * don't run the built-in agent leave it undefined and the check `skipped`.
   */
  getAgentProviderSummary?: () => AgentProviderOption[]
  /**
   * The `agent.provider` pin, when one is set, for the same check. A pin
   * bypasses auto-detection's key check, so a pinned provider with no key, or
   * a pinned model that does not resolve, fails every Aero turn even while
   * other providers are configured. Null when nothing is pinned.
   */
  getAgentPin?: () => AgentPinStatus | null
  /**
   * Whether the caller is an administrator of this install, as opposed to a
   * signed-in viewer or an API key narrower than the install. Wired from the
   * request by the doctor routes; checks that would otherwise disclose
   * administrator-only configuration consult it before filling in a summary.
   *
   * Undefined means no caller was resolved — a direct `runChecks` from the CLI,
   * where the operator is the one running it — and is treated as an
   * administrator, matching how the auth helpers treat an absent principal.
   */
  callerIsInstanceAdministrator?: boolean
  /**
   * Map of `traffic_sources.source_type` → adapter-specific validator. The
   * generic `traffic.source.credentials` / `traffic.source.scopes` checks
   * dispatch to the matching entry. Sources whose type has no validator
   * registered surface a `skipped` result rather than a fail.
   */
  trafficSourceValidators?: Record<string, TrafficSourceValidator>
  /**
   * On-disk paths the daemon depends on at runtime. Wired in by
   * `canonry serve`; cloud deployments (managed DB, no local config)
   * leave this undefined and the `db.file.present` / `config.file.present`
   * checks `skipped`. Used both by those checks and by the pre-request
   * runtime-state guard hook.
   */
  runtimeStatePaths?: { databasePath: string; configPath?: string | null }
  /**
   * Per-skill snapshot (version + file hashes) of the skills bundled into the
   * running canonry build, injected by the server because `api-routes` cannot
   * resolve canonry's bundled assets. Powers the `agent.skills.current` drift
   * check; left undefined by deployments that don't ship bundled skills (e.g.
   * cloud `apps/api`), which makes the check `skipped`.
   */
  bundledSkills?: BundledSkillSnapshot[]
  /** Live user-global native Canonry plugin state, when available on a local host. */
  getAgentPluginState?: () => AgentPluginState
  /**
   * Running version vs the newest published one, for `canonry.version.current`.
   * Must not block on the network. Wired by `canonry serve`; deployments that
   * don't self-update (cloud `apps/api`) leave it undefined and the check `skipped`.
   */
  getUpdateStatus?: () => DoctorUpdateStatus
  /** Offline, secret-free Google Ads/GTM metadata used by project Doctor checks. */
  getGoogleMarketingDoctorInput?: (
    ctx: DoctorContext,
  ) => import('./checks/google-marketing.js').GoogleMarketingDoctorInput | null | undefined
}

export interface DoctorUpdateStatus {
  /** False when an opt-out disabled the update check. */
  enabled: boolean
  /** Which opt-out disabled it (e.g. `DO_NOT_TRACK`, `config`), when `enabled` is false. */
  disabledBy?: string
  current: string
  /** Newest published version known to the host, or null when never fetched. */
  latest: string | null
  /** How this install is upgraded; `upgradeCommand` is already tailored to it. */
  installMethod: InstallMethod
  upgradeCommand: string
  url: string
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
  /**
   * Run only when a filter names this check. For probes that reach the network:
   * an unfiltered `canonry doctor --project` would otherwise exit 1 on one bad
   * response, with none of the debounce the scheduled loop applies.
   */
  optIn?: boolean
  /** When true and the project is missing for a project-scoped run, the runner emits a `skipped` result. */
  run: (ctx: DoctorContext) => Promise<CheckOutput> | CheckOutput
}

export interface RunChecksOptions {
  /** Filter check IDs. Each filter may be exact (`google.auth.connection`) or a prefix-with-wildcard (`google.auth.*`, `google.*`). */
  checkIds?: string[]
}

export type { CheckResultDto, CheckStatus, CheckCategory, CheckScope }
