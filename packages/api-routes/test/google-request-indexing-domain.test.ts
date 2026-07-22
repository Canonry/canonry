/**
 * `allUnindexed` must gather only URLs the Indexing API can accept.
 *
 * Inspection history accumulates hosts that are no longer submittable: URLs
 * from a domain the project has migrated off (which now 301 to the canonical
 * host), and subdomains that a `sc-domain:` property legitimately reports. The
 * gather step used to collect every inspected URL and the canonical-domain
 * check then rejected the whole batch, so a single stale row made the endpoint
 * permanently unusable on a migrated project — it gathered URLs it would then
 * refuse. These tests pin the filter, and pin that an explicitly-supplied
 * off-domain URL is still a loud error rather than being silently dropped.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { createClient, migrate, projects, gscUrlInspections } from '@ainyc/canonry-db'
import { AppError } from '@ainyc/canonry-contracts'
import { googleRoutes } from '../src/google.js'

const PROJECT_ID = 'p-indexing-domain'
const PROJECT_NAME = 'migrated-site'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-indexing-domain-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  db.insert(projects).values({
    id: PROJECT_ID,
    name: PROJECT_NAME,
    displayName: 'Migrated Site',
    // The project moved here from a previous domain.
    canonicalDomain: 'canonical.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    throw error
  })
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({ clientId: 'id', clientSecret: 'secret' }),
    googleConnectionStore: {
      listConnections: () => [],
      // A live GSC connection, so the route reaches the URL-gathering step.
      getConnection: () => ({
        domain: 'canonical.example',
        connectionType: 'gsc' as const,
        propertyId: 'sc-domain:canonical.example',
        accessToken: 'token',
        refreshToken: 'refresh',
        tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: [],
        createdAt: now,
        updatedAt: now,
      }),
      upsertConnection: (c) => c,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
    googleStateSecret: 'test-secret-32-bytes-long-enough!',
  })

  return { app, db, tmpDir }
}

function seedInspection(db: ReturnType<typeof createClient>, url: string, state: string): void {
  const now = new Date().toISOString()
  db.insert(gscUrlInspections).values({
    id: `insp-${Buffer.from(url).toString('base64url').slice(0, 24)}`,
    projectId: PROJECT_ID,
    url,
    indexingState: state,
    inspectedAt: now,
    createdAt: now,
  }).run()
}

async function requestIndexing(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/projects/${PROJECT_NAME}/google/indexing/request`,
    payload: body,
  })
}

describe('request-indexing: allUnindexed gathers only submittable URLs', () => {
  let ctx: ReturnType<typeof buildApp>

  beforeEach(() => { ctx = buildApp() })
  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('skips a previous domain the project migrated away from', async () => {
    seedInspection(ctx.db, 'https://previous.example/blog/one', 'NOT_INDEXED')
    seedInspection(ctx.db, 'https://canonical.example/blog/one', 'NOT_INDEXED')

    const res = await requestIndexing(ctx.app, { allUnindexed: true })

    // The stale host must not surface as a validation failure. Before the fix
    // this returned 400 "URLs must belong to project domain". Assert the
    // specific rejection is gone rather than "not 400", which a 404 satisfies.
    expect(res.body).not.toContain('must belong to project domain')
    expect(res.body).not.toContain('previous.example')
  })

  it('skips a subdomain that a sc-domain property reports', async () => {
    seedInspection(ctx.db, 'https://app.canonical.example/', 'NOT_INDEXED')
    seedInspection(ctx.db, 'https://canonical.example/blog/one', 'NOT_INDEXED')

    const res = await requestIndexing(ctx.app, { allUnindexed: true })

    expect(res.body).not.toContain('must belong to project domain')
    expect(res.body).not.toContain('app.canonical.example')
  })

  it('says so plainly when every unindexed URL is on another host', async () => {
    seedInspection(ctx.db, 'https://previous.example/blog/one', 'NOT_INDEXED')
    seedInspection(ctx.db, 'https://app.canonical.example/', 'NOT_INDEXED')

    const res = await requestIndexing(ctx.app, { allUnindexed: true })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: { message: string } }
    // The operator needs to know the rows existed but were not submittable,
    // not just "none found".
    expect(body.error.message).toContain('canonical.example')
    expect(body.error.message).toContain('skipped 2')
  })

  it('still ignores URLs that are already indexed', async () => {
    seedInspection(ctx.db, 'https://canonical.example/indexed', 'INDEXING_ALLOWED')

    const res = await requestIndexing(ctx.app, { allUnindexed: true })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: { message: string } }
    expect(body.error.message).toContain('No unindexed URLs found')
    // Nothing was skipped for host reasons, so the message must not claim it.
    expect(body.error.message).not.toContain('skipped')
  })

  it('rejects an off-domain URL the caller supplied explicitly', async () => {
    // Filtering is for the gathered set only. A URL the caller typed is a
    // real mistake and must still be reported rather than silently dropped.
    const res = await requestIndexing(ctx.app, {
      urls: ['https://canonical.example/ok', 'https://elsewhere.example/nope'],
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: { message: string } }
    expect(body.error.message).toContain('elsewhere.example')
  })
})
