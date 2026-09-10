import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, migrate, MIGRATION_VERSIONS, users } from '../src/index.js'

test('v154 preserves ordinary keys, persists delegated identity, and revokes it with the account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-delegated-key-'))
  const db = createClient(path.join(dir, 'test.db'))
  const now = new Date().toISOString()
  try {
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 154))
    db.$client.prepare('INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('historical', 'Historical', 'old-hash', 'old', '["read"]', now)
    migrate(db)
    migrate(db)
    expect(db.select().from(apiKeys).get()).toMatchObject({ id: 'historical', delegatedUserId: null, scopes: ['read'] })
    db.insert(users).values({ id: 'analyst', name: 'Analyst', nameKey: 'analyst', passwordHash: 'unused', role: 'viewer', createdAt: now }).run()
    db.insert(apiKeys).values({ id: 'delegated', name: 'Session', keyHash: 'session-hash', keyPrefix: 'session', scopes: ['read', 'research.run'], delegatedUserId: 'analyst', createdAt: now }).run()
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'delegated')).get()?.delegatedUserId).toBe('analyst')
    db.delete(users).where(eq(users.id, 'analyst')).run()
    expect(db.select().from(apiKeys).all().map(key => key.id)).toEqual(['historical'])
  } finally {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
