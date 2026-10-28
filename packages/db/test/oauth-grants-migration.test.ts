import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { createClient, migrate, MIGRATION_VERSIONS, oauthTokens } from '../src/index.js'
import { insertLegacyRow } from './legacy-rows.js'

test('legacy OAuth families preserve tokens and never join different users, clients, audiences or scopes', () => {
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
    migrate(db)
    const firstPass = db.select().from(oauthTokens).all()
    migrate(db)
    expect(db.select().from(oauthTokens).all()).toEqual(firstPass)
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
