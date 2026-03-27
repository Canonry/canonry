import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { WordpressApiError } from '@ainyc/canonry-integration-wordpress'
import { apiRoutes } from '../src/index.js'
import type { WordpressConnectionStore } from '../src/wordpress.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const connections = new Map<string, {
    projectName: string
    url: string
    stagingUrl?: string
    username: string
    appPassword: string
    defaultEnv: 'live' | 'staging'
    createdAt: string
    updatedAt: string
  }>()

  const wordpressConnectionStore: WordpressConnectionStore = {
    getConnection: (projectName) => connections.get(projectName),
    upsertConnection: (connection) => {
      connections.set(connection.projectName, connection)
      return connection
    },
    updateConnection: (projectName, patch) => {
      const existing = connections.get(projectName)
      if (!existing) return undefined
      const next = { ...existing, ...patch }
      connections.set(projectName, next)
      return next
    },
    deleteConnection: (projectName) => connections.delete(projectName),
  }

  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    wordpressConnectionStore,
  })

  return { app, db, tmpDir, connections }
}

describe('WordPress routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let connections: Map<string, {
    projectName: string
    url: string
    stagingUrl?: string
    username: string
    appPassword: string
    defaultEnv: 'live' | 'staging'
    createdAt: string
    updatedAt: string
  }>

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    connections = ctx.connections
    await app.ready()

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: crypto.randomUUID(),
      name: 'test-project',
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      tags: '[]',
      labels: '{}',
      providers: '[]',
      locations: '[]',
      defaultLocation: null,
      configSource: 'cli',
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  beforeEach(() => {
    connections.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('connects, reports status, and disconnects a project-scoped WordPress connection', async () => {
    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'verifyWordpressConnection').mockResolvedValue({
      url: 'https://example.com',
      reachable: true,
      pageCount: 12,
      version: '6.8.1',
      plugins: [],
      authenticatedUser: { id: 1, slug: 'admin' },
    })
    vi.spyOn(wordpressModule, 'getSiteStatus').mockResolvedValue({
      url: 'https://example.com',
      reachable: true,
      pageCount: 12,
      version: '6.8.1',
      plugins: ['wordpress-seo/wp-seo.php'],
      authenticatedUser: { id: 1, slug: 'admin' },
    })

    const connectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/connect',
      payload: {
        url: 'https://example.com/',
        username: 'admin',
        appPassword: 'app-pass',
      },
    })

    expect(connectRes.statusCode).toBe(200)
    expect(connectRes.json()).toMatchObject({
      connected: true,
      projectName: 'test-project',
      defaultEnv: 'live',
    })
    expect(connections.get('test-project')).toMatchObject({
      projectName: 'test-project',
      url: 'https://example.com/',
      username: 'admin',
    })

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/wordpress/status',
    })

    expect(statusRes.statusCode).toBe(200)
    expect(statusRes.json()).toMatchObject({
      connected: true,
      projectName: 'test-project',
      live: {
        reachable: true,
        pageCount: 12,
      },
    })

    const disconnectRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/test-project/wordpress/disconnect',
    })

    expect(disconnectRes.statusCode).toBe(204)
    expect(connections.has('test-project')).toBe(false)
  })

  it('returns an actionable error when wordpress connect fails with invalid credentials', async () => {
    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'verifyWordpressConnection').mockRejectedValue(
      new WordpressApiError(
        'AUTH_INVALID',
        'Authentication failed — the username or application password is incorrect. Verify the app password belongs to the user specified with --user.',
        401,
      ),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/connect',
      payload: {
        url: 'https://example.com/',
        username: 'admin',
        appPassword: 'app-pass',
      },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({
      error: {
        code: 'AUTH_INVALID',
        message: 'Authentication failed — the username or application password is incorrect. Verify the app password belongs to the user specified with --user.',
      },
    })
  })

  it('passes the requested environment through page listing routes', async () => {
    const now = new Date().toISOString()
    connections.set('test-project', {
      projectName: 'test-project',
      url: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
      username: 'admin',
      appPassword: 'app-pass',
      defaultEnv: 'staging',
      createdAt: now,
      updatedAt: now,
    })

    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    const listPagesSpy = vi.spyOn(wordpressModule, 'listPages').mockResolvedValue([
      {
        id: 1,
        slug: 'about',
        title: 'About',
        status: 'publish',
        modifiedAt: '2026-03-27T12:00:00Z',
        link: 'https://staging.example.com/about/',
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/wordpress/pages?env=staging',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      env: 'staging',
      pages: [
        {
          id: 1,
          slug: 'about',
          title: 'About',
          status: 'publish',
          modifiedAt: '2026-03-27T12:00:00Z',
          link: 'https://staging.example.com/about/',
        },
      ],
    })
    expect(listPagesSpy).toHaveBeenCalledWith(expect.objectContaining({ projectName: 'test-project' }), 'staging')
  })

  it('serializes unsupported SEO meta updates as validation errors', async () => {
    const now = new Date().toISOString()
    connections.set('test-project', {
      projectName: 'test-project',
      url: 'https://example.com',
      username: 'admin',
      appPassword: 'app-pass',
      defaultEnv: 'live',
      createdAt: now,
      updatedAt: now,
    })

    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'setSeoMeta').mockRejectedValue(
      new WordpressApiError(
        'UNSUPPORTED',
        'This WordPress site does not expose writable SEO meta fields through REST.',
        400,
      ),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/page/meta',
      payload: {
        slug: 'about',
        title: 'New SEO Title',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'This WordPress site does not expose writable SEO meta fields through REST.',
      },
    })
  })

  it('rejects invalid env values in POST bodies before they reach the client', async () => {
    const now = new Date().toISOString()
    connections.set('test-project', {
      projectName: 'test-project',
      url: 'https://example.com',
      username: 'admin',
      appPassword: 'app-pass',
      defaultEnv: 'live',
      createdAt: now,
      updatedAt: now,
    })

    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    const createPageSpy = vi.spyOn(wordpressModule, 'createPage')

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/pages',
      payload: {
        title: 'About',
        slug: 'about',
        content: '<p>About</p>',
        env: 'production',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'env must be "live" or "staging"',
      },
    })
    expect(createPageSpy).not.toHaveBeenCalled()
  })

  it('returns structured live vs staging diffs', async () => {
    const now = new Date().toISOString()
    connections.set('test-project', {
      projectName: 'test-project',
      url: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
      username: 'admin',
      appPassword: 'app-pass',
      defaultEnv: 'live',
      createdAt: now,
      updatedAt: now,
    })

    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'diffPageAcrossEnvironments').mockResolvedValue({
      slug: 'pricing',
      live: {
        id: 1,
        slug: 'pricing',
        title: 'Pricing',
        status: 'publish',
        modifiedAt: '2026-03-27T12:00:00Z',
        link: 'https://example.com/pricing/',
        env: 'live',
        content: '<p>Live</p>',
        seo: { title: 'Pricing', description: null, noindex: false, writable: false, writeTargets: [] },
        schemaBlocks: [],
        contentHash: 'a'.repeat(64),
        contentSnippet: 'Live',
      },
      staging: {
        id: 2,
        slug: 'pricing',
        title: 'Pricing Updated',
        status: 'publish',
        modifiedAt: '2026-03-27T13:00:00Z',
        link: 'https://staging.example.com/pricing/',
        env: 'staging',
        content: '<p>Staging</p>',
        seo: { title: 'Pricing Updated', description: null, noindex: false, writable: false, writeTargets: [] },
        schemaBlocks: [],
        contentHash: 'b'.repeat(64),
        contentSnippet: 'Staging',
      },
      hasDifferences: true,
      differences: {
        title: true,
        slug: false,
        content: true,
        seoTitle: true,
        seoDescription: false,
        noindex: false,
        schema: false,
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/wordpress/diff?slug=pricing',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      slug: 'pricing',
      hasDifferences: true,
      differences: {
        title: true,
        content: true,
      },
      live: {
        contentHash: 'a'.repeat(64),
      },
      staging: {
        contentHash: 'b'.repeat(64),
      },
    })
  })

  it('returns manual staging push instructions instead of performing a push', async () => {
    const now = new Date().toISOString()
    connections.set('test-project', {
      projectName: 'test-project',
      url: 'https://example.com',
      stagingUrl: 'https://staging.example.com',
      username: 'admin',
      appPassword: 'app-pass',
      defaultEnv: 'staging',
      createdAt: now,
      updatedAt: now,
    })

    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'buildManualStagingPush').mockResolvedValue({
      manualRequired: true,
      targetUrl: 'https://example.com/wp-admin/admin.php?page=wpstg_clone',
      adminUrl: 'https://example.com/wp-admin/admin.php?page=wpstg_clone',
      content: '{"liveUrl":"https://example.com"}',
      nextSteps: ['Open the WP STAGING admin page on the live site.'],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/staging/push',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      manualRequired: true,
      targetUrl: 'https://example.com/wp-admin/admin.php?page=wpstg_clone',
      adminUrl: 'https://example.com/wp-admin/admin.php?page=wpstg_clone',
      content: '{"liveUrl":"https://example.com"}',
      nextSteps: ['Open the WP STAGING admin page on the live site.'],
    })
  })
})
