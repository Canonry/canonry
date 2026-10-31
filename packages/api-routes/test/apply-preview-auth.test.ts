import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { apiKeys, createClient, migrate, projects } from '@canonry/canonry-db'
import { expect, test } from 'vitest'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const document = (name: string) => ({
  apiVersion: 'canonry/v1',
  kind: 'Project',
  metadata: { name },
  spec: { displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en' },
})

test('apply preview enforces project scoped read, named, foreign and create boundaries', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-preview-auth-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectAId = crypto.randomUUID()
  const projectBId = crypto.randomUUID()
  db.insert(projects).values([
    { id: projectAId, name: 'project-a', displayName: 'project-a', canonicalDomain: 'project-a.example', country: 'US', language: 'en', createdAt: now, updatedAt: now },
    { id: projectBId, name: 'project-b', displayName: 'project-b', canonicalDomain: 'project-b.example', country: 'US', language: 'en', createdAt: now, updatedAt: now },
  ]).run()
  const writeToken = 'cnry_preview_write'
  const readToken = 'cnry_preview_read'
  const settingsToken = 'cnry_preview_settings'
  db.insert(apiKeys).values([
    { id: crypto.randomUUID(), name: 'preview-write', keyHash: hashApiKey(writeToken), keyPrefix: writeToken.slice(0, 9), scopes: ['*'], projectId: projectAId, createdAt: now },
    { id: crypto.randomUUID(), name: 'preview-read', keyHash: hashApiKey(readToken), keyPrefix: readToken.slice(0, 9), scopes: ['read'], projectId: projectAId, createdAt: now },
    { id: crypto.randomUUID(), name: 'preview-settings', keyHash: hashApiKey(settingsToken), keyPrefix: settingsToken.slice(0, 9), scopes: ['settings.write'], projectId: projectAId, createdAt: now },
  ]).run()
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-test', knownModels: [], modelValidationPattern: /^gpt-/, modelValidationHint: 'gpt model' }],
  })
  await app.ready()
  try {
    const own = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', headers: { authorization: `Bearer ${writeToken}` }, payload: document('project-a') })
    expect(own.statusCode).toBe(200)

    const namedBase = document('project-a')
    const namedDocument = { ...namedBase, spec: { ...namedBase.spec, providers: ['openai'], providerModels: { openai: 'gpt-test' } } }
    const named = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', headers: { authorization: `Bearer ${settingsToken}` }, payload: namedDocument })
    expect(named.statusCode).toBe(200)

    const readOnly = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', headers: { authorization: `Bearer ${readToken}` }, payload: document('project-a') })
    expect(readOnly.statusCode).toBe(403)

    for (const name of ['project-b', 'missing-project']) {
      const foreign = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', headers: { authorization: `Bearer ${writeToken}` }, payload: document(name) })
      expect(foreign.statusCode).toBe(403)
      expect(foreign.body).not.toContain(name)
    }
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
