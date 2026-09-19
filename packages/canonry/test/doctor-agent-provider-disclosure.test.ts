/**
 * Doctor must not hand out the agent configuration the agent routes withhold.
 *
 * `GET /agent/providers` serves a non-administrator an EMPTY catalog, on the
 * stated grounds that even a trimmed list says which providers exist and which
 * one is configured, which is most of the answer. The `config.agent-providers`
 * doctor check says exactly that, and `GET /doctor` carries no administrator
 * gate: the generic role gate refuses a viewer only on write methods, so the
 * read is open to every signed-in analyst and every narrow API key.
 *
 * These tests run through `createServer`, so they exercise the real auth
 * plugin, a real cookie, and real minted keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, users, type DatabaseClient } from '@ainyc/canonry-db'
import { hashUserPassword } from '@ainyc/canonry-api-routes'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'

/** The configured agent provider, and the label that names its models. */
const CONFIGURED_PROVIDER = 'deepinfra'
const PROVIDER_LABEL = 'DeepInfra'

const AGENT_PROVIDERS_CHECK = 'config.agent-providers'

interface CheckRow {
  id: string
  status: string
  summary: string
  details?: unknown
}

describe('the agent provider configuration is not disclosed through doctor', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let apiKey: string

  async function addAccount(name: string, role: 'admin' | 'viewer', password: string): Promise<void> {
    db.insert(users).values({
      id: crypto.randomUUID(),
      name,
      nameKey: name.toLowerCase(),
      passwordHash: await hashUserPassword(password),
      role,
      createdAt: new Date().toISOString(),
    }).run()
  }

  async function signIn(name: string, password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { name, password },
    })
    expect(res.statusCode).toBe(200)
    return res.cookies.map(({ name: n, value }) => `${n}=${value}`).join('; ')
  }

  async function mintKey(name: string, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name, scopes },
    })
    expect(res.statusCode).toBe(200)
    return (res.json() as { key: string }).key
  }

  function doctorAsSession(cookie: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/doctor?check=${AGENT_PROVIDERS_CHECK}`,
      headers: { cookie, origin: ORIGIN, host: HOST },
    })
  }

  function doctorAsKey(key: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/doctor?check=${AGENT_PROVIDERS_CHECK}`,
      headers: { authorization: `Bearer ${key}` },
    })
  }

  const checkFrom = (body: string): CheckRow | undefined =>
    (JSON.parse(body) as { checks: CheckRow[] }).checks.find(c => c.id === AGENT_PROVIDERS_CHECK)

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-agent-disclosure-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)
    apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    app = await createServer({
      config: {
        apiUrl: ORIGIN,
        database: dbPath,
        apiKey,
        providers: { [CONFIGURED_PROVIDER]: { apiKey: 'deepinfra-key' } },
      } as CanonryConfig,
      db,
      logger: false,
    })

    await addAccount('owner', 'admin', ADMIN_PASSWORD)
    await addAccount('analyst', 'viewer', VIEWER_PASSWORD)
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('tells a signed-in viewer nothing about which agent provider is configured', async () => {
    const res = await doctorAsSession(await signIn('analyst', VIEWER_PASSWORD))

    expect(res.statusCode).toBe(200)
    // Whole-body scan: the provider id and its label must not appear anywhere,
    // in a summary, in details, or in a remediation hint that names the key.
    expect(res.body).not.toContain(CONFIGURED_PROVIDER)
    expect(res.body).not.toContain(PROVIDER_LABEL)
  })

  it('does not tell a viewer that a key is configured at all', async () => {
    const res = await doctorAsSession(await signIn('analyst', VIEWER_PASSWORD))

    const check = checkFrom(res.body)
    expect(check).toBeDefined()
    // "1 of 5 configured" is most of the answer even with the name removed.
    expect(check!.summary).not.toMatch(/\d+ of \d+/)
    expect(check!.details).toBeUndefined()
  })

  it('tells a narrow API key nothing either', async () => {
    const readOnly = await mintKey('reader', ['read'])

    const res = await doctorAsKey(readOnly)

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(CONFIGURED_PROVIDER)
    expect(res.body).not.toContain(PROVIDER_LABEL)
  })

  it('still tells a signed-in administrator everything', async () => {
    const res = await doctorAsSession(await signIn('owner', ADMIN_PASSWORD))

    expect(res.statusCode).toBe(200)
    const check = checkFrom(res.body)
    expect(check!.status).toBe('ok')
    expect(check!.summary).toContain(CONFIGURED_PROVIDER)
    expect(check!.details).toBeDefined()
  })

  it('still tells the install root key everything, so the CLI doctor is unaffected', async () => {
    const res = await doctorAsKey(apiKey)

    expect(res.statusCode).toBe(200)
    const check = checkFrom(res.body)
    expect(check!.status).toBe('ok')
    expect(check!.summary).toContain(CONFIGURED_PROVIDER)
  })
})
