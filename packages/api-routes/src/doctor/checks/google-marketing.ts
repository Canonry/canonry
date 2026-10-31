import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@canonry/canonry-contracts'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

/** Required read-only Google OAuth scopes for the project-scoped marketing integrations. */
export const GOOGLE_ADS_REQUIRED_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
] as const

export const GTM_REQUIRED_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
] as const

export const FRESH_SNAPSHOT_WARN_DAYS = 7
export const FRESH_SNAPSHOT_FAIL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Secret-free projection of a Google Ads connection row. It intentionally
 * excludes OAuth tokens, client secrets, and developer tokens.
 */
export interface GoogleAdsDoctorConnectionRow {
  selectedLoginCustomerId: string | null
  selectedCustomerId: string | null
  scopes: readonly string[]
  lastInventorySnapshotAt: string | null
  lastMetricsSnapshotAt: string | null
}

/**
 * Secret-free projection of a GTM connection row. It intentionally excludes
 * OAuth tokens and client secrets.
 */
export interface GtmDoctorConnectionRow {
  selectedAccountId: string | null
  selectedContainerId: string | null
  selectedWorkspaceId: string | null
  scopes: readonly string[]
  lastSnapshotAt: string | null
}

/** Presence only: callers must not expose credential contents to Doctor. */
export interface GoogleMarketingCredentialPresence {
  googleAds: boolean
  gtm: boolean
}

/**
 * Typed, secret-free source rows for the Doctor mapper. These structural
 * shapes accept the corresponding Drizzle select rows without importing DB
 * schema types into this pure module.
 */
export interface GoogleMarketingDoctorRows {
  credentials: GoogleMarketingCredentialPresence
  googleAds: GoogleAdsDoctorConnectionRow | null
  gtm: GtmDoctorConnectionRow | null
}

export interface GoogleAdsDoctorStatusInput {
  /** Boolean metadata only; never an OAuth token or a token-derived value. */
  credentialsPresent: boolean
  grantedScopes: readonly string[]
  selectedLoginCustomerId: string | null
  selectedCustomerId: string | null
  latestSnapshotAt: string | null
}

export interface GtmDoctorStatusInput {
  /** Boolean metadata only; never an OAuth token or a token-derived value. */
  credentialsPresent: boolean
  grantedScopes: readonly string[]
  selectedAccountId: string | null
  selectedContainerId: string | null
  selectedWorkspaceId: string | null
  latestSnapshotAt: string | null
}

/**
 * The complete input consumed by this module. It is deliberately unable to
 * carry provider clients or credential material, which keeps every check
 * offline and safe to include in a Doctor report.
 */
export interface GoogleMarketingDoctorInput {
  googleAds: GoogleAdsDoctorStatusInput | null
  gtm: GtmDoctorStatusInput | null
}

/** A synchronous, DB/metadata-only resolver. It must never call a provider API. */
export type GoogleMarketingDoctorInputResolver = (
  ctx: DoctorContext,
) => GoogleMarketingDoctorInput | null | undefined

function newestSnapshotAt(
  first: string | null,
  second: string | null,
): string | null {
  if (!first) return second
  if (!second) return first

  const firstMs = Date.parse(first)
  const secondMs = Date.parse(second)
  // Preserve malformed data so the freshness check can report it rather than
  // silently declaring a different snapshot healthy.
  if (!Number.isFinite(firstMs)) return first
  if (!Number.isFinite(secondMs)) return second
  return firstMs >= secondMs ? first : second
}

/**
 * Adapts the new project-scoped DB rows plus boolean credential metadata into
 * the stable, secret-free evaluator input.
 */
export function googleMarketingDoctorInputFromRows(
  rows: GoogleMarketingDoctorRows,
): GoogleMarketingDoctorInput {
  return {
    googleAds: rows.googleAds
      ? {
          credentialsPresent: rows.credentials.googleAds,
          grantedScopes: rows.googleAds.scopes,
          selectedLoginCustomerId: rows.googleAds.selectedLoginCustomerId,
          selectedCustomerId: rows.googleAds.selectedCustomerId,
          latestSnapshotAt: newestSnapshotAt(
            rows.googleAds.lastInventorySnapshotAt,
            rows.googleAds.lastMetricsSnapshotAt,
          ),
        }
      : null,
    gtm: rows.gtm
      ? {
          credentialsPresent: rows.credentials.gtm,
          grantedScopes: rows.gtm.scopes,
          selectedAccountId: rows.gtm.selectedAccountId,
          selectedContainerId: rows.gtm.selectedContainerId,
          selectedWorkspaceId: rows.gtm.selectedWorkspaceId,
          latestSnapshotAt: rows.gtm.lastSnapshotAt,
        }
      : null,
  }
}

