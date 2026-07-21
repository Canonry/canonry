import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { createClient, migrate } from '../src/index.js'
import * as schema from '../src/schema.js'

/**
 * `schema.ts` is the type-level contract; `migrate.ts` is what actually reaches
 * disk. Nothing ties them together, so a `CREATE TABLE` that omits a REFERENCES
 * clause type-checks, lints, and passes every behavioral test — the table just
 * silently loses referential integrity. The failure surfaces much later as
 * orphaned rows pointing at deleted parents.
 *
 * That drift is unusually expensive to repair: SQLite cannot add a foreign key
 * to an existing column, so a shipped migration has to be fixed with a full
 * table rebuild (see `rebuildBacklinkTableWithSource`). Catching it before the
 * migration ships keeps it a one-line change.
 *
 * This migrates a fresh database and compares every foreign key drizzle
 * declares against what SQLite actually created.
 */

interface SqliteForeignKey {
  from: string
  table: string
  to: string
  on_delete: string
}

function normalizeAction(action: string | undefined): string {
  // Drizzle spells it 'cascade'; SQLite reports 'CASCADE'. Absent means SQLite's
  // default, which it reports as 'NO ACTION'.
  return (action ?? 'no action').toUpperCase()
}

test('every foreign key declared in schema.ts exists in the migrated database', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-fk-parity-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  try {
    migrate(db)

    const problems: string[] = []
    let tablesChecked = 0
    let foreignKeysChecked = 0

    for (const exported of Object.values(schema)) {
      let config
      try {
        config = getTableConfig(exported as never)
      } catch {
        continue // not a table (enum, helper, type)
      }
      tablesChecked++

      const tableExists = db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(config.name)
      if (!tableExists) {
        problems.push(`${config.name}: declared in schema.ts but no migration creates it`)
        continue
      }

      const actual = db.$client
        .prepare(`PRAGMA foreign_key_list(${config.name})`)
        .all() as SqliteForeignKey[]
      const actualByColumn = new Map(actual.map((fk) => [fk.from, fk]))

      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference()
        const column = reference.columns[0]!.name
        const referencedTable = getTableConfig(reference.foreignTable as never).name
        foreignKeysChecked++

        const found = actualByColumn.get(column)
        if (!found) {
          problems.push(
            `${config.name}.${column}: schema.ts declares REFERENCES ${referencedTable}, but the migration created the column with no foreign key`,
          )
          continue
        }
        if (found.table !== referencedTable) {
          problems.push(
            `${config.name}.${column}: schema.ts references ${referencedTable}, migration references ${found.table}`,
          )
        }
        const expectedOnDelete = normalizeAction(foreignKey.onDelete)
        const actualOnDelete = normalizeAction(found.on_delete)
        if (expectedOnDelete !== actualOnDelete) {
          problems.push(
            `${config.name}.${column}: schema.ts says ON DELETE ${expectedOnDelete}, migration says ON DELETE ${actualOnDelete}`,
          )
        }
      }
    }

    expect(tablesChecked).toBeGreaterThan(50)
    expect(foreignKeysChecked).toBeGreaterThan(90)
    expect(problems, `schema.ts / migrate.ts foreign-key drift:\n  ${problems.join('\n  ')}`).toEqual([])
  } finally {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
