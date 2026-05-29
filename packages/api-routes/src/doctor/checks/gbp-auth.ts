import { and, eq } from 'drizzle-orm'
import { gbpLocations } from '@ainyc/canonry-db'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import { refreshAccessToken } from '@ainyc/canonry-integration-google'
import { GBP_SCOPE, listAccounts, GbpApiError } from '@ainyc/canonry-integration-google-business-profile'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'
import type { GoogleConnectionRecord } from '../../google.js'

const RECENT_SYNC_WARN_DAYS = 7
const RECENT_SYNC_FAIL_DAYS = 30

function skippedNoProject(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'gbp.auth.no-project',
    summary: 'Project context required.',
    remediation: null,
  }
}

function storeUnavailable(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'gbp.auth.store-unavailable',
    summary: 'Google connection store is not configured for this deployment.',
    remediation: null,
  }
}

interface ResolvedGbpToken {
  accessToken: string
  conn: GoogleConnectionRecord
}

/** Resolve (and refresh) a GBP access token for the project, mirroring the
 *  GSC connection check but on the `gbp` connection type. */
async function resolveGbpToken(
  ctx: DoctorContext,
): Promise<{ ok: true; token: ResolvedGbpToken } | { ok: false; output: CheckOutput }> {
  if (!ctx.project) return { ok: false, output: skippedNoProject() }
  const store = ctx.googleConnectionStore
  if (!store) return { ok: false, output: storeUnavailable() }

  const auth = ctx.getGoogleAuthConfig?.() ?? {}
  if (!auth.clientId || !auth.clientSecret) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'gbp.auth.oauth-not-configured',
        summary: 'Google OAuth client ID or secret is missing.',
        remediation: 'Set Google OAuth credentials in ~/.canonry/config.yaml under `google.clientId` and `google.clientSecret`.',
      },
    }
  }
  const conn = store.getConnection(ctx.project.canonicalDomain, 'gbp')
  if (!conn) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'gbp.auth.no-connection',
        summary: `No Google Business Profile connection for ${ctx.project.canonicalDomain}.`,
        remediation: `Run \`canonry gbp connect ${ctx.project.name}\` to authorize.`,
      },
    }
  }
  if (!conn.refreshToken) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'gbp.auth.no-refresh-token',
        summary: 'GBP connection exists but has no refresh token stored.',
        remediation: `Run \`canonry gbp connect ${ctx.project.name}\` to re-authorize and capture a refresh token.`,
        details: { domain: conn.domain },
      },
    }
  }
  try {
    const tokens = await refreshAccessToken(auth.clientId, auth.clientSecret, conn.refreshToken)
    return { ok: true, token: { accessToken: tokens.access_token, conn } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'gbp.auth.refresh-failed',
        summary: 'Refresh token rejected by Google.',
        remediation: `Run \`canonry gbp connect ${ctx.project.name}\` to re-authorize. Refresh tokens are revoked if the user changes their password or the OAuth client is rotated.`,
        details: { domain: conn.domain, error: message },
      },
    }
  }
}

const connectionCheck: CheckDefinition = {
  id: 'gbp.auth.connection',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GBP OAuth connection',
  run: async (ctx) => {
    const resolved = await resolveGbpToken(ctx)
    if (!resolved.ok) return resolved.output
    return {
      status: CheckStatuses.ok,
      code: 'gbp.auth.connected',
      summary: 'GBP OAuth connection is valid and refreshable.',
      remediation: null,
    }
  },
}

const scopesCheck: CheckDefinition = {
  id: 'gbp.auth.scopes',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GBP granted scopes',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const store = ctx.googleConnectionStore
    if (!store) return storeUnavailable()
    const conn = store.getConnection(ctx.project.canonicalDomain, 'gbp')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.auth.no-connection',
        summary: 'No GBP connection — run gbp.auth.connection first.',
        remediation: null,
      }
    }
    const granted = new Set(conn.scopes ?? [])
    if (granted.has(GBP_SCOPE)) {
      return {
        status: CheckStatuses.ok,
        code: 'gbp.auth.scopes-ok',
        summary: 'The business.manage scope is granted.',
        remediation: null,
        details: { granted: [...granted] },
      }
    }
    return {
      status: CheckStatuses.fail,
      code: 'gbp.auth.required-scope-missing',
      summary: 'The required business.manage scope is not granted.',
      remediation: `Reconnect to grant the scope: \`canonry gbp connect ${ctx.project.name}\`.`,
      details: { granted: [...granted], missing: [GBP_SCOPE] },
    }
  },
}

