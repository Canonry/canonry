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
    migrate(migrated)
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