function unavailableStatus(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'google-marketing.status-unavailable',
    summary: 'Google marketing status metadata is not configured for this deployment.',
    remediation: null,
  }
}

function noProjectStatus(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'google-marketing.no-project',
    summary: 'Project context required.',
    remediation: null,
  }
}

function notConnectedStatus(
  provider: 'Google Ads' | 'Google Tag Manager',
  requiredScopes: readonly string[],
): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: provider === 'Google Ads'
      ? 'google-ads.auth.not-connected'
      : 'gtm.auth.not-connected',
    summary: `${provider} is not connected for this project.`,
    remediation: null,
    details: { requiredScopes: [...requiredScopes] },
  }
}

function credentialsOutput(
  provider: 'google-ads' | 'gtm',
  credentialsPresent: boolean,
): CheckOutput {
  if (credentialsPresent) {
    return {
      status: CheckStatuses.ok,
      code: `${provider}.auth.credentials-metadata-present`,
      summary: `${provider === 'google-ads' ? 'Google Ads' : 'Google Tag Manager'} credential metadata is present.`,
      remediation: null,
      details: { credentialsPresent },
    }
  }
  return {
    status: CheckStatuses.fail,
    code: `${provider}.auth.credentials-metadata-missing`,
    summary: `${provider === 'google-ads' ? 'Google Ads' : 'Google Tag Manager'} connection metadata exists but credentials are unavailable.`,
    remediation: 'Reconnect this Google integration to restore its credential metadata.',
    details: { credentialsPresent },
  }
}

function scopesOutput(
  provider: 'google-ads' | 'gtm',
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): CheckOutput {
  const granted = [...new Set(grantedScopes)]
  const missing = requiredScopes.filter(scope => !granted.includes(scope))
  const label = provider === 'google-ads' ? 'Google Ads' : 'Google Tag Manager'
  const scopeDescription = provider === 'google-ads' ? 'OAuth scope' : 'read-only OAuth scope'
  if (missing.length === 0) {
    return {
      status: CheckStatuses.ok,
      code: `${provider}.auth.scopes-ok`,
      summary: `${label} has the required ${scopeDescription}.`,
      remediation: null,
      details: { requiredScopes: [...requiredScopes], grantedScopes: granted, missingScopes: missing },
    }
  }
  return {
    status: CheckStatuses.fail,
    code: `${provider}.auth.required-scope-missing`,
    summary: `${label} is missing a required ${scopeDescription}.`,
    remediation: `Reconnect the integration and grant every required ${scopeDescription}.`,
    details: { requiredScopes: [...requiredScopes], grantedScopes: granted, missingScopes: missing },
  }
}

