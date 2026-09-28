import type { DatabaseClient } from '../src/index.js'

type LegacyValue = string | number | boolean | null | Record<string, unknown> | unknown[]

/**
 * Insert a row naming only the physical columns given, snake_case, exactly as
 * written.
 *
 * Upgrade tests seed a database migrated to an OLDER version. Drizzle's insert
 * names every column the CURRENT schema declares, so seeding through it fails
 * the moment a later migration adds a column to that table (`table projects
 * has no column named ...`). Naming the historical columns keeps each test
 * describing the database it claims to upgrade.
 */
export function insertLegacyRow(db: DatabaseClient, table: string, row: Record<string, LegacyValue>): void {
  const columns = Object.keys(row)
  const values = columns.map((column) => {
    const value = row[column]
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value !== null && typeof value === 'object') return JSON.stringify(value)
    return value
  })
  db.$client
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...values)
}

/** A project as every schema since v109 can hold it: the NOT NULL columns without a default. */
export function insertLegacyProject(
  db: DatabaseClient,
  project: { id: string; name?: string; displayName?: string; canonicalDomain?: string; createdAt: string },
): void {
  insertLegacyRow(db, 'projects', {
    id: project.id,
    name: project.name ?? project.id,
    display_name: project.displayName ?? project.id,
    canonical_domain: project.canonicalDomain ?? 'example.com',
    country: 'US',
    language: 'en',
    created_at: project.createdAt,
    updated_at: project.createdAt,
  })
}
