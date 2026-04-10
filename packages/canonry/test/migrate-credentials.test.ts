import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { parse } from 'yaml'
import type { CanonryConfig } from '../src/config.js'
import { migrateDbCredentialsToConfig } from '../src/server.js'
import { getGoogleConnection } from '../src/google-config.js'
import { getGa4Connection } from '../src/ga4-config.js'

function setupDb(tmpDir: string) {
  const dbPath = path.join(tmpDir, 'canonry.db')
  const db = createClient(dbPath)
  migrate(db)
  return db
}

function makeConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry.db',
    apiKey: 'cnry_test',
  }
}

describe('migrateDbCredentialsToConfig', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  function makeTmpDir() {
    const d = path.join(os.tmpdir(), `canonry-migrate-creds-${crypto.randomUUID()}`)
    fs.mkdirSync(d, { recursive: true })
    dirs.push(d)
    return d
  }

  it('migrates Google OAuth tokens from DB to config', () => {
    const tmpDir = makeTmpDir()
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const db = setupDb(tmpDir)
    const config = makeConfig()

    // Insert legacy credential data via raw SQL (columns exist in migration but not Drizzle schema)
    db.run(sql.raw(`INSERT INTO google_connections (id, domain, connection_type, property_id, access_token, refresh_token, token_expires_at, scopes, created_at, updated_at) VALUES ('gc1', 'example.com', 'gsc', 'sc-domain:example.com', 'access-tok', 'refresh-tok', '2026-12-01T00:00:00Z', '["https://www.googleapis.com/auth/webmasters"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`))

    migrateDbCredentialsToConfig(db, config)

    const conn = getGoogleConnection(config, 'example.com', 'gsc')
    expect(conn).toBeDefined()
    expect(conn?.refreshToken).toBe('refresh-tok')
    expect(conn?.accessToken).toBe('access-tok')
    expect(conn?.propertyId).toBe('sc-domain:example.com')
    expect(conn?.tokenExpiresAt).toBe('2026-12-01T00:00:00Z')
  })

  it('migrates GA4 service account keys from DB to config', () => {
    const tmpDir = makeTmpDir()
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const db = setupDb(tmpDir)
    const config = makeConfig()

    // Create a project first (ga_connections references projects)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj-1',
      name: 'test-project',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      keywords: '[]',
      competitors: '[]',
      providers: '["gemini"]',
      locations: '[]',
      tags: '[]',
      labels: '{}',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.run(sql.raw(`INSERT INTO ga_connections (id, project_id, property_id, client_email, private_key, created_at, updated_at) VALUES ('ga1', 'proj-1', '123456789', 'sa@proj.iam.gserviceaccount.com', '-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`))

    migrateDbCredentialsToConfig(db, config)

    const conn = getGa4Connection(config, 'test-project')
    expect(conn).toBeDefined()
    expect(conn?.clientEmail).toBe('sa@proj.iam.gserviceaccount.com')
    expect(conn?.privateKey).toContain('BEGIN PRIVATE KEY')
    expect(conn?.propertyId).toBe('123456789')
  })

  it('skips migration when config already has credentials', () => {
    const tmpDir = makeTmpDir()
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const db = setupDb(tmpDir)
    const config = makeConfig()

    // Pre-populate config with existing connection
    config.google = {
      connections: [{
        domain: 'example.com',
        connectionType: 'gsc',
        propertyId: 'sc-domain:example.com',
        accessToken: 'newer-access',
        refreshToken: 'newer-refresh',
        tokenExpiresAt: '2027-01-01T00:00:00Z',
        scopes: [],
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      }],
    }

    // Insert older credentials in DB
    db.run(sql.raw(`INSERT INTO google_connections (id, domain, connection_type, property_id, access_token, refresh_token, token_expires_at, scopes, created_at, updated_at) VALUES ('gc1', 'example.com', 'gsc', 'sc-domain:example.com', 'old-access', 'old-refresh', '2026-01-01T00:00:00Z', '[]', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`))

    migrateDbCredentialsToConfig(db, config)

    const conn = getGoogleConnection(config, 'example.com', 'gsc')
    expect(conn?.refreshToken).toBe('newer-refresh')
    expect(conn?.accessToken).toBe('newer-access')
  })

  it('handles empty DB gracefully', () => {
    const tmpDir = makeTmpDir()
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const db = setupDb(tmpDir)
    const config = makeConfig()

    // Should not throw
    migrateDbCredentialsToConfig(db, config)

    expect(config.google).toBeUndefined()
    expect(config.ga4).toBeUndefined()
  })

  it('does not clobber existing config.yaml content during migration', () => {
    const tmpDir = makeTmpDir()
    vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
    const db = setupDb(tmpDir)

    // Write a config.yaml with existing content that should survive
    const existingYaml = [
      'apiUrl: http://localhost:4100',
      'database: /tmp/canonry.db',
      'apiKey: cnry_existing_key',
      'providers:',
      '  gemini:',
      '    apiKey: gemini-key-123',
      '    model: gemini-2.0-flash',
      'bing:',
      '  connections:',
      '    - domain: example.com',
      '      apiKey: bing-key-456',
      '      createdAt: "2026-01-01T00:00:00Z"',
      '      updatedAt: "2026-01-01T00:00:00Z"',
      'google:',
      '  clientId: google-client-id',
      '  clientSecret: google-client-secret',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), existingYaml)

    // Load config with existing google auth settings
    const config: CanonryConfig = {
      apiUrl: 'http://localhost:4100',
      database: '/tmp/canonry.db',
      apiKey: 'cnry_existing_key',
      providers: { gemini: { apiKey: 'gemini-key-123', model: 'gemini-2.0-flash' } },
      bing: {
        connections: [{
          domain: 'example.com',
          apiKey: 'bing-key-456',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
      },
      google: {
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      },
    }

    // Insert legacy Google OAuth tokens in DB
    db.run(sql.raw(`INSERT INTO google_connections (id, domain, connection_type, property_id, access_token, refresh_token, token_expires_at, scopes, created_at, updated_at) VALUES ('gc1', 'example.com', 'gsc', 'sc-domain:example.com', 'migrated-access', 'migrated-refresh', '2026-12-01T00:00:00Z', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`))

    migrateDbCredentialsToConfig(db, config)

    // Verify migrated connection landed in config
    const conn = getGoogleConnection(config, 'example.com', 'gsc')
    expect(conn?.refreshToken).toBe('migrated-refresh')

    // Verify existing config.yaml content was preserved on disk
    const savedRaw = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8')
    const saved = parse(savedRaw) as Record<string, unknown>

    // Critical: these existing fields must survive the migration write
    expect(saved.apiKey).toBe('cnry_existing_key')
    expect(saved.apiUrl).toBe('http://localhost:4100')
    expect((saved.providers as Record<string, Record<string, string>>)?.gemini?.apiKey).toBe('gemini-key-123')
    expect((saved.bing as Record<string, unknown[]>)?.connections).toHaveLength(1)
    // Google clientId/clientSecret must survive alongside the new connections
    expect((saved.google as Record<string, unknown>)?.clientId).toBe('google-client-id')
    expect((saved.google as Record<string, unknown>)?.clientSecret).toBe('google-client-secret')
    expect(((saved.google as Record<string, unknown>)?.connections as unknown[])?.length).toBe(1)
  })
})