function snapshotOutput(
  provider: 'google-ads' | 'gtm',
  latestSnapshotAt: string | null,
  now: Date,
): CheckOutput {
  const label = provider === 'google-ads' ? 'Google Ads' : 'Google Tag Manager'
  if (!latestSnapshotAt) {
    return {
      status: CheckStatuses.warn,
      code: `${provider}.data.snapshot-never-captured`,
      summary: `${label} is connected but has no stored snapshot.`,
      remediation: 'Run a read-only snapshot sync to establish a fresh configuration record.',
      details: { latestSnapshotAt: null },
    }
  }
  const snapshotMs = Date.parse(latestSnapshotAt)
  if (!Number.isFinite(snapshotMs)) {
    return {
      status: CheckStatuses.fail,
      code: `${provider}.data.snapshot-timestamp-invalid`,
      summary: `${label} has an invalid latest snapshot timestamp.`,
      remediation: 'Run a new snapshot sync to replace the invalid freshness metadata.',
      details: { latestSnapshotAt },
    }
  }
  const ageDays = (now.getTime() - snapshotMs) / DAY_MS
  const details = { latestSnapshotAt, ageDays: Math.max(0, Math.round(ageDays)) }
  if (ageDays < 0) {
    return {
      status: CheckStatuses.warn,
      code: `${provider}.data.snapshot-in-future`,
      summary: `${label} latest snapshot timestamp is in the future.`,
      remediation: 'Check the host clock and run a new snapshot sync.',
      details,
    }
  }
  if (ageDays > FRESH_SNAPSHOT_FAIL_DAYS) {
    return {
      status: CheckStatuses.fail,
      code: `${provider}.data.snapshot-stale`,
      summary: `${label} latest snapshot is ${Math.round(ageDays)} days old (> ${FRESH_SNAPSHOT_FAIL_DAYS}d).`,
      remediation: 'Run a read-only snapshot sync and verify its schedule.',
      details,
    }
  }
  if (ageDays > FRESH_SNAPSHOT_WARN_DAYS) {
    return {
      status: CheckStatuses.warn,
      code: `${provider}.data.snapshot-aging`,
      summary: `${label} latest snapshot is ${Math.round(ageDays)} days old (> ${FRESH_SNAPSHOT_WARN_DAYS}d).`,
      remediation: 'Schedule a read-only snapshot sync to keep configuration evidence fresh.',
      details,
    }
  }
  return {
    status: CheckStatuses.ok,
    code: `${provider}.data.snapshot-fresh`,
    summary: `${label} latest snapshot is ${Math.round(ageDays)} day(s) old.`,
    remediation: null,
    details,
  }
}

/**
 * Pure evaluator for callers that already hold a secret-free status snapshot.
 * It performs no DB, filesystem, or provider I/O; callers can inject `now`
 * to keep age grading deterministic.
 */
export function evaluateGoogleMarketingDoctor(
  input: GoogleMarketingDoctorInput,
  now = new Date(),
): readonly CheckOutput[] {
  const ads = input.googleAds
  const gtm = input.gtm

  const adsCredentials = ads
    ? credentialsOutput('google-ads', ads.credentialsPresent)
    : notConnectedStatus('Google Ads', GOOGLE_ADS_REQUIRED_OAUTH_SCOPES)
  const adsScopes = ads
    ? scopesOutput('google-ads', ads.grantedScopes, GOOGLE_ADS_REQUIRED_OAUTH_SCOPES)
    : notConnectedStatus('Google Ads', GOOGLE_ADS_REQUIRED_OAUTH_SCOPES)
  const adsContext: CheckOutput = !ads
    ? notConnectedStatus('Google Ads', GOOGLE_ADS_REQUIRED_OAUTH_SCOPES)
    : !ads.selectedCustomerId
      ? {
          status: CheckStatuses.fail,
          code: 'google-ads.account.customer-not-selected',
          summary: 'Google Ads has no selected customer context for this project.',
          remediation: 'Select the customer whose campaigns and conversion goals this project should read.',
          details: {
            loginCustomerId: ads.selectedLoginCustomerId,
            customerId: ads.selectedCustomerId,
          },
        }
      : {
          status: CheckStatuses.ok,
          code: 'google-ads.account.context-selected',
          summary: 'Google Ads customer context is selected.',
          remediation: null,
          details: {
            loginCustomerId: ads.selectedLoginCustomerId,
            customerId: ads.selectedCustomerId,
          },
        }
  const adsSnapshot = ads
    ? snapshotOutput('google-ads', ads.latestSnapshotAt, now)
    : notConnectedStatus('Google Ads', GOOGLE_ADS_REQUIRED_OAUTH_SCOPES)

  const gtmCredentials = gtm
    ? credentialsOutput('gtm', gtm.credentialsPresent)
    : notConnectedStatus('Google Tag Manager', GTM_REQUIRED_OAUTH_SCOPES)
  const gtmScopes = gtm
    ? scopesOutput('gtm', gtm.grantedScopes, GTM_REQUIRED_OAUTH_SCOPES)
    : notConnectedStatus('Google Tag Manager', GTM_REQUIRED_OAUTH_SCOPES)
  const gtmContext: CheckOutput = !gtm
    ? notConnectedStatus('Google Tag Manager', GTM_REQUIRED_OAUTH_SCOPES)
    : !gtm.selectedAccountId || !gtm.selectedContainerId
      ? {
          status: CheckStatuses.fail,
          code: 'gtm.container.account-or-container-not-selected',
          summary: 'GTM needs both a selected account and container for this project.',
          remediation: 'Select the GTM account and container whose configuration this project should inspect.',
          details: {
            accountId: gtm.selectedAccountId,
            containerId: gtm.selectedContainerId,
            workspaceId: gtm.selectedWorkspaceId,
          },
        }
      : !gtm.selectedWorkspaceId
        ? {
            status: CheckStatuses.warn,
            code: 'gtm.container.workspace-not-selected',
            summary: 'GTM account and container are selected, but no draft workspace is selected.',
            remediation: 'Select a draft workspace when this project needs workspace-level configuration evidence.',
            details: {
              accountId: gtm.selectedAccountId,
              containerId: gtm.selectedContainerId,
              workspaceId: gtm.selectedWorkspaceId,
            },
          }
        : {
            status: CheckStatuses.ok,
            code: 'gtm.container.context-selected',
            summary: 'GTM account, container, and workspace context are selected.',
            remediation: null,
            details: {
              accountId: gtm.selectedAccountId,
              containerId: gtm.selectedContainerId,
              workspaceId: gtm.selectedWorkspaceId,
            },
          }
  const gtmSnapshot = gtm
    ? snapshotOutput('gtm', gtm.latestSnapshotAt, now)
    : notConnectedStatus('Google Tag Manager', GTM_REQUIRED_OAUTH_SCOPES)
  const gtmRuntime: CheckOutput = !gtm
    ? {
        status: CheckStatuses.skipped,
        code: 'gtm.runtime.not-connected',
        summary: 'GTM is not connected, so API configuration and runtime firing cannot be assessed.',
        remediation: null,
      }
    : {
        status: CheckStatuses.skipped,
        code: 'gtm.runtime.firing-not-proven',
        summary: 'GTM API configuration does not prove that a tag fired in a real browser session.',
        remediation: 'Verify runtime firing with browser-side evidence or a trusted conversion receipt.',
        details: { runtimeFiringProven: false },
      }

  return [
    adsCredentials,
    adsScopes,
    adsContext,
    adsSnapshot,
    gtmCredentials,
    gtmScopes,
    gtmContext,
    gtmSnapshot,
    gtmRuntime,
  ]
}

