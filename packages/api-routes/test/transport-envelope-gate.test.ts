import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createClient, migrate, apiKeys, projects } from '@canonry/canonry-db'
import Fastify from 'fastify'
import { expect, test } from 'vitest'

import { apiRoutes } from '../src/index.js'

/**
 * The global read-only gate keys off the HTTP method, which is right for REST
 * and wrong for a JSON-RPC transport: MCP over Streamable HTTP carries reads
 * inside a POST, so a `['read']` key would be 403'd at the door on
 * `initialize`. `transportEnvelope` is the carve-out.
 *
 * This file pins the two properties that keep the carve-out sound:
 *   1. an undeclared write route is refused exactly as before, and
 *   2. NOTHING in the product's REST surface declares the flag.
 *
 * (2) is the one a reviewer cannot enforce by reading a diff. The positive case
 * — a declared route actually admitting a read-only key — is asserted where the
 * only such route lives, alongside the MCP transport itself; `apiRoutes` is an
 * encapsulated plugin, so a route registered on the root app in a test would
 * never run this hook and would prove nothing.
 */

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-envelope-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  return { app, db, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) }
}

function seedReadOnlyKey(db: ReturnType<typeof createClient>): string {
  const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'reader',
    keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 9),
    scopes: ['read'],
    createdAt: new Date().toISOString(),
  }).run()
  return raw
}

test('the read-only gate still refuses a POST to an ordinary write route', async () => {
  const { app, db, cleanup } = buildApp()
  app.register(apiRoutes, { db, skipAuth: false, googleStateSecret: 'test-only-google-state-secret-32b' })

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'acme',
    displayName: 'Acme',
    canonicalDomain: 'acme.example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const readOnly = seedReadOnlyKey(db)
  await app.ready()
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/acme/runs',
      headers: { authorization: `Bearer ${readOnly}` },
      payload: { kind: 'answer-visibility' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error?.message ?? res.body).toContain('read-only')
  } finally {
    await app.close()
    cleanup()
  }
})

test('no route registered by apiRoutes declares transportEnvelope', async () => {
  // The precondition for the whole exemption. Every route in the product's REST
  // surface does real work, so none of them may claim to be a bare protocol
  // envelope. The MCP transport mounts separately and is the only declarer.
  //
  // If this fails, someone put the flag on a working route and a read-only key
  // can now POST to it. That is privilege escalation, not a style nit.
  const { app, db, cleanup } = buildApp()
  const offenders: string[] = []
  app.addHook('onRoute', (route) => {
    if ((route.config as { transportEnvelope?: boolean } | undefined)?.transportEnvelope === true) {
      offenders.push(`${String(route.method)} ${route.url}`)
    }
  })
  app.register(apiRoutes, { db, skipAuth: false, googleStateSecret: 'test-only-google-state-secret-32b' })
  await app.ready()
  try {
    expect(offenders).toEqual([])
  } finally {
    await app.close()
    cleanup()
  }
})
