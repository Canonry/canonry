import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import {
  GSC_SCOPE,
  INDEXING_SCOPE,
  GoogleApiError,
  GoogleAuthError,
  listSites,
  refreshAccessToken,
} from '@ainyc/canonry-integration-google'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

const REQUIRED_GSC_SCOPES = [GSC_SCOPE, INDEXING_SCOPE]

interface ResolvedToken {
  accessToken: string
  refreshFailedReason?: string
}

async function resolveAccessToken(ctx: DoctorContext): Promise<{ ok: true; token: ResolvedToken } | { ok: false; output: CheckOutput }> {
  if (!ctx.project) {
    return { ok: false, output: skippedNoProject() }
  }
  const store = ctx.googleConnectionStore
  if (!store) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.skipped,
        code: 'google.auth.store-unavailable',
        summary: 'Google connection store is not configured for this deployment.',
        remediation: null,
      },
    }
  }
  const auth = ctx.getGoogleAuthConfig?.() ?? {}
  if (!auth.clientId || !auth.clientSecret) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'google.auth.oauth-not-configured',
        summary: 'Google OAuth client ID or secret is missing.',
        remediation: 'Set Google OAuth credentials in ~/.canonry/config.yaml under `google.clientId` and `google.clientSecret`.',
      },
    }
  }
  const conn = store.getConnection(ctx.project.canonicalDomain, 'gsc')
  if (!conn) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'google.auth.no-connection',
        summary: `No GSC connection for ${ctx.project.canonicalDomain}.`,
        remediation: `Run \`canonry google connect ${ctx.project.name} --type gsc\` to authorize.`,
      },
    }
  }
  if (!conn.refreshToken) {
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'google.auth.no-refresh-token',
        summary: 'GSC connection exists but has no refresh token stored.',
        remediation: `Run \`canonry google connect ${ctx.project.name} --type gsc\` to re-authorize and capture a refresh token.`,
        details: { domain: conn.domain },
      },
    }
  }
  try {
    const tokens = await refreshAccessToken(auth.clientId, auth.clientSecret, conn.refreshToken)
    return { ok: true, token: { accessToken: tokens.access_token } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      output: {
        status: CheckStatuses.fail,
        code: 'google.auth.refresh-failed',
        summary: 'Refresh token rejected by Google.',
        remediation: `Run \`canonry google connect ${ctx.project.name} --type gsc\` to re-authorize. Refresh tokens are revoked if the user changes their password or the OAuth client is rotated.`,
        details: { domain: conn.domain, error: message },
      },
    }
  }
}

function skippedNoProject(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'google.auth.no-project',
    summary: 'Project context required.',
    remediation: null,
  }
}

const connectionCheck: CheckDefinition = {
  id: 'google.auth.connection',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GSC OAuth connection',
  run: async (ctx) => {
    const resolved = await resolveAccessToken(ctx)
    if (!resolved.ok) return resolved.output
    return {
      status: CheckStatuses.ok,
      code: 'google.auth.connected',
      summary: 'GSC OAuth connection is valid and refreshable.',
      remediation: null,
    }
  },
}

const propertyAccessCheck: CheckDefinition = {
  id: 'google.auth.property-access',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GSC property access',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const store = ctx.googleConnectionStore
    if (!store) {
      return {
        status: CheckStatuses.skipped,
        code: 'google.auth.store-unavailable',
        summary: 'Google connection store is not configured for this deployment.',
        remediation: null,
      }
    }
    const conn = store.getConnection(ctx.project.canonicalDomain, 'gsc')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'google.auth.no-connection',
        summary: 'No GSC connection — run google.auth.connection first.',
        remediation: null,
      }
    }
    if (!conn.propertyId) {
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.no-property-selected',
        summary: 'GSC connection has no property selected.',
        remediation: `Run \`canonry google properties ${ctx.project.name}\` to list available properties, then \`canonry google set-property ${ctx.project.name} <siteUrl>\`.`,
      }
    }
    const resolved = await resolveAccessToken(ctx)
    if (!resolved.ok) {
      return {
        status: CheckStatuses.skipped,
        code: 'google.auth.token-unresolved',
        summary: 'Skipped — token could not be refreshed (see google.auth.connection).',
        remediation: null,
      }
    }
    let sites
    try {
      sites = await listSites(resolved.token.accessToken)
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 403) {
        return {
          status: CheckStatuses.fail,
          code: 'google.auth.principal-forbidden',
          summary: 'The authorized Google account is forbidden from listing GSC sites.',
          remediation: `Reconnect with a Google account that has access in Search Console: \`canonry google connect ${ctx.project.name} --type gsc\`.`,
          details: { error: err.message },
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.list-sites-failed',
        summary: 'Failed to list GSC sites for the authorized account.',
        remediation: 'Check Google Search Console availability, then re-run.',
        details: { error: message },
      }
    }
    const match = sites.find((site) => site.siteUrl === conn.propertyId)
    if (!match) {
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.property-not-accessible',
        summary: `Selected property "${conn.propertyId}" is not in the authorized account's accessible sites list.`,
        remediation:
          `Either grant the authorizing Google account access to "${conn.propertyId}" in Search Console, ` +
          `or run \`canonry google set-property ${ctx.project.name} <siteUrl>\` to pick an accessible site.`,
        details: {
          selectedProperty: conn.propertyId,
          accessibleSites: sites.map((s) => s.siteUrl),
        },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'google.auth.property-accessible',
      summary: `Property "${conn.propertyId}" is accessible (permission: ${match.permissionLevel}).`,
      remediation: null,
      details: {
        selectedProperty: conn.propertyId,
        permissionLevel: match.permissionLevel,
      },
    }
  },
}

