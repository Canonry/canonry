import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

test('malformed Authorization headers return the structured AUTH_REQUIRED envelope', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-malformed-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update('cnry_test').digest('hex'),
    keyPrefix: 'cnry_test',
    scopes: '["*"]',
    createdAt: new Date().toISOString(),
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()

  try {
    const cases: Array<[string, string]> = [
      ['extra space',    'Bearer  cnry_test'],
      ['leading space',  ' Bearer cnry_test'],
      ['trailing space', 'Bearer cnry_test '],
      ['tab separator',  'Bearer\tcnry_test'],
      ['no token',       'Bearer'],
      ['wrong scheme',   'Token cnry_test'],
      ['empty header',   ''],
    ]
    for (const [label, auth] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: auth },
      })
      expect(res.statusCode, label).toBe(401)
      expect(JSON.parse(res.body), label).toEqual({
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      })
    }
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