const accountAccessCheck: CheckDefinition = {
  id: 'gbp.account.access',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GBP account access',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const store = ctx.googleConnectionStore
    if (!store) return storeUnavailable()
    const conn = store.getConnection(ctx.project.canonicalDomain, 'gbp')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.auth.no-connection',
        summary: 'No GBP connection — run gbp.auth.connection first.',
        remediation: null,
      }
    }
    if (!conn.gbpAccountName) {
      return {
        status: CheckStatuses.fail,
        code: 'gbp.account.none-selected',
        summary: 'GBP connection has no account selected for this project.',
        remediation: `Run \`canonry gbp locations discover ${ctx.project.name} --account accounts/<id>\` to pick the account this project tracks.`,
      }
    }
    const resolved = await resolveGbpToken(ctx)
    if (!resolved.ok) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.auth.token-unresolved',
        summary: 'Skipped — token could not be refreshed (see gbp.auth.connection).',
        remediation: null,
      }
    }
    let accounts
    try {
      accounts = await listAccounts(resolved.token.accessToken)
    } catch (err) {
      if (err instanceof GbpApiError) {
        if (err.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
          return {
            status: CheckStatuses.fail,
            code: 'gbp.account.scope-insufficient',
            summary: 'The OAuth token is missing the business.manage scope.',
            remediation: `Reconnect with the business.manage scope: \`canonry gbp connect ${ctx.project.name}\`.`,
            details: { reason: err.reason },
          }
        }
        // 0-QPM = the per-project access form is still pending Google approval.
        // Auth itself is fine; the API just isn't enabled yet — warn, don't fail.
        if (err.reason === 'RATE_LIMIT_EXCEEDED' && err.quotaLimitValue === 0) {
          return {
            status: CheckStatuses.warn,
            code: 'gbp.account.quota-pending',
            summary: 'Business Profile API quota is 0 QPM — the access request is still pending Google approval.',
            remediation: 'Submit / await the GBP API access form: https://support.google.com/business/contact/api_default',
            details: { reason: err.reason },
          }
        }
        return {
          status: CheckStatuses.fail,
          code: 'gbp.account.list-failed',
          summary: `Failed to list GBP accounts: ${err.message}`,
          remediation: 'Check Business Profile API availability and that the API is enabled on the GCP project, then re-run.',
          details: { reason: err.reason ?? undefined, status: err.status },
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        status: CheckStatuses.fail,
        code: 'gbp.account.list-failed',
        summary: 'Failed to list GBP accounts for the authorized account.',
        remediation: 'Check Business Profile API availability, then re-run.',
        details: { error: message },
      }
    }
    const match = accounts.find((a) => a.name === conn.gbpAccountName)
    if (!match) {
      return {
        status: CheckStatuses.fail,
        code: 'gbp.account.not-accessible',
        summary: `Tracked account "${conn.gbpAccountName}" is not in the authorized user's accessible accounts.`,
        remediation:
          `Either reconnect with a Google account that manages "${conn.gbpAccountName}", ` +
          `or re-point the project: \`canonry gbp locations discover ${ctx.project.name} --account <accounts/id> --switch-account\`.`,
        details: {
          trackedAccount: conn.gbpAccountName,
          accessibleAccounts: accounts.map((a) => a.name),
        },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'gbp.account.accessible',
      summary: `Tracked account "${conn.gbpAccountName}" is accessible.`,
      remediation: null,
      details: { trackedAccount: conn.gbpAccountName },
    }
  },
}

const recentSyncCheck: CheckDefinition = {
  id: 'gbp.data.recent-sync',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'GBP recent sync',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const selected = ctx.db
      .select({ locationName: gbpLocations.locationName, syncedAt: gbpLocations.syncedAt })
      .from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, ctx.project.id), eq(gbpLocations.selected, true)))
      .all()

    if (selected.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'gbp.data.no-selected-locations',
        summary: 'No selected GBP locations for this project.',
        remediation: null,
      }
    }

    const syncTimes = selected
      .map((l) => l.syncedAt)
      .filter((s): s is string => Boolean(s))
      .map((s) => new Date(s).getTime())
      .filter((t) => !Number.isNaN(t))

    if (syncTimes.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'gbp.data.never-synced',
        summary: `${selected.length} selected location(s) have never been synced.`,
        remediation: `Run \`canonry gbp sync ${ctx.project.name}\` to pull performance + local signals.`,
        details: { selectedLocations: selected.length },
      }
    }

    const newest = Math.max(...syncTimes)
    const ageDays = (Date.now() - newest) / (1000 * 60 * 60 * 24)
    const details = { selectedLocations: selected.length, newestSyncAgeDays: Math.round(ageDays) }

    if (ageDays > RECENT_SYNC_FAIL_DAYS) {
      return {
        status: CheckStatuses.fail,
        code: 'gbp.data.stale',
        summary: `Most recent GBP sync was ${Math.round(ageDays)} days ago (> ${RECENT_SYNC_FAIL_DAYS}d).`,
        remediation: `Run \`canonry gbp sync ${ctx.project.name}\` or set a gbp-sync schedule.`,
        details,
      }
    }
    if (ageDays > RECENT_SYNC_WARN_DAYS) {
      return {
        status: CheckStatuses.warn,
        code: 'gbp.data.aging',
        summary: `Most recent GBP sync was ${Math.round(ageDays)} days ago (> ${RECENT_SYNC_WARN_DAYS}d).`,
        remediation: `Run \`canonry gbp sync ${ctx.project.name}\` or set a gbp-sync schedule to keep data fresh.`,
        details,
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'gbp.data.fresh',
      summary: `Most recent GBP sync was ${Math.round(ageDays)} day(s) ago.`,
      remediation: null,
      details,
    }
  },
}

export const GBP_AUTH_CHECKS: readonly CheckDefinition[] = [
  connectionCheck,
  scopesCheck,
  accountAccessCheck,
  recentSyncCheck,
]

// Re-export for tests that need direct access to specific checks.
export const GBP_AUTH_CHECK_BY_ID = Object.fromEntries(
  GBP_AUTH_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
