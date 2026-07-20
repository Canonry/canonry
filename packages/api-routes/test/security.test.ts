import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { createClient, migrate, apiKeys, notifications, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-security-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  // Google routes register only when a state secret is configured; the
  // public-route exception test below covers /google/callback, so seed a
  // dummy secret to keep that surface mounted under test.
  app.register(apiRoutes, { db, skipAuth: false, googleStateSecret: 'test-only-google-state-secret-32b', ...opts })

  return { app, db, tmpDir }
}

function insertApiKey(db: ReturnType<typeof createClient>, rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  return rawKey
}

test('auth protects non-public routes while keeping public exceptions reachable', async () => {
  const { app, tmpDir } = buildApp({
    getGoogleAuthConfig: () => ({ clientId: 'google-client-id', clientSecret: 'google-client-secret' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => undefined,
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
  })
  await app.ready()

  try {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(listRes.statusCode).toBe(401)
    expect(JSON.parse(listRes.body).error.code).toBe('AUTH_REQUIRED')

    const runRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/probe/runs',
      payload: {},
    })
    expect(runRes.statusCode).toBe(401)

    const openApiRes = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(openApiRes.statusCode).toBe(200)

    const callbackRes = await app.inject({ method: 'GET', url: '/api/v1/google/callback' })
    expect(callbackRes.statusCode).toBe(400)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('bearer auth reaches protected routes and updates key usage', async () => {
  const { app, db, tmpDir } = buildApp()
  const rawKey = insertApiKey(db)
  await app.ready()

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
    expect(db.select().from(apiKeys).all()[0]?.lastUsedAt).toBeTruthy()
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('settings routes refuse keys that lack the settings.write scope', async () => {
  // Provider key updates can replace the operator's OpenAI / Anthropic /
  // Google / Bing credentials. Without scope gating, any bearer holder
  // could swap them. The gate accepts wildcard `'*'` (the default `canonry
  // init` key) and a future `settings.write` scope. A read-only key (any
  // scope set that doesn't include either) is forbidden.
  const { app, db, tmpDir } = buildApp({
    googleSettingsSummary: { configured: false },
    onGoogleSettingsUpdate: () => ({ configured: true }),
  })

  // Read-only key — explicit, narrow scope list.
  const readOnlyRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'read-only',
    keyHash: crypto.createHash('sha256').update(readOnlyRaw).digest('hex'),
    keyPrefix: readOnlyRaw.slice(0, 9),
    scopes: ['read'],
    createdAt: new Date().toISOString(),
  }).run()

  // Admin key — wildcard. Mirrors what `canonry init` writes for the
  // install's primary key.
  const adminRaw = insertApiKey(db)

  await app.ready()
  try {
    // Read-only key is forbidden.
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${readOnlyRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(JSON.parse(forbidden.body).error.code).toBe('FORBIDDEN')

    // Wildcard key works.
    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${adminRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(allowed.statusCode).toBe(200)

    // A key that explicitly carries 'settings.write' (no wildcard) works.
    const scopedRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'settings-only',
      keyHash: crypto.createHash('sha256').update(scopedRaw).digest('hex'),
      keyPrefix: scopedRaw.slice(0, 9),
      scopes: ['settings.write'],
      createdAt: new Date().toISOString(),
    }).run()
    const scoped = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${scopedRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(scoped.statusCode).toBe(200)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a read-only key is blocked on every write method but passes reads', async () => {
  // The global read-only gate lives in the auth plugin and keys off the HTTP
  // method — NOT on per-route `requireScope` calls. Prove it by hitting a write
  // route that has no `requireScope` of its own (`POST .../runs`, `PUT
  // /projects/:name`): a `['read']` key must still be forbidden there.
  const { app, db, tmpDir } = buildApp()

  const readOnlyRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'reader',
    keyHash: crypto.createHash('sha256').update(readOnlyRaw).digest('hex'),
    keyPrefix: readOnlyRaw.slice(0, 9),
    scopes: ['read'],
    createdAt: new Date().toISOString(),
  }).run()

  const wildcardRaw = insertApiKey(db)
  await app.ready()

  try {
    const readHeaders = { authorization: `Bearer ${readOnlyRaw}` }

    // Reads pass.
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: readHeaders })
    expect(list.statusCode).toBe(200)

    // A wildcard key seeds a project so the write routes below resolve a real
    // target rather than 404-ing before the gate is exercised.
    const seed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/gate-test',
      headers: { authorization: `Bearer ${wildcardRaw}` },
      payload: { displayName: 'Gate Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(seed.statusCode).toBe(201)

    // Writes are forbidden — across a route with no requireScope (runs) AND a
    // create/update route (PUT project), AND a DELETE.
    for (const req of [
      { method: 'POST' as const, url: '/api/v1/projects/gate-test/runs', payload: {} },
      { method: 'PUT' as const, url: '/api/v1/projects/gate-test', payload: { displayName: 'x', canonicalDomain: 'example.com', country: 'US', language: 'en' } },
      { method: 'DELETE' as const, url: '/api/v1/projects/gate-test' },
    ]) {
      const res = await app.inject({ ...req, headers: readHeaders })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    }

    // The wildcard key is unaffected — it can still write (delete the project).
    const wildcardDelete = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/gate-test',
      headers: { authorization: `Bearer ${wildcardRaw}` },
    })
    expect(wildcardDelete.statusCode).toBe(204)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('per-project model overrides need settings.write, but ordinary project writes do not', async () => {
  // Choosing the execution model is an instance-level capability — `PUT
  // /settings/providers/:name` is gated on `settings.write` for that reason.
  // The per-project override is the same capability at a finer grain, so a
  // delegate key with plain `write` (a shape keys.ts explicitly supports: it
  // must opt into `settings.write`) must not pick the model. The gate keys off
  // the selection CHANGING, so a rename or an echo of the current overrides
  // stays ungated.
  const { app, db, tmpDir } = buildApp({
    providerAdapters: [
      {
        name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true,
        defaultModel: 'gpt-5.4', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid OpenAI model name',
      },
      {
        name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
        defaultModel: 'gemini-2.5-flash', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid Gemini model name',
      },
    ],
  })

  function seedKey(name: string, scopes: string[]): string {
    const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name,
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      keyPrefix: raw.slice(0, 9),
      scopes,
      createdAt: new Date().toISOString(),
    }).run()
    return raw
  }

  const writeRaw = seedKey('delegate-write', ['read', 'write'])
  const settingsRaw = seedKey('delegate-settings', ['read', 'write', 'settings.write'])
  const writeHeaders = { authorization: `Bearer ${writeRaw}` }
  const settingsHeaders = { authorization: `Bearer ${settingsRaw}` }
  const baseProject = { displayName: 'Model Gate', canonicalDomain: 'example.com', country: 'US', language: 'en' }

  await app.ready()
  try {
    // A plain project create with no overrides is ungated.
    const created = await app.inject({
      method: 'PUT', url: '/api/v1/projects/model-gate', headers: writeHeaders, payload: baseProject,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().providerModels).toEqual({})

    // Choosing a model is not.
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/model-gate',
      headers: writeHeaders,
      payload: { ...baseProject, providerModels: { openai: 'gpt-5-nano' } },
    })
    expect(blocked.statusCode).toBe(403)
    expect(JSON.parse(blocked.body).error.code).toBe('FORBIDDEN')
    expect(JSON.parse(blocked.body).error.message).toContain('settings.write')

    // …and the same key can still do ordinary project work (a rename).
    const renamed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/model-gate',
      headers: writeHeaders,
      payload: { ...baseProject, displayName: 'Renamed' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().displayName).toBe('Renamed')

    // A settings.write key may choose the model.
    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/model-gate',
      headers: settingsHeaders,
      payload: { ...baseProject, providerModels: { openai: 'gpt-5-nano' } },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().providerModels).toEqual({ openai: 'gpt-5-nano' })

    // Echoing the stored overrides back is not a change — still ungated.
    const echoed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/model-gate',
      headers: writeHeaders,
      payload: { ...baseProject, displayName: 'Echoed', providerModels: { openai: ' gpt-5-nano ' } },
    })
    expect(echoed.statusCode).toBe(200)
    expect(echoed.json().providerModels).toEqual({ openai: 'gpt-5-nano' })

    // POST /apply is the same capability through another door — blocked when it
    // would change the selection (here: clear it), allowed when it echoes.
    const applyBody = (providerModels?: Record<string, string>) => ({
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'model-gate' },
      spec: { ...baseProject, ...(providerModels ? { providerModels } : {}) },
    })

    const applyBlocked = await app.inject({
      method: 'POST', url: '/api/v1/apply', headers: writeHeaders, payload: applyBody(),
    })
    expect(applyBlocked.statusCode).toBe(403)
    expect(JSON.parse(applyBlocked.body).error.code).toBe('FORBIDDEN')

    const applyEchoed = await app.inject({
      method: 'POST', url: '/api/v1/apply', headers: writeHeaders, payload: applyBody({ openai: 'gpt-5-nano' }),
    })
    expect(applyEchoed.statusCode).toBe(200)

    const applyAllowed = await app.inject({
      method: 'POST', url: '/api/v1/apply', headers: settingsHeaders, payload: applyBody({ openai: 'gpt-5-mini' }),
    })
    expect(applyAllowed.statusCode).toBe(200)

    const stored = await app.inject({
      method: 'GET', url: '/api/v1/projects/model-gate', headers: writeHeaders,
    })
    expect(stored.json().providerModels).toEqual({ openai: 'gpt-5-mini' })
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('notification APIs and history redact webhook secrets while keeping stored delivery config intact', async () => {
  const { app, db, tmpDir } = buildApp()
  const rawKey = insertApiKey(db)
  const authHeaders = { authorization: `Bearer ${rawKey}` }
  const secretUrl = 'https://8.8.8.8/hooks/secret-token?api_key=super-secret'
  await app.ready()

  try {
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/secure-project',
      headers: authHeaders,
      payload: {
        displayName: 'Secure Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(projectRes.statusCode).toBe(201)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/secure-project/notifications',
      headers: authHeaders,
      payload: {
        channel: 'webhook',
        url: secretUrl,
        events: ['run.completed'],
      },
    })
    expect(createRes.statusCode).toBe(201)

    const created = JSON.parse(createRes.body) as {
      url: string
      urlDisplay: string
      urlHost: string
      webhookSecret?: string
    }
    expect(created.url).toBe('https://8.8.8.8/redacted')
    expect(created.urlDisplay).toBe('8.8.8.8/redacted')
    expect(created.urlHost).toBe('8.8.8.8')
    expect(created.url).not.toContain('secret-token')
    expect(created.urlDisplay).not.toContain('super-secret')
    expect(created.webhookSecret).toBeTruthy()

    const stored = db.select().from(notifications).all()[0]
    expect(stored).toBeDefined()
    expect(stored!.config).toEqual({
      url: secretUrl,
      events: ['run.completed'],
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secure-project/notifications',
      headers: authHeaders,
    })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.body).not.toContain('secret-token')
    expect(listRes.body).not.toContain('super-secret')

    const historyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secure-project/history',
      headers: authHeaders,
    })
    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.body).not.toContain('secret-token')
    expect(historyRes.body).not.toContain('super-secret')
    expect(historyRes.body).toContain('8.8.8.8/redacted')
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a plain write key can narrow the engine set on a project carrying an override for the dropped engine', async () => {
  // Regression for the deadlock the two #818 guards created between them: the
  // boundary check 400'd an echoed override for a deselected engine and told
  // the caller to drop it, and dropping it tripped the settings.write gate —
  // so a plain `write` key could not narrow engines at all on such a project.
  // The semantics now: deselecting an engine REMOVES its override (removing a
  // choice, not making one) and rides plain `write`; the server prunes and the
  // response states the result.
  const { app, db, tmpDir } = buildApp({
    providerAdapters: [
      {
        name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true,
        defaultModel: 'gpt-5.4', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid OpenAI model name',
      },
      {
        name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
        defaultModel: 'gemini-2.5-flash', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid Gemini model name',
      },
    ],
  })

  function seedKey(name: string, scopes: string[]): string {
    const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name,
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      keyPrefix: raw.slice(0, 9),
      scopes,
      createdAt: new Date().toISOString(),
    }).run()
    return raw
  }

  const writeHeaders = { authorization: `Bearer ${seedKey('delegate-write', ['read', 'write'])}` }
  const settingsHeaders = { authorization: `Bearer ${seedKey('delegate-settings', ['read', 'write', 'settings.write'])}` }
  const base = { displayName: 'Narrow', canonicalDomain: 'example.com', country: 'US', language: 'en' }

  await app.ready()
  try {
    // A settings.write key sets up the project: two engines, a gemini override.
    const seeded = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: settingsHeaders,
      payload: { ...base, providers: ['openai', 'gemini'], providerModels: { gemini: 'gemini-2.5-pro' } },
    })
    expect(seeded.statusCode).toBe(201)
    expect(seeded.json().providerModels).toEqual({ gemini: 'gemini-2.5-pro' })

    // Arm 1 of the old deadlock: echo the override while narrowing to openai.
    // Used to be 400 "Add them to providers or drop the override."
    const echoed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: writeHeaders,
      payload: { ...base, providers: ['openai'], providerModels: { gemini: 'gemini-2.5-pro' } },
    })
    expect(echoed.statusCode).toBe(200)
    expect(echoed.json().providers).toEqual(['openai'])
    expect(echoed.json().providerModels).toEqual({})

    // Arm 2 of the old deadlock: follow that advice and drop the override.
    // Used to be 403 "requires the settings.write scope."
    const restored = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: settingsHeaders,
      payload: { ...base, providers: ['openai', 'gemini'], providerModels: { gemini: 'gemini-2.5-pro' } },
    })
    expect(restored.json().providerModels).toEqual({ gemini: 'gemini-2.5-pro' })

    const dropped = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: writeHeaders,
      payload: { ...base, providers: ['openai'] },
    })
    expect(dropped.statusCode).toBe(200)
    expect(dropped.json().providerModels).toEqual({})

    // The gate is NOT weakened: narrowing while also setting a value for an
    // engine that survives still requires settings.write.
    const settingWhileNarrowing = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: writeHeaders,
      payload: { ...base, providers: ['openai'], providerModels: { openai: 'gpt-5-nano' } },
    })
    expect(settingWhileNarrowing.statusCode).toBe(403)
    expect(JSON.parse(settingWhileNarrowing.body).error.message).toContain('settings.write')

    // …nor may a write key resurrect a pruned override by re-adding the engine
    // with a value. The prune already removed it, so this is SETTING a value.
    const resurrect = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/narrow-gate',
      headers: writeHeaders,
      payload: { ...base, providers: ['openai', 'gemini'], providerModels: { gemini: 'gemini-2.5-pro' } },
    })
    expect(resurrect.statusCode).toBe(403)

    // apply is the same door and behaves identically.
    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      headers: writeHeaders,
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'narrow-gate' },
        spec: { ...base, providers: ['openai'], providerModels: { gemini: 'gemini-2.5-pro' } },
      },
    })
    expect(applied.statusCode).toBe(200)
    const afterApply = await app.inject({ method: 'GET', url: '/api/v1/projects/narrow-gate', headers: writeHeaders })
    expect(afterApply.json().providerModels).toEqual({})
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a pre-existing row whose stored overrides name an unselected engine stays updatable', async () => {
  // Rows written before the override/provider rule existed can legally carry an
  // override for an engine they do not run. There is no migration, so an
  // ordinary edit on such a row must not 400, must not 403, and must normalize
  // the row on the way through.
  const { app, db, tmpDir } = buildApp({
    providerAdapters: [
      {
        name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true,
        defaultModel: 'gpt-5.4', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid OpenAI model name',
      },
      {
        name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
        defaultModel: 'gemini-2.5-flash', knownModels: [],
        modelValidationPattern: /./, modelValidationHint: 'any valid Gemini model name',
      },
    ],
  })

  const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'delegate-write',
    keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 9),
    scopes: ['read', 'write'],
    createdAt: new Date().toISOString(),
  }).run()
  const writeHeaders = { authorization: `Bearer ${raw}` }

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'legacy',
    displayName: 'Legacy',
    canonicalDomain: 'legacy.example',
    country: 'US',
    language: 'en',
    providers: ['openai'],
    // Legal data before this change: an override for an engine not selected.
    providerModels: { gemini: 'gemini-2.5-pro' },
    createdAt: now,
    updatedAt: now,
  }).run()

  const base = { displayName: 'Legacy', canonicalDomain: 'legacy.example', country: 'US', language: 'en' }

  await app.ready()
  try {
    // A rename that echoes the stored (orphaned) map back.
    const renamed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/legacy',
      headers: writeHeaders,
      payload: { ...base, displayName: 'Legacy Renamed', providers: ['openai'], providerModels: { gemini: 'gemini-2.5-pro' } },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().displayName).toBe('Legacy Renamed')
    // The orphan is normalized away rather than carried forward.
    expect(renamed.json().providerModels).toEqual({})

    // And a plain write key may still set a value only with settings.write.
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/legacy',
      headers: writeHeaders,
      payload: { ...base, providers: ['openai'], providerModels: { openai: 'gpt-5-nano' } },
    })
    expect(blocked.statusCode).toBe(403)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
