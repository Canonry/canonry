import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import { verifyConnection } from '@ainyc/canonry-integration-google-analytics'
import type { CheckDefinition } from '../types.js'

const ga4ConnectionCheck: CheckDefinition = {
  id: 'ga.auth.connection',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'GA4 service account connection',
  run: async (ctx) => {
    if (!ctx.project) {
      return {
        status: CheckStatuses.skipped,
        code: 'ga.auth.no-project',
        summary: 'Project context required.',
        remediation: null,
      }
    }
    const store = ctx.ga4CredentialStore
    if (!store) {
      return {
        status: CheckStatuses.skipped,
        code: 'ga.auth.store-unavailable',
        summary: 'GA4 credential store is not configured for this deployment.',
        remediation: null,
      }
    }
    const conn = store.getConnection(ctx.project.name)
    if (!conn) {
      return {
        status: CheckStatuses.warn,
        code: 'ga.auth.no-connection',
        summary: 'No GA4 connection configured for this project.',
        remediation:
          `Run \`canonry google connect ${ctx.project.name} --type ga4\` to authorize, ` +
          'or set up a service account in ~/.canonry/config.yaml under `ga4.connections`.',
      }
    }
    if (!conn.propertyId) {
      return {
        status: CheckStatuses.fail,
        code: 'ga.auth.no-property-selected',
        summary: 'GA4 connection has no property ID set.',
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
        details: { propertyId: conn.propertyId, error: message },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'ga.auth.verified',
      summary: `GA4 property ${conn.propertyId} is reachable with the configured service account.`,
      remediation: null,
      details: { propertyId: conn.propertyId, clientEmail: conn.clientEmail },
    }
  },
}

export const GA_AUTH_CHECKS: readonly CheckDefinition[] = [ga4ConnectionCheck]
