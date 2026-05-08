import fs from 'node:fs'
import { createClient, projects, queries as queriesTable } from '@ainyc/canonry-db'
import { loadConfigRaw, configExists } from './config.js'

/**
 * Lightweight snapshot of the user's setup at CLI command time. Lets the
 * receiving end cohort metrics by "configured vs not configured" so we can
 * see where misconfiguration causes friction (e.g. % of users running
 * `canonry run` with no providers configured).
 *
 * Field naming uses snake_case to match the receiving event schema; the
 * receiving end's `event.properties.setup_state` row does not transform
 * keys.
 */
export interface SetupState {
  provider_count: number
  has_keywords: boolean
  project_count: number
  is_first_run: boolean
}

/**
 * Build a `SetupState` snapshot. Reads `~/.canonry/config.yaml` for provider
 * count + first-run state; opens the SQLite DB read-only for project and
 * keyword counts. Failures degrade gracefully — a missing config or
 * uninitialized DB returns the snapshot with the available fields filled in
 * and the rest at safe defaults (`0`, `false`, `is_first_run: true`).
 *
 * Returns `undefined` only when there is no config at all (pre-init), so
 * callers can omit the `setup_state` field rather than emit zeros that
 * misrepresent a brand-new install.
 */
export function buildSetupState(): SetupState | undefined {
  if (!configExists()) return undefined

  let provider_count = 0
  let has_keywords = false
  let project_count = 0
  let is_first_run = true

  let dbPath: string | undefined
  try {
    const raw = loadConfigRaw()
    if (raw) {
      is_first_run = !raw.anonymousId
      if (raw.providers) {
        provider_count = Object.values(raw.providers).filter(
          p => Boolean(p?.apiKey) || Boolean(p?.baseUrl),
        ).length
      }
      if (typeof raw.database === 'string' && raw.database.length > 0) {
        dbPath = raw.database
      }
    }
  } catch {
    // Config unparseable — fall through with defaults.
  }

  if (dbPath && fs.existsSync(dbPath)) {
    try {
      const db = createClient(dbPath)
      project_count = db.select({ id: projects.id }).from(projects).all().length
      const firstQuery = db
        .select({ id: queriesTable.id })
        .from(queriesTable)
        .limit(1)
        .all()
      has_keywords = firstQuery.length > 0
    } catch {
      // DB not migrated yet or schema mismatch — leave the counts at zero.
    }
  }

  return { provider_count, has_keywords, project_count, is_first_run }
}
