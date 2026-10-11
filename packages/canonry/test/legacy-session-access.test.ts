import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { operationAccess } from '@ainyc/canonry-contracts'

describe('legacy dashboard session operation boundary', () => {
  let dir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let rawKey: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-session-access-'))
    const database = path.join(dir, 'test.db')
    db = createClient(database)
    migrate(db)
    rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'root',
      keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    app = await createServer({
      config: { apiUrl: 'http://localhost:4100', basePath: '/canonry', database, apiKey: rawKey, providers: {} },
      db,
      logger: false,
    })
  })

  afterEach(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('classifies and labels every root session route as a write under a base path', async () => {
    expect(operationAccess('GET', '/api/v1/session')).toBe('write')

    const requests = [
      { method: 'GET' as const, url: '/canonry/api/v1/session' },
      { method: 'POST' as const, url: '/canonry/api/v1/session/setup', payload: {} },
      { method: 'POST' as const, url: '/canonry/api/v1/session', payload: {} },
      { method: 'DELETE' as const, url: '/canonry/api/v1/session' },
    ]
    for (const request of requests) {
      const response = await app.inject(request)
      expect(response.headers['x-canonry-access'], `${request.method} ${request.url}`).toBe('write')
    }
  })
})
