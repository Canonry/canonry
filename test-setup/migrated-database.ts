/**
 * A migrated empty database, captured once per run and replayed into each
 * test's own empty database.
 *
 * Most tests open a fresh SQLite database and call `migrate(db)`, which runs
 * every migration from the first version, one transaction each (about 0.2 s).
 * The result is the same every time, so `global-setup.ts` migrates one
 * in-memory database per run and turns its schema and rows into a SQL script.
 * The shared setup file then answers `migrate(db)` on an empty database with
 * that script, in a single transaction.
 *
 * Every other call runs the real migrations: a custom or truncated version
 * list, a database that already holds any schema object (legacy fixtures,
 * downgrade and repair tests), or a connection inside a transaction. Each
 * test still owns its database; only the script is shared.
 */
import type Database from 'better-sqlite3'

declare module 'vitest' {
  export interface ProvidedContext {
    /** SQL from `buildReplayScript()`; absent when no global setup ran. */
    canonryMigratedDatabase?: string
  }
}

type Sqlite = Database.Database

interface SchemaObject {
  type: string
  name: string
  sql: string
}

interface TableInfo {
  name: string
  withoutRowid: boolean
  rowidAlias: boolean
  /** Columns that default to the current time, which a replay re-stamps. */
  clockColumns: Set<string>
}

const CLOCK_DEFAULT = /CURRENT_(?:TIMESTAMP|DATE|TIME)|'now'/i

/** Tables first, so indexes, views and triggers find what they reference. */
function schemaObjects(sqlite: Sqlite): SchemaObject[] {
  return sqlite.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid
  `).all() as SchemaObject[]
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Rows are read with safe integers, so a `number` is always a REAL. */
function sqlLiteral(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'NULL' : value > 0 ? '9e999' : '-9e999'
    return Number.isInteger(value) ? `${value}.0` : String(value)
  }
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`
  return `'${String(value).replaceAll("'", "''")}'`
}

function tableInfo(sqlite: Sqlite, name: string): TableInfo {
  const listed = sqlite.prepare('SELECT wr FROM pragma_table_list WHERE schema = \'main\' AND name = ?').get(name) as { wr: number } | undefined
  const withoutRowid = listed?.wr === 1
  const columns = sqlite.prepare('SELECT name, type, pk, dflt_value FROM pragma_table_xinfo(?)').all(name) as Array<{
    name: string
    type: string
    pk: number
    dflt_value: string | null
  }>
  const keys = columns.filter(column => column.pk > 0)
  return {
    name,
    withoutRowid,
    rowidAlias: !withoutRowid && keys.length === 1 && keys[0]!.type.toUpperCase() === 'INTEGER',
    clockColumns: new Set(columns.filter(column => column.dflt_value !== null && CLOCK_DEFAULT.test(column.dflt_value)).map(column => column.name)),
  }
}

function tables(sqlite: Sqlite): TableInfo[] {
  return schemaObjects(sqlite).filter(object => object.type === 'table').map(object => tableInfo(sqlite, object.name))
}

/** Every row in storage order, with a hidden rowid made explicit. */
function tableRows(sqlite: Sqlite, table: TableInfo): Array<Record<string, unknown>> {
  const name = quoteIdentifier(table.name)
  const select = table.withoutRowid
    ? `SELECT * FROM ${name}`
    : table.rowidAlias
      ? `SELECT * FROM ${name} ORDER BY rowid`
      : `SELECT rowid AS "rowid", * FROM ${name} ORDER BY rowid`
  return sqlite.prepare(select).safeIntegers(true).all() as Array<Record<string, unknown>>
}

function sequenceRows(sqlite: Sqlite): Array<{ name: string; seq: bigint }> {
  if (!sqlite.prepare('SELECT 1 FROM sqlite_master WHERE name = \'sqlite_sequence\'').get()) return []
  return sqlite.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as Array<{ name: string; seq: bigint }>
}

function withoutClockColumns(table: TableInfo, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !table.clockColumns.has(column)))
}

/**
 * SQL that recreates `sqlite`'s schema and rows in an empty database as one
 * transaction. Columns that default to the current time are left to their
 * default, so replayed rows carry the replay's time, as a fresh migration's
 * would. Foreign keys are checked at commit.
 */
export function buildReplayScript(sqlite: Sqlite): string {
  const lines = ['BEGIN;', 'PRAGMA defer_foreign_keys = ON;']
  for (const object of schemaObjects(sqlite)) lines.push(`${object.sql};`)
  for (const table of tables(sqlite)) {
    for (const row of tableRows(sqlite, table)) {
      const values = withoutClockColumns(table, row)
      const columns = Object.keys(values).map(quoteIdentifier).join(', ')
      lines.push(`INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES (${Object.values(values).map(sqlLiteral).join(', ')});`)
    }
  }
  for (const { name, seq } of sequenceRows(sqlite)) {
    lines.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral(name)}, ${seq});`)
  }
  for (const pragma of ['user_version', 'application_id']) {
    const value = sqlite.pragma(pragma, { simple: true }) as number
    if (value !== 0) lines.push(`PRAGMA ${pragma} = ${value};`)
  }
  lines.push('COMMIT;')
  return lines.join('\n')
}

/**
 * What a test can observe of a database: schema text, rows with their rowids
 * (clock columns aside), sequences and header pragmas. Two databases with
 * equal snapshots answer every query alike.
 */
export function snapshotDatabase(sqlite: Sqlite): string {
  const schema = sqlite.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()
  const rows = tables(sqlite).map(table => [table.name, tableRows(sqlite, table).map(row => withoutClockColumns(table, row))])
  const pragmas = ['user_version', 'application_id', 'foreign_keys'].map(pragma => [pragma, sqlite.pragma(pragma, { simple: true })])
  return JSON.stringify({ schema, rows, sequences: sequenceRows(sqlite), pragmas }, (_key, value: unknown) => typeof value === 'bigint' ? `${value}n` : value)
}

type MigrateModule = typeof import('../packages/db/src/migrate.js')

/** Fakes standing in for a client may lack a connection; those migrate for real. */
function isEmptyDatabase(sqlite: Sqlite | undefined): sqlite is Sqlite {
  return sqlite !== undefined
    && !sqlite.inTransaction
    && sqlite.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get() === undefined
}

/**
 * `migrate()` that replays `script` into an empty database when given the
 * default version list, and runs the real migrations otherwise.
 */
export function replayingMigrate(actual: MigrateModule, script: string): MigrateModule['migrate'] {
  // A full migration ends with foreign keys on: every version that turns them
  // off for a table rebuild turns them back on. The replay leaves them as the
  // connection had them, so it restores that end state explicitly.
  const endsWithForeignKeys = actual.MIGRATION_VERSIONS.some(version => version.disableForeignKeys)
  return (db, versions = actual.MIGRATION_VERSIONS) => {
    const sqlite: Sqlite | undefined = db.$client
    if (versions !== actual.MIGRATION_VERSIONS || !isEmptyDatabase(sqlite)) {
      actual.migrate(db, versions)
      return
    }
    try {
      sqlite.exec(script)
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
      throw error
    }
    if (endsWithForeignKeys) sqlite.pragma('foreign_keys = ON')
  }
}
