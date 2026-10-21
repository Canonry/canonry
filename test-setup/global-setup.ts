/**
 * Runs once per Vitest run, before any worker starts.
 *
 * Migrates an empty in-memory database with the real `migrate()` and gives
 * every project the replay script from `migrated-database.ts`. The script is
 * checked first: replayed into another empty database, it must reproduce the
 * migrated schema and rows, or the run stops here.
 */
import type { TestProject } from 'vitest/node'
import { createClient, migrate } from '../packages/db/src/index.js'
import { buildReplayScript, snapshotDatabase } from './migrated-database.js'

export default function setup(project: TestProject): void {
  const migrated = createClient(':memory:')
  const replayed = createClient(':memory:')
  try {
    try {
      migrate(migrated)
    } catch (error) {
      // A broken migration is reported by the tests that run it, not by
      // stopping every project here: they fall back to the real migrations.
      console.warn('test-setup/global-setup.ts: migrate() failed, so tests run the real migrations.', error)
      return
    }
    const script = buildReplayScript(migrated.$client)
    replayed.$client.exec(script)
    if (snapshotDatabase(replayed.$client) !== snapshotDatabase(migrated.$client)) {
      throw new Error(
        'test-setup/global-setup.ts: the replayed database differs from the migrated one. '
        + 'A migration probably uses a SQLite feature buildReplayScript() does not copy; '
        + 'extend test-setup/migrated-database.ts.',
      )
    }
    project.provide('canonryMigratedDatabase', script)
  } finally {
    migrated.$client.close()
    replayed.$client.close()
  }
}
