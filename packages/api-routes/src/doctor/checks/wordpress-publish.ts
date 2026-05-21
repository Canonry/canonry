import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import { verifyWordpressConnection, WordpressApiError } from '@ainyc/canonry-integration-wordpress'
import type { CheckDefinition } from '../types.js'

export const WORDPRESS_PUBLISH_CHECKS: readonly CheckDefinition[] = [
  {
    id: 'wordpress.publish.connection',
    category: CheckCategories.auth,
    scope: CheckScopes.project,
    title: 'WordPress publishing connection',
    run: async (ctx) => {
      if (!ctx.project) {
        return {
          status: CheckStatuses.skipped,
          code: 'wordpress.publish.no-project',
          summary: 'Project context required.',
          remediation: null,
        }
      }

      const store = ctx.wordpressConnectionStore
      if (!store) {
        return {
          status: CheckStatuses.skipped,
          code: 'wordpress.publish.store-unavailable',
          summary: 'WordPress connection store is not configured for this deployment.',
          remediation: null,
        }
      }

      const connection = store.getConnection(ctx.project.name)
      if (!connection) {
        // The publisher is an optional integration. A project that does not
        // push content to WordPress legitimately has no connection, so this
        // is `skipped` rather than `fail`.
        return {
          status: CheckStatuses.skipped,
          code: 'wordpress.publish.not-configured',
          summary: `No WordPress publishing connection configured for ${ctx.project.name}.`,
          remediation: `If this project publishes to WordPress, run \`canonry wordpress connect ${ctx.project.name} --url <url> --user <user>\`.`,
        }
      }

      try {
        const status = await verifyWordpressConnection(connection)
        return {
          status: CheckStatuses.ok,
          code: 'wordpress.publish.connected',
          summary: `WordPress publishing connection verified; wp/v2 REST API reachable at ${status.url}.`,
          remediation: null,
          details: {
            url: status.url,
            wordpressVersion: status.version,
            pageCount: status.pageCount,
          },
        }
      } catch (err) {
        if (err instanceof WordpressApiError && err.code === 'AUTH_INVALID') {
          return {
            status: CheckStatuses.fail,
            code: 'wordpress.publish.unauthorized',
            summary: 'WordPress rejected the stored application password.',
            remediation: `Regenerate the Application Password in wp-admin (Users → Profile → Application Passwords), then reconnect with \`canonry wordpress connect ${ctx.project.name} --url <url> --user <user>\`.`,
            details: { error: err.message },
          }
        }
        const message = err instanceof Error ? err.message : String(err)
        return {
          status: CheckStatuses.fail,
          code: 'wordpress.publish.verification-failed',
          summary: 'WordPress publishing connection could not be verified.',
          remediation: 'Confirm the site URL is correct and the WordPress REST API is reachable.',
          details: { error: message },
        }
      }
    },
  },
]
