import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import { getSites } from '@ainyc/canonry-integration-bing'
import type { CheckDefinition, CheckOutput } from '../types.js'

export const BING_AUTH_CHECKS: readonly CheckDefinition[] = [
  {
    id: 'bing.auth.connection',
    category: CheckCategories.auth,
    scope: CheckScopes.project,
    title: 'Bing WMT connection',
    run: async (ctx) => {
      if (!ctx.project) {
        return {
          status: CheckStatuses.skipped,
          code: 'bing.auth.no-project',
          summary: 'Project context required.',
          remediation: null,
        }
      }

      const store = ctx.bingConnectionStore
      if (!store) {
        return {
          status: CheckStatuses.skipped,
          code: 'bing.auth.store-unavailable',
          summary: 'Bing connection store is not configured for this deployment.',
          remediation: null,
        }
      }

      const conn = store.getConnection(ctx.project.canonicalDomain)
      if (!conn) {
        return {
          status: CheckStatuses.fail,
          code: 'bing.auth.no-connection',
          summary: `No Bing connection for ${ctx.project.canonicalDomain}.`,
          remediation: `Run \`canonry bing connect ${ctx.project.name} --api-key <key>\` to authorize.`,
        }
      }

      if (!conn.apiKey) {
        return {
          status: CheckStatuses.fail,
          code: 'bing.auth.no-api-key',
          summary: 'Bing connection exists but has no API key stored.',
          remediation: `Run \`canonry bing connect ${ctx.project.name} --api-key <key>\` to re-authorize.`,
        }
      }

      try {
        await getSites(conn.apiKey)
        return {
          status: CheckStatuses.ok,
          code: 'bing.auth.connected',
          summary: 'Bing API key is valid and can list sites.',
          remediation: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          status: CheckStatuses.fail,
          code: 'bing.auth.verification-failed',
          summary: 'Bing API key verification failed.',
          remediation: 'Verify your Bing API key is correct and active in Bing Webmaster Tools.',
          details: { error: message },
        }
      }
    },
  },
  {
    id: 'bing.auth.site-access',
    category: CheckCategories.auth,
    scope: CheckScopes.project,
    title: 'Bing site access',
    run: async (ctx) => {
      if (!ctx.project) {
        return {
          status: CheckStatuses.skipped,
          code: 'bing.auth.no-project',
          summary: 'Project context required.',
          remediation: null,
        }
      }

      const store = ctx.bingConnectionStore
      if (!store) {
        return {
          status: CheckStatuses.skipped,
          code: 'bing.auth.store-unavailable',
          summary: 'Bing connection store is not configured.',
          remediation: null,
        }
      }

      const conn = store.getConnection(ctx.project.canonicalDomain)
      if (!conn || !conn.apiKey) {
        return {
          status: CheckStatuses.skipped,
          code: 'bing.auth.no-connection',
          summary: 'Skipped — no Bing connection (see bing.auth.connection).',
          remediation: null,
        }
      }

      if (!conn.siteUrl) {
        return {
          status: CheckStatuses.fail,
          code: 'bing.auth.no-site-selected',
          summary: 'Bing connection has no site URL selected.',
          remediation: `Run \`canonry bing sites ${ctx.project.name}\` to see available sites, then \`canonry bing set-site ${ctx.project.name} <url>\`.`,
        }
      }

      try {
        const sites = await getSites(conn.apiKey)
        const match = sites.find((s) => s.Url === conn.siteUrl)

        if (!match) {
          return {
            status: CheckStatuses.fail,
            code: 'bing.auth.site-not-found',
            summary: `Configured site "${conn.siteUrl}" is not in the authorized account's site list.`,
            remediation: `Add and verify "${conn.siteUrl}" in Bing Webmaster Tools, or pick an existing site using \`canonry bing set-site ${ctx.project.name}\`.`,
            details: {
              configuredSite: conn.siteUrl,
              availableSites: sites.map((s) => s.Url),
            },
          }
        }

        if (!match.Verified) {
          return {
            status: CheckStatuses.fail,
            code: 'bing.auth.site-not-verified',
            summary: `Site "${conn.siteUrl}" is registered but not verified in Bing.`,
            remediation: 'Complete site verification in Bing Webmaster Tools (DNS, HTML file, or Meta tag).',
            details: { siteUrl: conn.siteUrl },
          }
        }

        return {
          status: CheckStatuses.ok,
          code: 'bing.auth.site-verified',
          summary: `Site "${conn.siteUrl}" is verified and accessible.`,
          remediation: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          status: CheckStatuses.fail,
          code: 'bing.auth.site-check-failed',
          summary: 'Failed to verify Bing site access.',
          remediation: 'Check Bing Webmaster Tools availability.',
          details: { error: message },
        }
      }
    },
  },
]
