import { test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { createClient, migrate } from '../src/index.js'
import * as schema from '../src/schema.js'

test('every schema.ts table and column is created by the migrations', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-parity-'))
  const dbPath = path.join(tmpDir, 'parity.db')

  try {
    const drizzleDb = createClient(dbPath)
    migrate(drizzleDb)

    const raw = new Database(dbPath, { readonly: true })

    const schemaTables: SQLiteTable[] = []
    for (const value of Object.values(schema)) {
      if (is(value, SQLiteTable)) {
        schemaTables.push(value)
      }
    }

    expect(schemaTables.length, 'schema.ts should declare at least one sqliteTable').toBeGreaterThan(0)

    const missingTables: string[] = []
    const missingColumns: Array<{ table: string; column: string }> = []

    for (const table of schemaTables) {
      const tableName = getTableName(table)
      const rows = raw
        .prepare(`PRAGMA table_info("${tableName}")`)
        .all() as Array<{ name: string }>

      if (rows.length === 0) {
        missingTables.push(tableName)
        continue
      }

      const dbColumnNames = new Set(rows.map((r) => r.name))
      const cols = getTableColumns(table)
      for (const col of Object.values(cols)) {
        if (!dbColumnNames.has(col.name)) {
          missingColumns.push({ table: tableName, column: col.name })
        }
      }
    }

    raw.close()

    expect(
      missingTables,
      `Tables declared in schema.ts but not created by MIGRATIONS (missing CREATE TABLE): ${JSON.stringify(missingTables)}`,
    ).toEqual([])
    expect(
      missingColumns,
      `Columns declared in schema.ts but not present after MIGRATIONS (missing ALTER TABLE ADD COLUMN): ${JSON.stringify(missingColumns)}`,
    ).toEqual([])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
