import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'

import { apiRoutes } from '../src/index.js'

/**
 * Generating queries calls an answer provider, so its failures are provider
 * failures. The route used to catch every one of them and rethrow
 * `internalError`, so a bad key, a rate limit, and a dropped connection all
 * reached the dashboard as `INTERNAL_ERROR`.
 *
 * That is what made the onboarding funnel's queries step report `reasonCode:
 * unknown` for every block, on the one step where nobody who hit it went on to
 * complete a run. The classification exists at both ends; this boundary was
 * throwing it away.
 */

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function generateWith(error: Error) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-generation-errors-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  await app.register(apiRoutes, {
    db,
    skipAuth: true,
    onGenerateQueries: () => Promise.reject(error),
  })
  await app.ready()
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const created = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/acme',
    payload: { displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en' },
  })
  expect(created.statusCode).toBeLessThan(400)

  return app.inject({
    method: 'POST',
    url: '/api/v1/projects/acme/queries/generate',
    payload: { provider: 'gemini', count: 3 },
  })
}

describe('query generation preserves the provider failure kind', () => {
  it('reports a rate limit as a quota failure, not an internal error', async () => {
    const response = await generateWith(new Error('429 Too Many Requests: rate limit exceeded'))
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED')
  })

  it('reports a bad provider key without signing the user out', async () => {
    // Deliberately NOT 401/AUTH_INVALID. The dashboard's response interceptor
    // treats any 401 as an expired session, so reusing it here would log a user
    // out of their own instance because their Gemini key went stale.
    const response = await generateWith(new Error('401 Unauthorized: invalid api key'))
    expect(response.json().error.code).toBe('PROVIDER_AUTH')
    expect(response.statusCode).toBe(502)
  })

  it('reports an account out of credit as an account problem, not an internal error', async () => {
    const response = await generateWith(new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    ))
    expect(response.json().error.code).toBe('PROVIDER_AUTH')
    expect(response.json().error.message).toMatch(/credit balance is too low/)
  })

  it('reports a dropped connection as an upstream failure', async () => {
    const response = await generateWith(new Error('fetch failed: ECONNRESET'))
    expect(response.json().error.code).toBe('PROVIDER_ERROR')
  })

  it('still reports an unrecognized failure as ours to explain', async () => {
    const response = await generateWith(new Error('something nobody has classified'))
    expect(response.json().error.code).toBe('INTERNAL_ERROR')
  })
})
