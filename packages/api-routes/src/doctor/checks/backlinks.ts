import { eq } from 'drizzle-orm'
import {
  CcReleaseSyncStatuses,
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import { ccReleaseSyncs, projects } from '@ainyc/canonry-db'
import type { CheckDefinition, CheckOutput } from '../types.js'

function skippedNoProject(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'backlinks.source.no-project',
    summary: 'Project context required.',
  }
}

export const BACKLINKS_CHECKS: readonly CheckDefinition[] = [
  {
    id: 'backlinks.source.connected',
    category: CheckCategories.integrations,
    scope: CheckScopes.project,
    title: 'Backlinks source connected',
    run: (ctx) => {
      if (!ctx.project) return skippedNoProject()

      // Common Crawl is "available" when auto-extract is enabled AND a release
      // sync has reached `ready` (no auth — it's a public dataset).
      const projectRow = ctx.db
        .select({ autoExtract: projects.autoExtractBacklinks })
        .from(projects)
        .where(eq(projects.id, ctx.project.id))
        .get()
      const readySync = ctx.db
        .select({ id: ccReleaseSyncs.id })
        .from(ccReleaseSyncs)
        .where(eq(ccReleaseSyncs.status, CcReleaseSyncStatuses.ready))
        .limit(1)
        .get()
      const ccConnected = projectRow?.autoExtract === true && !!readySync

      // Bing is available when a Bing Webmaster connection exists for the domain.
      const bingConnected = !!ctx.bingConnectionStore?.getConnection(ctx.project.canonicalDomain)

      const connected: string[] = []
      if (ccConnected) connected.push('commoncrawl')
      if (bingConnected) connected.push('bing-webmaster')

      if (connected.length === 0) {
        return {
          status: CheckStatuses.warn,
          code: 'backlinks.source.none',
          summary: `No backlink source is set up for ${ctx.project.name}.`,
          remediation:
            `Enable Common Crawl (set autoExtractBacklinks on the project + run \`canonry backlinks sync\`) ` +
            `or connect Bing Webmaster (\`canonry bing connect ${ctx.project.name} --api-key <key>\` then ` +
            `\`canonry backlinks bing-sync ${ctx.project.name}\`).`,
          details: { commoncrawl: ccConnected, bingWebmaster: bingConnected },
        }
      }

      return {
        status: CheckStatuses.ok,
        code: 'backlinks.source.connected',
        summary: `${connected.length} backlink source${connected.length === 1 ? '' : 's'} set up: ${connected.join(', ')}.`,
        remediation: null,
        details: { commoncrawl: ccConnected, bingWebmaster: bingConnected, connected },
      }
    },
  },
]
