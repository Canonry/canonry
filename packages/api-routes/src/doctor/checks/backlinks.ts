import {
  BacklinkSources,
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  type BacklinkSource,
} from '@ainyc/canonry-contracts'
import { readCommonCrawlSourceState } from '../../backlinks-source-state.js'
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

      // Graded from stored data, by the rule the sources route reports: a
      // `ready` release sync plus a Common Crawl summary for this project (no
      // auth, it is a public dataset). The release sync is workspace-global
      // and writes every project's rows, so the project's
      // `autoExtractBacklinks` flag says nothing about whether data exists.
      const state = readCommonCrawlSourceState(ctx.db, ctx.project.id)
      const details = {
        commoncrawl: state.connected,
        commoncrawlReadyRelease: state.hasReadyRelease,
        commoncrawlHasData: state.hasProjectData,
      }

      if (!state.hasReadyRelease) {
        return {
          status: CheckStatuses.warn,
          code: 'backlinks.source.none',
          summary: `No backlink source is set up for ${ctx.project.name}: no Common Crawl release has been synced.`,
          remediation: 'Run `canonry backlinks sync` to download the newest Common Crawl release for the workspace.',
          details,
        }
      }

      // A project created after the last release sync: the source is ready but
      // nothing has been extracted for it yet.
      if (!state.hasProjectData) {
        return {
          status: CheckStatuses.warn,
          code: 'backlinks.source.none',
          summary: `A Common Crawl release is synced, but no backlinks have been extracted for ${ctx.project.name} yet.`,
          remediation: `Run \`canonry backlinks extract ${ctx.project.name}\` to extract this project's backlinks from the synced release.`,
          details,
        }
      }

      const connected: BacklinkSource[] = [BacklinkSources.commoncrawl]
      return {
        status: CheckStatuses.ok,
        code: 'backlinks.source.connected',
        summary: 'Common Crawl backlink source is set up.',
        remediation: null,
        details: { ...details, connected },
      }
    },
  },
]
