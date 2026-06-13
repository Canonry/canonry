import { eq } from 'drizzle-orm'
import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { adsConnections } from '@ainyc/canonry-db'
import type { CheckDefinition } from '../types.js'

const RECENT_SYNC_WARN_DAYS = 7
const RECENT_SYNC_FAIL_DAYS = 30

// Both checks are presence/freshness only — no network calls. The key is
// validated against the upstream ad account at connect time; a doctor-side
// live probe would burn rate limit on every doctor run for little signal.
const adsConnectionCheck: CheckDefinition = {
  id: 'ads.auth.connection',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'OpenAI ads connection',
  run: (ctx) => {
    if (!ctx.project) {
      return {
        status: CheckStatuses.skipped,
        code: 'ads.auth.no-project',
        summary: 'Project context required.',
        remediation: null,
      }
    }
    const row = ctx.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, ctx.project.id)).get()
    if (!row) {
      // Most projects never connect ads — stay invisible until they do.
      return {
        status: CheckStatuses.skipped,
        code: 'ads.auth.not-connected',
        summary: 'No OpenAI ads connection for this project.',
        remediation: null,
      }
    }
    if (!ctx.adsCredentialStore) {
      return {
        status: CheckStatuses.skipped,
        code: 'ads.auth.store-unavailable',
        summary: 'No ads credential store configured for this deployment.',
        remediation: null,
      }
    }
    const cfg = ctx.adsCredentialStore.getConnection(ctx.project.name)
    if (!cfg?.apiKey) {
      return {
        status: CheckStatuses.fail,
        code: 'ads.auth.missing-key',
        summary: 'An ads connection row exists but no SDK key is stored in the local config.',
        remediation: `Re-run \`canonry ads connect ${ctx.project.name} --api-key <sdk-key>\` to restore the credential.`,
        details: { adAccountId: row.adAccountId },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'ads.auth.ok',
      summary: `Connected to ad account ${row.displayName ?? row.adAccountId}.`,
      remediation: null,
      details: { adAccountId: row.adAccountId },
    }
  },
}

const adsRecentSyncCheck: CheckDefinition = {
  id: 'ads.data.recent-sync',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'OpenAI ads recent sync',
  run: (ctx) => {
    if (!ctx.project) {
      return {
        status: CheckStatuses.skipped,
        code: 'ads.data.no-project',
        summary: 'Project context required.',
        remediation: null,
      }
    }
    const row = ctx.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, ctx.project.id)).get()
    if (!row) {
      return {
        status: CheckStatuses.skipped,
        code: 'ads.data.not-connected',
        summary: 'No OpenAI ads connection for this project.',
        remediation: null,
      }
    }
    if (!row.lastSyncedAt) {
      return {
        status: CheckStatuses.warn,
        code: 'ads.data.never-synced',
        summary: 'The connected ad account has never been synced.',
        remediation: `Run \`canonry ads sync ${ctx.project.name}\` (and schedule it: \`canonry schedule set ${ctx.project.name} --kind ads-sync --preset daily\`).`,
      }
    }
    const syncedAtMs = new Date(row.lastSyncedAt).getTime()
    const ageDays = (Date.now() - syncedAtMs) / (1000 * 60 * 60 * 24)
    const details = { lastSyncedAt: row.lastSyncedAt, ageDays: Math.round(ageDays) }
    if (ageDays > RECENT_SYNC_FAIL_DAYS) {
      return {
        status: CheckStatuses.fail,
        code: 'ads.data.stale',
        summary: `Last ads sync was ${Math.round(ageDays)} days ago (> ${RECENT_SYNC_FAIL_DAYS}d).`,
        remediation: `Run \`canonry ads sync ${ctx.project.name}\` and check the ads-sync schedule.`,
        details,
      }
    }
    if (ageDays > RECENT_SYNC_WARN_DAYS) {
      return {
        status: CheckStatuses.warn,
        code: 'ads.data.aging',
        summary: `Last ads sync was ${Math.round(ageDays)} days ago (> ${RECENT_SYNC_WARN_DAYS}d).`,
        remediation: `Schedule daily syncs: \`canonry schedule set ${ctx.project.name} --kind ads-sync --preset daily\`.`,
        details,
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'ads.data.ok',
      summary: `Last ads sync ${Math.round(ageDays)} day(s) ago.`,
      remediation: null,
      details,
    }
  },
}

export const ADS_CHECKS: readonly CheckDefinition[] = [adsConnectionCheck, adsRecentSyncCheck]
