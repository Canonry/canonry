import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

function makeApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-no-secret-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON())
    }
    throw error
  })
  return { app, db, tmpDir }
}

const baseStore = {
  listConnections: () => [],
  getConnection: () => undefined,
  upsertConnection: (connection: Parameters<typeof baseStore.upsertConnection>[0]) => connection,
  updateConnection: () => undefined,
  deleteConnection: () => false,
} as const

describe('googleRoutes refuses to register without a configured state secret', () => {
  it('skips registration when googleStateSecret is undefined (no Google routes mounted)', async () => {
    const { app, tmpDir } = makeApp()
    app.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
      googleConnectionStore: baseStore,
      // googleStateSecret deliberately omitted — pre-fix this silently
      // fell back to the literal string 'insecure-default-secret'. Now the
      // plugin no-ops so the OAuth attack surface vanishes; the routes
      // simply 404. Operators see the warning in logs.
    })

    await app.ready()
    // Probe a representative Google route — it must 404 because the plugin
    // refused to register itself.
    const res = await app.inject({
      method: 'POST',
      url: '/projects/my-project/google/connect',
      payload: { type: 'gsc' },
    })
    expect(res.statusCode).toBe(404)

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws at app.ready() when googleStateSecret is an empty string', async () => {
    // Empty string is an active misconfiguration (e.g. GOOGLE_STATE_SECRET=""
    // in env). Surface it loudly at boot rather than silently treating it as
    // "not configured".
    const { app, tmpDir } = makeApp()
    app.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
      googleConnectionStore: baseStore,
      googleStateSecret: '',
    })

    await expect(app.ready()).rejects.toThrow(/empty|state secret|GOOGLE_STATE_SECRET/i)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects the literal insecure default value (defense in depth)', async () => {
    // Even if someone copy-pastes the historical fallback into config, the
    // plugin refuses to honor it.
    const { app, tmpDir } = makeApp()
    app.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
      googleConnectionStore: baseStore,
      googleStateSecret: 'insecure-default-secret',
    })

    await expect(app.ready()).rejects.toThrow(/insecure|state secret|GOOGLE_STATE_SECRET/i)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers successfully when a real secret is provided', async () => {
    const { app, tmpDir } = makeApp()
    app.register(googleRoutes, {
      getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
      googleConnectionStore: baseStore,
      googleStateSecret: 'a-real-32-byte-hex-secret-here-1234',
    })

    await expect(app.ready()).resolves.toBeDefined()
    await app.close()

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