const redirectUriCheck: CheckDefinition = {
  id: 'google.auth.redirect-uri',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'OAuth redirect URI',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const auth = ctx.getGoogleAuthConfig?.() ?? {}
    if (!auth.clientId || !auth.clientSecret) {
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.oauth-not-configured',
        summary: 'Google OAuth client ID or secret is missing.',
        remediation: 'Set `google.clientId` and `google.clientSecret` in ~/.canonry/config.yaml.',
      }
    }
    if (!ctx.redirectUri) {
      return {
        status: CheckStatuses.warn,
        code: 'google.auth.redirect-uri-auto-detected',
        summary: 'No publicUrl configured — OAuth callback will be auto-detected from request headers each connect.',
        remediation:
          'Set `publicUrl` in ~/.canonry/config.yaml so canonry uses a stable redirect URI ' +
          '(e.g. http://localhost:4100). Then register that exact URI in Google Cloud Console under your OAuth client.',
      }
    }
    let parsed
    try {
      parsed = new URL(ctx.redirectUri)
    } catch {
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.redirect-uri-invalid',
        summary: `Configured redirect URI is not a valid URL: ${ctx.redirectUri}`,
        remediation: 'Set `publicUrl` to a valid http(s) URL in ~/.canonry/config.yaml.',
        details: { redirectUri: ctx.redirectUri },
      }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        status: CheckStatuses.fail,
        code: 'google.auth.redirect-uri-invalid',
        summary: `Redirect URI must use http or https: ${ctx.redirectUri}`,
        remediation: 'Set `publicUrl` to an http(s) URL.',
        details: { redirectUri: ctx.redirectUri },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'google.auth.redirect-uri-configured',
      summary: `Redirect URI is ${ctx.redirectUri}.`,
      remediation: `Ensure this exact URI is listed in your OAuth client's authorized redirect URIs in Google Cloud Console.`,
      details: { redirectUri: ctx.redirectUri },
    }
  },
}

const scopesCheck: CheckDefinition = {
  id: 'google.auth.scopes',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GSC granted scopes',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const store = ctx.googleConnectionStore
    if (!store) {
      return {
        status: CheckStatuses.skipped,
        code: 'google.auth.store-unavailable',
        summary: 'Google connection store is not configured for this deployment.',
        remediation: null,
      }
    }
    const conn = store.getConnection(ctx.project.canonicalDomain, 'gsc')
    if (!conn) {
      return {
        status: CheckStatuses.skipped,
        code: 'google.auth.no-connection',
        summary: 'No GSC connection — run google.auth.connection first.',
        remediation: null,
      }
    }
    const granted = new Set(conn.scopes ?? [])
    const missing = REQUIRED_GSC_SCOPES.filter((scope) => !granted.has(scope))
    if (missing.length === 0) {
      return {
        status: CheckStatuses.ok,
        code: 'google.auth.scopes-ok',
        summary: 'All required GSC scopes are granted.',
        remediation: null,
        details: { granted: [...granted] },
      }
    }
    const gscMissing = missing.includes(GSC_SCOPE)
    const indexingOnlyMissing = !gscMissing && missing.includes(INDEXING_SCOPE) && missing.length === 1
    return {
      status: indexingOnlyMissing ? CheckStatuses.warn : CheckStatuses.fail,
      code: indexingOnlyMissing
        ? 'google.auth.indexing-scope-missing'
        : 'google.auth.required-scope-missing',
      summary: indexingOnlyMissing
        ? 'Indexing API scope is not granted — `canonry google request-indexing` will fail.'
        : `Missing required scopes: ${missing.join(', ')}.`,
      remediation: `Reconnect to grant missing scopes: \`canonry google connect ${ctx.project.name} --type gsc\`.`,
      details: { granted: [...granted], missing },
    }
  },
}

export const GOOGLE_AUTH_CHECKS: readonly CheckDefinition[] = [
  connectionCheck,
  propertyAccessCheck,
  redirectUriCheck,
  scopesCheck,
]

// Re-export for tests that need direct access to specific checks.
export const GOOGLE_AUTH_CHECK_BY_ID = Object.fromEntries(
  GOOGLE_AUTH_CHECKS.map((check) => [check.id, check]),
) as Record<string, CheckDefinition>
