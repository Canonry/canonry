import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import {
  verifyConnection,
  verifyConnectionWithToken,
} from '@ainyc/canonry-integration-google-analytics'
import { refreshAccessToken } from '@ainyc/canonry-integration-google'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

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
    const message = err instanceof Error ? err.message : String(err)
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
    const message = err instanceof Error ? err.message : String(err)
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
    const message = err instanceof Error ? err.message : String(err)
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
