import fs from 'node:fs'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import type { CheckDefinition } from '../types.js'

/**
 * Detects the case where the SQLite DB or `~/.canonry/config.yaml` was
 * deleted out from under the running `canonry serve` daemon. SQLite holds
 * the file inode open through `unlink`, so the daemon would otherwise keep
 * serving cached data from an orphaned file and the operator would never
 * see their wipe take effect — they'd `rm ~/.canonry/data.db`, refresh
 * the dashboard, and the same projects would still be there.
 *
 * Pairs with the Fastify pre-request hook in `runtime-state-guard.ts`
 * which fails all non-doctor / non-health requests with a 503
 * `RUNTIME_STATE_MISSING` while these checks return `fail`. The hook
 * surfaces it as an HTTP error; the doctor check surfaces it in
 * `canonry doctor`.
 *
 * Both checks `skipped` when `runtimeStatePaths` isn't wired (cloud
 * deployments use a managed Postgres, no local file paths).
 */
const dbFilePresentCheck: CheckDefinition = {
  id: 'db.file.present',
  category: CheckCategories.database,
  scope: CheckScopes.global,
  title: 'Database file present',
  run: (ctx) => {
    const path = ctx.runtimeStatePaths?.databasePath
    if (!path) {
      return {
        status: CheckStatuses.skipped,
        code: 'db.file.path-not-wired',
        summary: 'No database file path configured for this deployment (cloud DB).',
        remediation: null,
      }
    }
    if (!fs.existsSync(path)) {
      return {
        status: CheckStatuses.fail,
        code: 'db.file.missing',
        summary: `Database file at \`${path}\` has been deleted while the daemon is running.`,
        remediation:
          'Restart `canonry serve` so a fresh database is created and migrations re-run. ' +
          'Until you do, the daemon will keep serving stale data from a deleted-but-open file ' +
          'handle and writes will be lost.',
        details: { path },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'db.file.present',
      summary: `Database file present at \`${path}\`.`,
      remediation: null,
      details: { path },
    }
  },
}

const configFilePresentCheck: CheckDefinition = {
  id: 'config.file.present',
  category: CheckCategories.config,
  scope: CheckScopes.global,
  title: 'Config file present',
  run: (ctx) => {
    const path = ctx.runtimeStatePaths?.configPath
    if (!path) {
      return {
        status: CheckStatuses.skipped,
        code: 'config.file.path-not-wired',
        summary: 'No config file path configured for this deployment.',
        remediation: null,
      }
    }
    if (!fs.existsSync(path)) {
      return {
        status: CheckStatuses.fail,
        code: 'config.file.missing',
        summary: `Config file at \`${path}\` has been deleted while the daemon is running.`,
        remediation:
          'Restart `canonry serve` after the file is restored (provider keys, OAuth tokens, ' +
          'and integration credentials live in this file; the in-memory copy is read-only ' +
          'until restart).',
        details: { path },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'config.file.present',
      summary: `Config file present at \`${path}\`.`,
      remediation: null,
      details: { path },
    }
  },
}

export const RUNTIME_STATE_CHECKS: readonly CheckDefinition[] = [
  dbFilePresentCheck,
  configFilePresentCheck,
]
