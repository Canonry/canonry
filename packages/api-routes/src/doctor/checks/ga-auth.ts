import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  describeError,
  describeFetchError,
  isFetchTransportError,
} from '@ainyc/canonry-contracts'
import {
  GA4_DATA_API_BASE,
  verifyConnection,
  verifyConnectionWithToken,
} from '@ainyc/canonry-integration-google-analytics'
import { GOOGLE_TOKEN_URL, refreshAccessToken } from '@ainyc/canonry-integration-google'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

/**
 * A GA4 call that got no answer tested neither the credential nor property
 * access, so it must not read as a rejection (or supersede the sync failure
 * that names DNS). `requestUrl` names the host when the error does not.
 */
function unreachable(
  step: { code: 'ga.auth.refresh-unreachable' | 'ga.auth.verify-unreachable'; action: string; requestUrl?: string },
  err: unknown,
  details: Record<string, unknown>,
): CheckOutput {
  const error = describeFetchError(err, step.requestUrl)
  return {
    status: CheckStatuses.fail,
    code: step.code,
    summary: `Could not reach Google to ${step.action}: ${error}`,
    remediation: 'Check that this host can resolve and connect to Google (DNS filtering, firewall, or proxy), then re-run. The credential was not tested.',
    details: { ...details, error },
  }
}

async function checkServiceAccount(conn: NonNullable<ReturnType<NonNullable<DoctorContext['ga4CredentialStore']>['getConnection']>>): Promise<CheckOutput> {
  if (!conn.propertyId) {
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.no-property-selected',
      summary: 'GA4 service account record has no property ID set.',
      remediation: 'Set a propertyId in the GA4 credential record (config.yaml `ga4.connections[].propertyId`).',
    }
  }
  if (!conn.clientEmail || !conn.privateKey) {
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.service-account-incomplete',
      summary: 'GA4 service account is missing clientEmail or privateKey.',
      remediation: 'Provide a complete service account JSON key (clientEmail + privateKey) in config.yaml.',
      details: {
        hasClientEmail: Boolean(conn.clientEmail),
        hasPrivateKey: Boolean(conn.privateKey),
      },
    }
  }
  try {
    await verifyConnection(conn.clientEmail, conn.privateKey, conn.propertyId)
  } catch (err) {
    // The token exchange and the report call reach different hosts; the
    // error names the one that failed when it carries a hostname.
    if (isFetchTransportError(err)) {
      return unreachable({ code: 'ga.auth.verify-unreachable', action: 'verify the GA4 service account' }, err, { propertyId: conn.propertyId, authMethod: 'service-account' })
    }
    const message = describeError(err)
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.verify-failed',
      summary: 'GA4 service account could not authenticate against the configured property.',
      remediation:
        `Verify the service account has Viewer access on property ${conn.propertyId}, ` +
        'and that the private key in config.yaml is the active key for the service account.',
      details: { propertyId: conn.propertyId, error: message, authMethod: 'service-account' },
    }
  }
  return {
    status: CheckStatuses.ok,
    code: 'ga.auth.verified',
    summary: `GA4 property ${conn.propertyId} is reachable with the configured service account.`,
    remediation: null,
    details: { propertyId: conn.propertyId, clientEmail: conn.clientEmail, authMethod: 'service-account' },
  }
}

