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

  it('bulk set-meta applies plugin meta for writable sites and returns manual for non-writable', async () => {
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
    vi.spyOn(wordpressModule, 'bulkSetSeoMeta').mockResolvedValue({
      env: 'live',
      strategy: 'plugin',
      results: [
        { slug: 'about', status: 'applied' },
        { slug: 'missing-page', status: 'skipped', error: 'Page "missing-page" not found' },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/pages/meta/bulk',
      payload: {
        entries: [
          { slug: 'about', title: 'About Us', description: 'About page' },
          { slug: 'missing-page', title: 'Missing' },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.env).toBe('live')
    expect(body.strategy).toBe('plugin')
    expect(body.results).toHaveLength(2)
    expect(body.results[0]).toMatchObject({ slug: 'about', status: 'applied' })
    expect(body.results[1]).toMatchObject({ slug: 'missing-page', status: 'skipped' })
  })

  it('bulk set-meta rejects empty entries array', async () => {
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/pages/meta/bulk',
      payload: { entries: [] },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'entries array is required and must not be empty',
      },
    })
  })

  it('schema deploy deploys JSON-LD from profile and returns per-slug results', async () => {
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
    vi.spyOn(wordpressModule, 'deploySchemaFromProfile').mockResolvedValue({
      env: 'live',
      results: [
        { slug: 'home', status: 'deployed', schemasInjected: ['Organization', 'LocalBusiness'] },
        { slug: 'faq', status: 'stripped', manualAssist: {
          manualRequired: true,
          targetUrl: 'https://example.com/faq',
          adminUrl: 'https://example.com/wp-admin/',
          content: '{"@type":"FAQPage"}',
          nextSteps: ['Add schema manually.'],
        } },
        { slug: 'nonexistent', status: 'skipped', error: 'Page "nonexistent" not found' },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/schema/deploy',
      payload: {
        profile: {
          business: { name: 'Test Co', url: 'https://example.com' },
          pages: {
            home: ['Organization', 'LocalBusiness'],
            faq: [{ type: 'FAQPage', faqs: [{ q: 'Q?', a: 'A.' }] }],
            nonexistent: ['WebPage'],
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results).toHaveLength(3)
    expect(body.results[0]).toMatchObject({ slug: 'home', status: 'deployed' })
    expect(body.results[1]).toMatchObject({ slug: 'faq', status: 'stripped' })
    expect(body.results[1].manualAssist).toBeDefined()
    expect(body.results[2]).toMatchObject({ slug: 'nonexistent', status: 'skipped' })
  })

  it('schema deploy rejects profiles without business.name', async () => {
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/schema/deploy',
      payload: {
        profile: { business: {}, pages: { home: ['Organization'] } },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('schema deploy rejects profiles with empty pages', async () => {
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/schema/deploy',
      payload: {
        profile: { business: { name: 'Test Co' }, pages: {} },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('schema status returns per-page schema summary', async () => {
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
    vi.spyOn(wordpressModule, 'getSchemaStatus').mockResolvedValue({
      env: 'live',
      pages: [
        { slug: 'home', title: 'Home', canonrySchemas: ['Organization'], thirdPartySchemas: ['WebSite'], hasCanonrySchema: true },
        { slug: 'about', title: 'About', canonrySchemas: [], thirdPartySchemas: [], hasCanonrySchema: false },
      ],
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/test-project/wordpress/schema/status',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pages).toHaveLength(2)
    expect(body.pages[0]).toMatchObject({ slug: 'home', hasCanonrySchema: true })
    expect(body.pages[1]).toMatchObject({ slug: 'about', hasCanonrySchema: false })
  })

  it('onboard runs all steps sequentially and returns step results', async () => {
    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'verifyWordpressConnection').mockResolvedValue({
      url: 'https://example.com',
      reachable: true,
      pageCount: 2,
      version: '6.8.1',
      plugins: [],
      authenticatedUser: { id: 1, slug: 'admin' },
    })
    vi.spyOn(wordpressModule, 'runAudit').mockResolvedValue({
      env: 'live',
      pages: [
        { slug: 'home', title: 'Home', status: 'publish', wordCount: 500, seo: { title: 'Home', description: 'Desc', noindex: false, writable: false, writeTargets: [] }, schemaPresent: false, issues: [] },
        { slug: 'about', title: 'About Us', status: 'publish', wordCount: 300, seo: { title: null, description: null, noindex: false, writable: false, writeTargets: [] }, schemaPresent: false, issues: [] },
      ],
      issues: [
        { slug: 'about', severity: 'medium', code: 'missing-seo-title', message: 'Missing title' },
        { slug: 'about', severity: 'medium', code: 'missing-meta-description', message: 'Missing description' },
      ],
    })
    vi.spyOn(wordpressModule, 'listPages').mockResolvedValue([
      { id: 1, slug: 'home', title: 'Home', status: 'publish', modifiedAt: '2026-03-27T12:00:00Z', link: 'https://example.com/home/' },
      { id: 2, slug: 'about', title: 'About Us', status: 'publish', modifiedAt: '2026-03-27T12:00:00Z', link: 'https://example.com/about-us/team/' },
    ])
    const bulkMetaSpy = vi.spyOn(wordpressModule, 'bulkSetSeoMeta').mockResolvedValue({
      env: 'live',
      strategy: 'manual',
      results: [{ slug: 'about', status: 'manual' }],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/onboard',
      payload: {
        url: 'https://example.com',
        username: 'admin',
        appPassword: 'app-pass',
        skipSchema: true,
        skipSubmit: true,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.projectName).toBe('test-project')
    expect(body.steps).toHaveLength(6)
    expect(body.steps[0]).toMatchObject({ name: 'connect', status: 'completed' })
    expect(body.steps[1]).toMatchObject({ name: 'audit', status: 'completed' })
    expect(body.steps[2]).toMatchObject({ name: 'set-meta', status: 'completed' })
    expect(body.steps[3]).toMatchObject({ name: 'schema-deploy', status: 'skipped' })
    expect(body.steps[4]).toMatchObject({ name: 'google-submit', status: 'skipped' })
    expect(body.steps[5]).toMatchObject({ name: 'bing-submit', status: 'skipped' })

    // P1 fix: set-meta entries must include actual title/description values
    expect(bulkMetaSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ slug: 'about', title: 'About Us', description: 'About Us' }),
      ]),
    )
  })

  it('onboard rejects staging defaultEnv without stagingUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/onboard',
      payload: {
        url: 'https://example.com',
        username: 'admin',
        appPassword: 'app-pass',
        defaultEnv: 'staging',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('stagingUrl')
  })

  it('onboard halts and reports on connection failure', async () => {
    const wordpressModule = await import('@ainyc/canonry-integration-wordpress')
    vi.spyOn(wordpressModule, 'verifyWordpressConnection').mockRejectedValue(
      new WordpressApiError('AUTH_INVALID', 'Authentication failed', 401),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/onboard',
      payload: {
        url: 'https://example.com',
        username: 'admin',
        appPassword: 'wrong-pass',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0]).toMatchObject({ name: 'connect', status: 'failed', error: 'Authentication failed' })
  })

  it('onboard validates required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/onboard',
      payload: { url: 'https://example.com' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('bulk set-meta returns manual-assist results for sites without SEO plugins', async () => {
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
    vi.spyOn(wordpressModule, 'bulkSetSeoMeta').mockResolvedValue({
      env: 'live',
      strategy: 'manual',
      results: [
        {
          slug: 'about',
          status: 'manual',
          manualAssist: {
            manualRequired: true,
            targetUrl: 'https://example.com/about',
            adminUrl: 'https://example.com/wp-admin/',
            content: 'Title: About Us\nDescription: About page',
            nextSteps: [
              'Open the WordPress editor for page "about".',
              'Install an SEO plugin (Yoast SEO, Rank Math, or AIOSEO) to manage meta fields via REST, or set the values manually in the page editor.',
              'Apply the meta values listed above.',
              'Publish/update the page.',
            ],
          },
        },
      ],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/wordpress/pages/meta/bulk',
      payload: {
        entries: [
          { slug: 'about', title: 'About Us', description: 'About page' },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.strategy).toBe('manual')
    expect(body.results[0].status).toBe('manual')
    expect(body.results[0].manualAssist).toBeDefined()
    expect(body.results[0].manualAssist.manualRequired).toBe(true)
  })
})
