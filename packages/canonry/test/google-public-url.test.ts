import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apiKeys, createClient, migrate, projects } from '@ainyc/canonry-db'

import { createServer, resolveGooglePublicUrl } from '../src/server.js'

describe('resolveGooglePublicUrl', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  })

  it('keeps an explicit publicUrl unchanged', () => {
    expect(resolveGooglePublicUrl({
      apiUrl: 'http://localhost:4100',
      publicUrl: 'https://canonry.example.com/app',
    })).toBe('https://canonry.example.com/app')
  })

  it('infers a localhost publicUrl from loopback apiUrl and serve port', () => {
    expect(resolveGooglePublicUrl({
      apiUrl: 'http://127.0.0.1:4100',
      port: 5555,
    })).toBe('http://localhost:5555')
  })

  it('includes a configured basePath when the apiUrl has no path', () => {
    expect(resolveGooglePublicUrl({
      apiUrl: 'http://localhost:4100',
    }, '/canonry/')).toBe('http://localhost:4100/canonry')
  })

  it('includes the apiUrl path when present', () => {
    expect(resolveGooglePublicUrl({
      apiUrl: 'http://localhost:4100/canonry',
    }, '/ignored/')).toBe('http://localhost:4100/canonry')
  })

  it('does not infer a publicUrl for remote or unusable local URLs', () => {
    expect(resolveGooglePublicUrl({ apiUrl: 'https://api.example.com' })).toBeUndefined()
    expect(resolveGooglePublicUrl({ apiUrl: 'http://localhost:0' })).toBeUndefined()
  })

  it('hands the inferred localhost publicUrl to the Google connect route', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-public-url-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: 'key_1',
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      keyPrefix: apiKey.slice(0, 12),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'p1',
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    const app = await createServer({
      config: {
        apiUrl: 'http://127.0.0.1:4100',
        port: 5555,
        database: dbPath,
        apiKey,
        providers: {},
        google: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          connections: [],
        },
      },
      db,
      logger: false,
    })

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/testproj/google/connect',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { type: 'gsc' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json() as { authUrl: string; redirectUri: string }
      expect(body.redirectUri).toBe('http://localhost:5555/api/v1/google/callback')
      expect(body.authUrl).toContain(encodeURIComponent('http://localhost:5555/api/v1/google/callback'))
    } finally {
      await app.close()
    }
  })
})
