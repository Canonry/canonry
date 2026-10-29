import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { createClient, migrate, MIGRATION_VERSIONS, apiKeys, dashboardSessions, oauthTokens } from '../src/index.js'
import { insertLegacyRow } from './legacy-rows.js'

test.each([false, true])('legacy OAuth families preserve valid credentials and retire untraceable keys (orphans: %s)', withOrphans => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-oauth-grants-'))
  const db = createClient(path.join(dir, 'test.db'))
  const now = '2026-10-01T00:00:00.000Z'
  const expiry = '2026-11-01T00:00:00.000Z'
  try {
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 199))
    for (const id of ['sam', 'lee']) {
      insertLegacyRow(db, 'users', { id, name: id, name_key: id, password_hash: 'unused', role: 'viewer', created_at: now })
    }
    for (const id of ['client-1', 'client-2']) {
      insertLegacyRow(db, 'oauth_clients', { id, name: id, redirect_uris: [], created_at: now })
    }
    const rows = [
      ['original-access', 'access', 'client-1', 'sam', 'https://a.example/mcp', 'read'],
      ['old-refresh', 'refresh', 'client-1', 'sam', 'https://a.example/mcp', 'read'],
      ['rotated-refresh', 'refresh', 'client-1', 'sam', 'https://a.example/mcp', 'read'],
      ['other-user', 'refresh', 'client-1', 'lee', 'https://a.example/mcp', 'read'],
      ['other-client', 'refresh', 'client-2', 'sam', 'https://a.example/mcp', 'read'],
      ['other-resource', 'refresh', 'client-1', 'sam', 'https://b.example/mcp', 'read'],
      ['other-scope', 'refresh', 'client-1', 'sam', 'https://a.example/mcp', 'read research.run'],
      ['null-scope', 'refresh', 'client-1', 'sam', 'https://a.example/mcp', null],
      ['null-resource', 'refresh', 'client-1', 'sam', null, 'read'],
    ]
    for (const row of rows) {
      insertLegacyRow(db, 'oauth_tokens', {
        token_hash: row[0]!, kind: row[1]!, client_id: row[2]!, user_id: row[3]!,
        resource: row[4]!, scope: row[5]!, expires_at: expiry, created_at: now,
      })
    }
    // Reproduce legacy edits made with SQLite FK enforcement disabled.
    db.$client.pragma('foreign_keys = OFF')
    const orphans = [
      ['orphan-client', 'deleted-client', 'sam'],
      ['orphan-user', 'client-1', 'deleted-user'],
      ['orphan-both', 'deleted-client', 'deleted-user'],
    ]
    for (const [tokenHash, clientId, userId] of withOrphans ? orphans : []) {
      insertLegacyRow(db, 'oauth_tokens', {
        token_hash: tokenHash!, kind: 'refresh', client_id: clientId!, user_id: userId!,
        resource: 'https://a.example/mcp', scope: 'read', expires_at: expiry, created_at: now,
      })
    }
    db.$client.pragma('foreign_keys = ON')
    const legacyKeys = [
      { id: 'mcp-sam', name: 'mcp-session:sam', user: 'sam', retired: true },
      { id: 'mcp-lee', name: 'mcp-session:lee', user: 'lee', retired: true },
      { id: 'aero-sam', name: 'aero-viewer:sam', user: 'sam', retired: false },
      { id: 'historical-unbound', name: 'mcp-session:sam', user: null, retired: true },
      { id: 'historical-deleted-user', name: 'mcp-session:deleted-account', user: null, retired: true },
      { id: 'ordinary', name: 'Operator key', user: null, retired: false },
      { id: 'different-name', name: 'mcp-session:lee', user: 'sam', retired: false },
    ]
    for (const key of legacyKeys) {
      insertLegacyRow(db, 'api_keys', {
        id: key.id, name: key.name, key_hash: `hash-${key.id}`, key_prefix: 'cnry_test',
        scopes: ['read'], delegated_user_id: key.user, created_at: now,
      })
      insertLegacyRow(db, 'dashboard_sessions', {
        token_hash: `session-${key.id}`, api_key_id: key.id, api_key_hash: `hash-${key.id}`,
        created_at: now, expires_at: expiry,
      })
    }
    migrate(db)
    const migratedKeys = db.select().from(apiKeys).all()
    const migratedSessions = db.select().from(dashboardSessions).all()
    for (const key of legacyKeys) {
      const migrated = migratedKeys.find(row => row.id === key.id)!
      expect(migrated.keyHash).toBe(`hash-${key.id}`)
      expect(migrated.delegatedOAuthGrantId).toBeNull()
      if (key.retired) expect(migrated.revokedAt).not.toBeNull()
      else expect(migrated.revokedAt).toBeNull()
      expect(migratedSessions.some(row => row.apiKeyId === key.id)).toBe(!key.retired)
    }
    const firstPass = db.select().from(oauthTokens).all()
    expect(firstPass.some(token => token.tokenHash.startsWith('orphan-'))).toBe(false)
    expect(db.$client.pragma('foreign_key_check')).toEqual([])
    migrate(db)
    expect(db.select().from(oauthTokens).all()).toEqual(firstPass)
    expect(db.select().from(apiKeys).all()).toEqual(migratedKeys)
    expect(db.select().from(dashboardSessions).all()).toEqual(migratedSessions)
    const byToken = new Map(firstPass.map(token => [token.tokenHash, token]))
    const original = byToken.get('original-access')!
    expect(original.grantId).toBeTruthy()
    expect(byToken.get('old-refresh')?.grantId).toBe(original.grantId)
    expect(byToken.get('rotated-refresh')?.grantId).toBe(original.grantId)
    const unrelated = rows.slice(3).map(row => byToken.get(row[0]!)!.grantId)
    expect(new Set([original.grantId, ...unrelated]).size).toBe(7)
    expect(firstPass).toHaveLength(rows.length)
    for (const token of firstPass) {
      expect(token.expiresAt).toBe(expiry)
      expect(token.createdAt).toBe(now)
      expect(token.revokedAt).toBeNull()
    }
  } finally {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
