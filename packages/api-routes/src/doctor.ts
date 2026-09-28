import type { FastifyInstance } from 'fastify'
import { ALL_CHECKS } from './doctor/registry.js'
import { runChecks } from './doctor/runner.js'
import type { AgentPluginState, BundledSkillSnapshot } from '@ainyc/canonry-contracts'
import type { DoctorContext, DoctorUpdateStatus, TrafficSourceValidator } from './doctor/types.js'
import type { AdsCredentialStore } from './ads.js'
import type { GoogleConnectionStore } from './google.js'
import type { BingConnectionStore } from './bing.js'
import type { WordpressConnectionStore } from './wordpress.js'
import type { Ga4CredentialStore } from './ga.js'
import type { ProviderSummaryEntry } from './settings.js'
import type { AgentProviderOption } from '@ainyc/canonry-contracts'
import { reportMonthSchema, validationError } from '@ainyc/canonry-contracts'
import { isInstanceAdministrator } from './auth.js'
import { resolveProject } from './helpers.js'
import type { GoogleMarketingDoctorInputResolver } from './doctor/checks/google-marketing.js'

export interface DoctorRoutesOptions {
  googleConnectionStore?: GoogleConnectionStore
  bingConnectionStore?: BingConnectionStore
  wordpressConnectionStore?: WordpressConnectionStore
  ga4CredentialStore?: Ga4CredentialStore
  adsCredentialStore?: AdsCredentialStore
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  /** Resolved Places config for the `gbp.places.api-key` check. See `DoctorContext.getPlacesConfig`. */
  getPlacesConfig?: () => { apiKey?: string; tier: 'atmosphere' | 'pro' | 'off'; refreshIntervalDays: number }
  /** Used to derive the redirect URI displayed by the redirect-uri check. */
  publicUrl?: string
  providerSummary?: ProviderSummaryEntry[]
  /** Resolves agent LLM provider key status for the `config.agent-providers` check. See `DoctorContext.getAgentProviderSummary`. */
  getAgentProviderSummary?: () => AgentProviderOption[]
  /** The `agent.provider` pin for the same check. See `DoctorContext.getAgentPin`. */
  getAgentPin?: DoctorContext['getAgentPin']
  /**
   * Map of `traffic_sources.source_type` → adapter validator. Optional — the
   * generic `traffic.source.credentials` / `traffic.source.scopes` checks
   * skip with a clear `no-validator` code when an adapter doesn't register.
   */
  trafficSourceValidators?: Record<string, TrafficSourceValidator>
  /** On-disk paths the daemon depends on. See `DoctorContext.runtimeStatePaths`. */
  runtimeStatePaths?: { databasePath: string; configPath?: string | null }
  /** Bundled-skill snapshots powering the `agent.skills.current` check. See `DoctorContext.bundledSkills`. */
  bundledSkills?: BundledSkillSnapshot[]
  /** Live user-global native Canonry plugin state, when available on a local host. */
  getAgentPluginState?: () => AgentPluginState
  /** Running vs latest published version. See `DoctorContext.getUpdateStatus`. */
  getUpdateStatus?: () => DoctorUpdateStatus
  /** Synchronous, secret-free metadata resolver. It must not call Google APIs. */
  getGoogleMarketingDoctorInput?: GoogleMarketingDoctorInputResolver
}

function parseReportMonth(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const parsed = reportMonthSchema.safeParse(raw)
  if (!parsed.success || raw > new Date().toISOString().slice(0, 7)) throw validationError('"reportMonth" must be YYYY-MM and cannot be in the future')
  return parsed.data
}

function parseCheckIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function resolveRedirectUri(opts: DoctorRoutesOptions): string | undefined {
  if (!opts.publicUrl) return undefined
  // Mirror the OAuth flow in `google.ts`, which appends `/api/v1/google/callback`
  // to publicUrl. publicUrl already includes any configured basePath, so the
  // route-plugin prefix must NOT be reused here — that would double the basePath.
  return `${opts.publicUrl.replace(/\/$/, '')}/api/v1/google/callback`
}

export async function doctorRoutes(app: FastifyInstance, opts: DoctorRoutesOptions) {
  const redirectUri = resolveRedirectUri(opts)

  // GET /doctor — global checks (config, providers, etc.)
  app.get<{ Querystring: { check?: string; reportMonth?: string } }>('/doctor', async (request) => {
    const checkIds = parseCheckIds(request.query.check)
    const ctx: DoctorContext = {
      db: app.db,
      reportMonth: parseReportMonth(request.query.reportMonth),
      project: null,
      googleConnectionStore: opts.googleConnectionStore,
      bingConnectionStore: opts.bingConnectionStore,
      wordpressConnectionStore: opts.wordpressConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      adsCredentialStore: opts.adsCredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      getPlacesConfig: opts.getPlacesConfig,
      redirectUri,
      providerSummary: opts.providerSummary,
      getAgentProviderSummary: opts.getAgentProviderSummary,
      getAgentPin: opts.getAgentPin,
      callerIsInstanceAdministrator: isInstanceAdministrator(request),
      trafficSourceValidators: opts.trafficSourceValidators,
      runtimeStatePaths: opts.runtimeStatePaths,
      bundledSkills: opts.bundledSkills,
      getAgentPluginState: opts.getAgentPluginState,
      getUpdateStatus: opts.getUpdateStatus,
      getGoogleMarketingDoctorInput: opts.getGoogleMarketingDoctorInput,
    }
    return runChecks(ctx, ALL_CHECKS, { checkIds })
  })

  // GET /projects/:name/doctor — project-scoped checks (Google auth, GA, etc.)
  app.get<{
    Params: { name: string }
    Querystring: { check?: string; reportMonth?: string }
  }>('/projects/:name/doctor', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const checkIds = parseCheckIds(request.query.check)
    const ctx: DoctorContext = {
      db: app.db,
      reportMonth: parseReportMonth(request.query.reportMonth),
      project: {
        id: project.id,
        name: project.name,
        canonicalDomain: project.canonicalDomain,
        displayName: project.displayName,
      },
      googleConnectionStore: opts.googleConnectionStore,
      bingConnectionStore: opts.bingConnectionStore,
      wordpressConnectionStore: opts.wordpressConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      adsCredentialStore: opts.adsCredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      getPlacesConfig: opts.getPlacesConfig,
      redirectUri,
      providerSummary: opts.providerSummary,
      getAgentProviderSummary: opts.getAgentProviderSummary,
      getAgentPin: opts.getAgentPin,
      callerIsInstanceAdministrator: isInstanceAdministrator(request),
      trafficSourceValidators: opts.trafficSourceValidators,
      runtimeStatePaths: opts.runtimeStatePaths,
      bundledSkills: opts.bundledSkills,
      getAgentPluginState: opts.getAgentPluginState,
      getUpdateStatus: opts.getUpdateStatus,
      getGoogleMarketingDoctorInput: opts.getGoogleMarketingDoctorInput,
    }
    return runChecks(ctx, ALL_CHECKS, { checkIds })
  })
}