const CHECK_METADATA = [
  ['google-ads.auth.connection', CheckCategories.auth, 'Google Ads credential metadata'],
  ['google-ads.auth.scopes', CheckCategories.auth, 'Google Ads granted scopes'],
  ['google-ads.account.context', CheckCategories.auth, 'Google Ads customer context'],
  ['google-ads.data.recent-snapshot', CheckCategories.integrations, 'Google Ads latest snapshot'],
  ['gtm.auth.connection', CheckCategories.auth, 'GTM credential metadata'],
  ['gtm.auth.scopes', CheckCategories.auth, 'GTM granted scopes'],
  ['gtm.container.context', CheckCategories.auth, 'GTM account, container, and workspace context'],
  ['gtm.data.recent-snapshot', CheckCategories.integrations, 'GTM latest snapshot'],
  ['gtm.runtime.firing', CheckCategories.integrations, 'GTM runtime firing evidence'],
] as const

/**
 * Adapts the pure evaluator into the regular Doctor registry shape. The
 * resolver is synchronous by design: it may read already-loaded metadata or
 * DB rows, but it must never refresh tokens or call a provider.
 */
export function createGoogleMarketingDoctorChecks(
  resolveInput: GoogleMarketingDoctorInputResolver,
  now: () => Date = () => new Date(),
): readonly CheckDefinition[] {
  return CHECK_METADATA.map(([id, category, title], index) => ({
    id,
    category,
    scope: CheckScopes.project,
    title,
    run: (ctx) => {
      if (!ctx.project) return noProjectStatus()
      const input = resolveInput(ctx)
      if (!input) return unavailableStatus()
      return evaluateGoogleMarketingDoctor(input, now())[index]!
    },
  }))
}

/**
 * Registry-ready default. Parent wiring can add a synchronous
 * `getGoogleMarketingDoctorInput` hook to DoctorContext, or use the factory
 * above directly when it has a different metadata source.
 */
export const GOOGLE_MARKETING_DOCTOR_CHECKS = createGoogleMarketingDoctorChecks(
  (ctx) => ctx.getGoogleMarketingDoctorInput?.(ctx),
)
