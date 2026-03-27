import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WordpressConnectionRecord } from '../src/index.js'
import {
  WordpressApiError,
  diffPageAcrossEnvironments,
  getPageDetail,
  runAudit,
  setSeoMeta,
  verifyWordpressConnection,
} from '../src/index.js'

function createConnection(overrides: Partial<WordpressConnectionRecord> = {}): WordpressConnectionRecord {
  return {
    projectName: 'test-project',
    url: 'https://example.com',
    stagingUrl: 'https://staging.example.com',
    username: 'admin',
    appPassword: 'app-pass',
    defaultEnv: 'live',
    createdAt: '2026-03-27T00:00:00Z',
    updatedAt: '2026-03-27T00:00:00Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })
}

describe('wordpress client', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('extracts rendered SEO and schema for a page', async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/wp-json/wp/v2/plugins')) {
        return jsonResponse([
          { plugin: 'wordpress-seo/wp-seo.php', status: 'active' },
        ])
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=hello-world')) {
        return jsonResponse([
          {
            id: 42,
            slug: 'hello-world',
            status: 'publish',
            link: 'https://example.com/hello-world/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'Hello World' },
            content: { raw: '<p>Hello world content.</p>' },
            meta: {
              _yoast_wpseo_title: 'SEO Title',
              _yoast_wpseo_metadesc: 'SEO Description',
              _yoast_wpseo_meta_robots_noindex: '0',
            },
          },
        ])
      }
      if (url === 'https://example.com/hello-world/') {
        return new Response(`
          <html>
            <head>
              <title>Hello World SEO</title>
              <meta name="description" content="Rendered description" />
              <meta name="robots" content="index,follow" />
              <script type="application/ld+json">
                {"@context":"https://schema.org","@type":"Article","headline":"Hello World"}
              </script>
            </head>
            <body>Hello</body>
          </html>
        `, { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const detail = await getPageDetail(createConnection(), 'hello-world', 'live')
    expect(detail.title).toBe('Hello World')
    expect(detail.seo.title).toBe('Hello World SEO')
    expect(detail.seo.description).toBe('Rendered description')
    expect(detail.seo.noindex).toBe(false)
    expect(detail.seo.writable).toBe(true)
    expect(detail.seo.writeTargets).toContain('_yoast_wpseo_title')
    expect(detail.schemaBlocks).toEqual([
      {
        type: 'Article',
        json: {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: 'Hello World',
        },
      },
    ])
  })

  it('rejects SEO writes when REST meta fields are unavailable', async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/wp-json/wp/v2/plugins')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=about')) {
        return jsonResponse([
          {
            id: 7,
            slug: 'about',
            status: 'publish',
            link: 'https://example.com/about/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
            content: { raw: '<p>About us</p>' },
            meta: {},
          },
        ])
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    await expect(() => setSeoMeta(createConnection(), 'about', { title: 'New SEO Title' }, 'live')).rejects.toMatchObject({
      name: 'WordpressApiError',
      code: 'UNSUPPORTED',
    } satisfies Partial<WordpressApiError>)
  })

  it('prioritizes audit issues for published thin noindex pages', async () => {
    let pluginFetchCount = 0
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/wp-json/wp/v2/pages?per_page=100&page=1')) {
        return jsonResponse([
          {
            id: 11,
            slug: 'thin-page',
            status: 'publish',
            link: 'https://example.com/thin-page/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'Thin Page' },
          },
        ], {
          headers: {
            'x-wp-totalpages': '1',
          },
        })
      }
      if (url.includes('/wp-json/wp/v2/plugins')) {
        pluginFetchCount += 1
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=thin-page')) {
        return jsonResponse([
          {
            id: 11,
            slug: 'thin-page',
            status: 'publish',
            link: 'https://example.com/thin-page/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'Thin Page' },
            content: { raw: '<p>Short copy only.</p>' },
            meta: {},
          },
        ])
      }
      if (url === 'https://example.com/thin-page/') {
        return new Response(`
          <html>
            <head>
              <title>Thin Page</title>
              <meta name="robots" content="noindex,follow" />
            </head>
            <body>Short copy only.</body>
          </html>
        `, { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const audit = await runAudit(createConnection(), 'live')
    expect(audit.pages).toHaveLength(1)
    expect(audit.issues.map((issue) => issue.code)).toEqual([
      'noindex',
      'missing-meta-description',
      'missing-schema',
      'thin-content',
    ])
    expect(pluginFetchCount).toBe(1)
  })

  it('computes live vs staging diffs with hashes and snippets', async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/wp-json/wp/v2/plugins')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('https://example.com/wp-json/wp/v2/pages?slug=pricing')) {
        return jsonResponse([
          {
            id: 21,
            slug: 'pricing',
            status: 'publish',
            link: 'https://example.com/pricing/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'Pricing' },
            content: { raw: '<p>Live pricing content</p>' },
            meta: {},
          },
        ])
      }
      if (url.includes('https://staging.example.com/wp-json/wp/v2/pages?slug=pricing')) {
        return jsonResponse([
          {
            id: 22,
            slug: 'pricing',
            status: 'publish',
            link: 'https://staging.example.com/pricing/',
            modified: '2026-03-27T13:00:00Z',
            title: { rendered: 'Pricing Updated' },
            content: { raw: '<p>Staging pricing content with more detail</p>' },
            meta: {},
          },
        ])
      }
      if (url === 'https://example.com/pricing/') {
        return new Response('<html><head><title>Pricing</title></head><body>Live pricing content</body></html>', { status: 200 })
      }
      if (url === 'https://staging.example.com/pricing/') {
        return new Response('<html><head><title>Pricing Updated</title></head><body>Staging pricing content with more detail</body></html>', { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const diff = await diffPageAcrossEnvironments(createConnection(), 'pricing')
    expect(diff.hasDifferences).toBe(true)
    expect(diff.differences.title).toBe(true)
    expect(diff.differences.content).toBe(true)
    expect(diff.live.contentHash).toHaveLength(64)
    expect(diff.staging.contentHash).toHaveLength(64)
    expect(diff.live.contentSnippet).toContain('Live pricing content')
    expect(diff.staging.contentSnippet).toContain('Staging pricing content')
  })

  it('verifies connections without requesting edit context', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
      if (url.includes('/wp-json/wp/v2/users/me?')) {
        return jsonResponse({ id: 1, slug: 'admin' })
      }
      if (url.includes('/wp-json/wp/v2/pages?')) {
        return jsonResponse([], {
          headers: {
            'x-wp-total': '0',
            'x-wp-totalpages': '1',
          },
        })
      }
      if (url === 'https://example.com' || url === 'https://example.com/') {
        return new Response('<meta name="generator" content="WordPress 6.8.1" />', { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    await verifyWordpressConnection(createConnection())

    const authRequest = requestedUrls.find((url) => url.includes('/wp-json/wp/v2/users/me?'))
    const pageSummaryRequest = requestedUrls.find((url) => url.includes('/wp-json/wp/v2/pages?'))
    expect(authRequest).toBeTruthy()
    expect(authRequest).not.toContain('context=edit')
    expect(pageSummaryRequest).toBeTruthy()
    expect(pageSummaryRequest).toContain('context=view')
    expect(pageSummaryRequest).not.toContain('context=edit')
  })

  it('returns an actionable error message when auth fails on connect', async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/wp-json/wp/v2/users/me?')) {
        return new Response(
          JSON.stringify({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 },
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
            },
          },
        )
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    await expect(() => verifyWordpressConnection(createConnection())).rejects.toMatchObject({
      name: 'WordpressApiError',
      code: 'AUTH_INVALID',
      message: expect.stringContaining('Authentication failed'),
    } satisfies Partial<WordpressApiError>)

    await expect(() => verifyWordpressConnection(createConnection())).rejects.toThrow(
      'application password is incorrect',
    )
  })
})