async function checkOAuthConnection(ctx: DoctorContext, projectName: string, conn: NonNullable<ReturnType<NonNullable<DoctorContext['googleConnectionStore']>['getConnection']>>): Promise<CheckOutput> {
  if (!conn.propertyId) {
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.no-property-selected',
      summary: 'GA4 OAuth connection has no property selected.',
      remediation: `Run \`canonry google connect ${projectName} --type ga4\` to select a property.`,
    }
  }
  if (!conn.refreshToken) {
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.no-refresh-token',
      summary: 'GA4 OAuth connection has no refresh token stored.',
      remediation: `Run \`canonry google connect ${projectName} --type ga4\` to re-authorize and capture a refresh token.`,
      details: { propertyId: conn.propertyId },
    }
  }
  const auth = ctx.getGoogleAuthConfig?.() ?? {}
  if (!auth.clientId || !auth.clientSecret) {
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.oauth-not-configured',
      summary: 'GA4 OAuth connection exists but Google OAuth client ID/secret is missing.',
      remediation: 'Set `google.clientId` and `google.clientSecret` in ~/.canonry/config.yaml.',
    }
  }
  let accessToken: string
  try {
    const tokens = await refreshAccessToken(auth.clientId, auth.clientSecret, conn.refreshToken)
    accessToken = tokens.access_token
  } catch (err) {
    if (isFetchTransportError(err)) {
      return unreachable({ code: 'ga.auth.refresh-unreachable', action: 'refresh the GA4 token', requestUrl: GOOGLE_TOKEN_URL }, err, { propertyId: conn.propertyId, authMethod: 'oauth' })
    }
    const message = describeError(err)
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.refresh-failed',
      summary: 'GA4 OAuth refresh token rejected by Google.',
      remediation: `Run \`canonry google connect ${projectName} --type ga4\` to re-authorize.`,
      details: { propertyId: conn.propertyId, error: message, authMethod: 'oauth' },
    }
  }
  try {
    await verifyConnectionWithToken(accessToken, conn.propertyId)
  } catch (err) {
    if (isFetchTransportError(err)) {
      return unreachable({ code: 'ga.auth.verify-unreachable', action: 'verify GA4 property access', requestUrl: GA4_DATA_API_BASE }, err, { propertyId: conn.propertyId, authMethod: 'oauth' })
    }
    const message = describeError(err)
    return {
      status: CheckStatuses.fail,
      code: 'ga.auth.verify-failed',
      summary: 'GA4 OAuth token cannot reach the configured property.',
      remediation:
        `Verify the authorized Google account has access to property ${conn.propertyId}, ` +
        `or run \`canonry google connect ${projectName} --type ga4\` to re-authorize.`,
      details: { propertyId: conn.propertyId, error: message, authMethod: 'oauth' },
    }
  }
  return {
    status: CheckStatuses.ok,
    code: 'ga.auth.verified',
    summary: `GA4 property ${conn.propertyId} is reachable via OAuth.`,
    remediation: null,
    details: { propertyId: conn.propertyId, authMethod: 'oauth' },
  }
}

const ga4ConnectionCheck: CheckDefinition = {
  id: 'ga.auth.connection',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GA4 connection',
  run: async (ctx) => {
    if (!ctx.project) {
      return {
        status: CheckStatuses.skipped,
        code: 'ga.auth.no-project',
        summary: 'Project context required.',
        remediation: null,
      }
    }
    const saStore = ctx.ga4CredentialStore
    const oauthStore = ctx.googleConnectionStore
    if (!saStore && !oauthStore) {
      return {
        status: CheckStatuses.skipped,
        code: 'ga.auth.store-unavailable',
        summary: 'No GA4 credential store configured for this deployment.',
        remediation: null,
      }
    }

    const saConn = saStore?.getConnection(ctx.project.name)
    if (saConn) return checkServiceAccount(saConn)

    const oauthConn = oauthStore?.getConnection(ctx.project.canonicalDomain, 'ga4')
    if (oauthConn) return checkOAuthConnection(ctx, ctx.project.name, oauthConn)

    return {
      status: CheckStatuses.warn,
      code: 'ga.auth.no-connection',
      summary: 'No GA4 connection configured for this project.',
      remediation:
        `Run \`canonry google connect ${ctx.project.name} --type ga4\` to authorize via OAuth, ` +
        'or set up a service account in ~/.canonry/config.yaml under `ga4.connections`.',
    }
  },
}

export const GA_AUTH_CHECKS: readonly CheckDefinition[] = [ga4ConnectionCheck]
