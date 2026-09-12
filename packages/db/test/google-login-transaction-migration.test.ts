import { sql } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const databases: Array<ReturnType<typeof createClient>> = []
afterEach(() => { for (const database of databases.splice(0)) database.$client.close() })

test('v158 adds nullable server-side return targets without disturbing existing Google login transactions', () => {
  const db = createClient(':memory:')
  databases.push(db)
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 157))
  db.run(sql.raw("INSERT INTO google_login_transactions (state_hash, expires_at) VALUES ('existing', '2026-01-01T00:00:00.000Z')"))

  migrate(db)

  expect(db.all(sql.raw('PRAGMA table_info(google_login_transactions)'))).toContainEqual(expect.objectContaining({ name: 'return_to', notnull: 0 }))
  expect(db.all(sql.raw("SELECT return_to FROM google_login_transactions WHERE state_hash = 'existing'"))).toEqual([{ return_to: null }])
})
