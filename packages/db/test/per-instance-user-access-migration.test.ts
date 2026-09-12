import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  oauthAuthorizationCodes,
  oauthTokens,
  userSessions,
  users,
} from '../src/index.js'

test('v156 upgrades a latest-main database without losing users, audit attribution, or credential children', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-access-migration-'))
  const db = createClient(path.join(dir, 'test.db'))
  const now = '2026-09-11T00:00:00.000Z'
  try {
    // v155 is the latest migration shipped on main. The feature migrations
    // must upgrade that exact database shape rather than only an older fixture.
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 155))
    db.$client.prepare(`INSERT INTO users (id, name, name_key, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('legacy-user', 'Legacy User', 'legacy-user', 'legacy-password-hash', 'viewer', now)
    db.$client.prepare(`INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)`)
      .run('legacy-session', 'legacy-user', now, '2026-09-12T00:00:00.000Z')
    db.$client.prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
      VALUES (?, ?, ?, ?)`)
      .run('client', 'Client', '[]', now)
    db.$client.prepare(`INSERT INTO oauth_authorization_codes
      (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-code', 'client', 'legacy-user', 'https://client.example/callback', 'challenge', '2026-09-12T00:00:00.000Z', now)
    db.$client.prepare(`INSERT INTO oauth_tokens
      (token_hash, kind, client_id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('legacy-token', 'access', 'client', 'legacy-user', '2026-09-12T00:00:00.000Z', now)
    db.$client.prepare(`INSERT INTO api_keys
      (id, name, key_hash, key_prefix, scopes, delegated_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-delegated', 'Delegated', 'key-hash', 'key', '["read"]', 'legacy-user', now)
    db.$client.prepare(`INSERT INTO audit_log
      (id, actor, action, entity_type, credential_id, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-audit', 'api-key:legacy-delegated', 'project.updated', 'project', 'legacy-delegated', 'request-1', now)

    migrate(db)
    migrate(db)

    expect(db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_logs'")
      .get()).toEqual({ name: 'runtime_logs' })
    expect(db.select().from(users).where(eq(users.id, 'legacy-user')).get()).toMatchObject({
      passwordHash: 'legacy-password-hash',
      role: 'viewer',
      status: 'active',
      authVersion: 0,
      permissionsMigrated: false,
    })
    expect(db.select().from(userSessions).where(eq(userSessions.tokenHash, 'legacy-session')).get()?.authVersion).toBe(0)
    expect(db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, 'legacy-code')).get()?.userAuthVersion).toBe(0)
    expect(db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, 'legacy-token')).get()?.userAuthVersion).toBe(0)
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'legacy-delegated')).get()?.delegatedUserAuthVersion).toBeNull()
    db.$client.prepare(`INSERT INTO audit_log
      (id, actor, action, entity_type, actor_user_id, actor_name, credential_id, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('stable-actor-audit', 'user:legacy-user', 'project.updated', 'project', 'legacy-user', 'Legacy User', 'legacy-delegated', 'request-2', now)
    expect(db.$client.prepare(`SELECT id, actor_user_id, actor_name, credential_id, request_id
      FROM audit_log ORDER BY id`).all()).toEqual([
      {
        id: 'legacy-audit',
        actor_user_id: null,
        actor_name: null,
        credential_id: 'legacy-delegated',
        request_id: 'request-1',
      },
      {
        id: 'stable-actor-audit',
        actor_user_id: 'legacy-user',
        actor_name: 'Legacy User',
        credential_id: 'legacy-delegated',
        request_id: 'request-2',
      },
    ])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('v156 does not reject an unrelated legacy foreign-key orphan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-access-orphan-'))
  const db = createClient(path.join(dir, 'test.db'))
  const now = '2026-09-11T00:00:00.000Z'
  try {
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 155))
    db.$client.pragma('foreign_keys = OFF')
    db.$client.prepare(`INSERT INTO queries (id, project_id, query, created_at)
      VALUES (?, ?, ?, ?)`)
      .run('legacy-orphan-query', 'missing-project', 'legacy orphan', now)
    db.$client.pragma('foreign_keys = ON')
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1)

    migrate(db)

    expect(db.$client.prepare('SELECT id FROM queries WHERE id = ?').get('legacy-orphan-query')).toEqual({
      id: 'legacy-orphan-query',
    })
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1)
  } finally {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
