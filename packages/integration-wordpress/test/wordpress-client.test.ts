import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WordpressConnectionRecord } from '../src/index.js'
import {
  WordpressApiError,
  deploySchemaFromProfile,
  diffPageAcrossEnvironments,
  getPageDetail,
  runAudit,
  setSeoMeta,
  stripCanonrySchema,
  injectCanonrySchema,
  listActivePlugins,
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
    expect(detail).toEqual({
      id: 42,
      slug: 'hello-world',
      title: 'Hello World',
      status: 'publish',
      modifiedAt: '2026-03-27T12:00:00Z',
      link: 'https://example.com/hello-world/',
      env: 'live',
      content: '<p>Hello world content.</p>',
      seo: {
        title: 'Hello World SEO',
        description: 'Rendered description',
        noindex: false,
        writable: true,
        writeTargets: ['_yoast_wpseo_title', '_yoast_wpseo_metadesc'],
      },
      schemaBlocks: [{
        type: 'Article',
        json: {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: 'Hello World',
        },
      }],
    })
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
    const cases = [
      {
        status: 'draft', wordCount: 0, content: '', completeMetadata: true,
        issues: [{ slug: 'audit-page', severity: 'low', code: 'thin-content',
          message: 'Page content is thin (0 words; target at least 250).' }],
      },
      {
        status: 'publish', wordCount: 3, content: 'Short copy only.', completeMetadata: false,
        issues: [
          { slug: 'audit-page', severity: 'high', code: 'noindex', message: 'Published page is marked noindex.' },
          { slug: 'audit-page', severity: 'medium', code: 'missing-meta-description', message: 'Rendered meta description is missing.' },
          { slug: 'audit-page', severity: 'medium', code: 'missing-schema', message: 'No JSON-LD schema was detected on the rendered page.' },
          { slug: 'audit-page', severity: 'low', code: 'thin-content', message: 'Page content is thin (3 words; target at least 250).' },
        ],
      },
      {
        status: 'publish', wordCount: 249, content: Array(249).fill('word').join(' '), completeMetadata: true,
        issues: [
          { slug: 'audit-page', severity: 'high', code: 'noindex', message: 'Published page is marked noindex.' },
          { slug: 'audit-page', severity: 'low', code: 'thin-content', message: 'Page content is thin (249 words; target at least 250).' },
        ],
      },
      {
        status: 'publish', wordCount: 250, content: Array(250).fill('word').join(' '), completeMetadata: true,
        issues: [{ slug: 'audit-page', severity: 'high', code: 'noindex', message: 'Published page is marked noindex.' }],
      },
      {
        status: 'draft', wordCount: 249, content: Array(249).fill('word').join(' '), completeMetadata: true,
        issues: [{ slug: 'audit-page', severity: 'low', code: 'thin-content', message: 'Page content is thin (249 words; target at least 250).' }],
      },
      { status: 'draft', wordCount: 250, content: Array(250).fill('word').join(' '), completeMetadata: true, issues: [] },
    ]
    for (const fixture of cases) {
      let pluginFetchCount = 0
      const page = {
        id: 11, slug: 'audit-page', status: fixture.status,
        link: 'https://example.com/audit-page/', modified: '2026-03-27T12:00:00Z',
        title: { rendered: 'Audit Page' }, content: { raw: `<p>${fixture.content}</p>` }, meta: {},
      }
      globalThis.fetch = async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/wp-json/wp/v2/pages?per_page=100&page=1')) {
          return jsonResponse([page], { headers: { 'x-wp-totalpages': '1' } })
        }
        if (url.includes('/wp-json/wp/v2/plugins')) {
          pluginFetchCount += 1
          return new Response('Not found', { status: 404 })
        }
        if (url.includes('/wp-json/wp/v2/pages?slug=audit-page')) return jsonResponse([page])
        if (url === 'https://example.com/audit-page/') {
          return new Response('<title>Audit Page</title><meta name="robots" content="noindex,follow" />'
            + (fixture.completeMetadata
              ? '<meta name="description" content="Description" /><script type="application/ld+json">{"@type":"WebPage"}</script>'
              : '')
            + `<p>${fixture.content}</p>`, { status: 200 })
        }
        throw new Error(`Unhandled URL: ${url}`)
      }
      const audit = await runAudit(createConnection(), 'live')
      expect(audit).toEqual({
        env: 'live',
        pages: [{
          slug: 'audit-page', title: 'Audit Page', status: fixture.status, wordCount: fixture.wordCount,
          seo: { title: 'Audit Page', description: fixture.completeMetadata ? 'Description' : null,
            noindex: true, writable: false, writeTargets: [] },
          schemaPresent: fixture.completeMetadata, issues: fixture.issues,
        }],
        issues: fixture.issues,
      })
      expect(pluginFetchCount).toBe(1)
    }
  })

  it('computes live vs staging diffs with hashes and snippets', async () => {
    let identical = false
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
            title: { rendered: identical ? 'Pricing' : 'Pricing Updated' },
            content: { raw: identical ? '<p>Live pricing content</p>' : '<p>Staging pricing content with more detail</p>' },
            meta: {},
          },
        ])
      }
      if (url === 'https://example.com/pricing/') {
        return new Response('<html><head><title>Pricing</title></head><body>Live pricing content</body></html>', { status: 200 })
      }
      if (url === 'https://staging.example.com/pricing/') {
        return new Response(identical
          ? '<html><head><title>Pricing</title></head><body>Live pricing content</body></html>'
          : '<html><head><title>Pricing Updated</title></head><body>Staging pricing content with more detail</body></html>', { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const diff = await diffPageAcrossEnvironments(createConnection(), 'pricing')
    expect(diff.hasDifferences).toBe(true)
    expect(diff.differences).toEqual({
      title: true, slug: false, content: true, seoTitle: true,
      seoDescription: false, noindex: false, schema: false,
    })
    expect(diff.live.contentHash).toBe('71c115369f68c0113e3526b6f9e7840b44e07da5d659f95600a3902e5220a41b')
    expect(diff.staging.contentHash).toBe('9aa626505ebb36b3fe876916499fad3621788e25b97f8b48c65b6d0c2f66595a')
    expect(diff.live.contentSnippet).toBe('Live pricing content')
    expect(diff.staging.contentSnippet).toBe('Staging pricing content with more detail')

    identical = true
    const unchanged = await diffPageAcrossEnvironments(createConnection(), 'pricing')
    expect(unchanged.hasDifferences).toBe(false)
    expect(unchanged.differences).toEqual({
      title: false, slug: false, content: false, seoTitle: false,
      seoDescription: false, noindex: false, schema: false,
    })
    expect([unchanged.live.contentHash, unchanged.staging.contentHash]).toEqual([
      '71c115369f68c0113e3526b6f9e7840b44e07da5d659f95600a3902e5220a41b',
      '71c115369f68c0113e3526b6f9e7840b44e07da5d659f95600a3902e5220a41b',
    ])
    expect([unchanged.live.contentSnippet, unchanged.staging.contentSnippet]).toEqual([
      'Live pricing content', 'Live pricing content',
    ])
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

  describe('stripCanonrySchema', () => {
    it('removes only canonry-marked schema blocks', () => {
      const content = [
        '<p>Hello</p>',
        '<!-- canonry:schema:start -->',
        '<script type="application/ld+json">{"@type":"Organization"}</script>',
        '<!-- canonry:schema:end -->',
        '<script type="application/ld+json">{"@type":"WebSite"}</script>',
      ].join('\n')

      const result = stripCanonrySchema(content)
      expect(result).not.toContain('canonry:schema:start')
      expect(result).not.toContain('Organization')
      expect(result).toContain('WebSite')
      expect(result).toContain('<p>Hello</p>')
    })

    it('returns content unchanged when no canonry markers present', () => {
      const content = '<p>Hello</p>\n<script type="application/ld+json">{"@type":"WebSite"}</script>'
      expect(stripCanonrySchema(content)).toBe(content)
    })

    it('handles multiple canonry blocks', () => {
      const content = [
        '<!-- canonry:schema:start -->',
        '<script type="application/ld+json">{"@type":"A"}</script>',
        '<!-- canonry:schema:end -->',
        '<p>Middle</p>',
        '<!-- canonry:schema:start -->',
        '<script type="application/ld+json">{"@type":"B"}</script>',
        '<!-- canonry:schema:end -->',
      ].join('\n')

      const result = stripCanonrySchema(content)
      expect(result).not.toContain('@type')
      expect(result).toContain('<p>Middle</p>')
    })
  })

  describe('injectCanonrySchema', () => {
    it('appends marked schema blocks to content', () => {
      const content = '<p>Hello</p>'
      const schemas = [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Test' }]
      const result = injectCanonrySchema(content, schemas)

      expect(result).toContain('<!-- canonry:schema:start -->')
      expect(result).toContain('<!-- canonry:schema:end -->')
      expect(result).toContain('"@type":"Organization"')
      expect(result).toContain('<p>Hello</p>')
    })

    it('escapes </script> sequences in schema values to prevent XSS', () => {
      const maliciousName = 'evil</script><script>alert(1)</script>'
      const result = injectCanonrySchema('<p>Hello</p>', [{ name: maliciousName }])
      expect(result).not.toContain('</script><script>')
      expect(result.match(/<script type="application\/ld\+json">/g)).toHaveLength(1)
      expect(result.match(/<\/script>/g)).toHaveLength(1)
      expect(result.match(/<!-- canonry:schema:start -->/g)).toHaveLength(1)
      expect(result.match(/<!-- canonry:schema:end -->/g)).toHaveLength(1)
      const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(result)
      expect(block).not.toBeNull()
      expect(JSON.parse(block![1]!)).toEqual({ name: 'evil</script><script>alert(1)</script>' })
    })

    it('replaces existing canonry blocks before injecting', () => {
      const content = [
        '<p>Hello</p>',
        '<!-- canonry:schema:start -->',
        '<script type="application/ld+json">{"@type":"OldSchema"}</script>',
        '<!-- canonry:schema:end -->',
      ].join('\n')
      const schemas = [{ '@type': 'NewSchema' }]
      const result = injectCanonrySchema(content, schemas)

      expect(result).not.toContain('OldSchema')
      expect(result).toContain('NewSchema')
      // Only one set of markers
      expect(result.match(/canonry:schema:start/g)?.length).toBe(1)
    })
  })

  it('deploys string, object and ordered FAQ profiles through staging persistence', async () => {
    const pages = [
      { id: 101, slug: 'local', raw: '<p>Local content</p>' },
      { id: 102, slug: 'organization', raw: '<p>Organization content</p>' },
      { id: 103, slug: 'faq', raw: '<p>FAQ content</p>' },
    ]
    const stored = new Map(pages.map(page => [page.slug, page.raw]))
    const requests: Array<{ slug: string; url: string; method: string; authorization: string | null;
      contentType: string | null; body: string | null }> = []
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      const parsedUrl = new URL(url)
      const page = method === 'POST'
        ? pages.find(candidate => parsedUrl.pathname === `/wp-json/wp/v2/pages/${candidate.id}`)
        : pages.find(candidate => parsedUrl.searchParams.get('slug') === candidate.slug)
      if (!page || parsedUrl.origin !== 'https://staging.example.com') throw new Error(`Unhandled ${method} ${url}`)
      const headers = new Headers(init?.headers)
      requests.push({ slug: page.slug, url, method, authorization: headers.get('authorization'),
        contentType: headers.get('content-type'), body: typeof init?.body === 'string' ? init.body : null })
      if (method === 'POST') {
        const submitted = JSON.parse(String(init?.body)) as { content: string }
        stored.set(page.slug, submitted.content)
      }
      const record = { id: page.id, slug: page.slug, content: { raw: stored.get(page.slug) } }
      return jsonResponse(method === 'POST' ? record : [record])
    }
    const result = await deploySchemaFromProfile(createConnection({ defaultEnv: 'staging' }), {
      business: { name: 'Test </script> Co', url: 'https://example.com' },
      pages: {
        local: ['LocalBusiness'],
        organization: [{ type: 'Organization' }],
        faq: [{ type: 'FAQPage', faqs: [
          { q: 'Who </script> are you?', a: 'A & B "together".' },
          { q: 'Where?', a: 'Here.' },
        ] }],
      },
    })
    const expectedContents = {
      local: '<p>Local content</p>\n\n<!-- canonry:schema:start -->\n'
        + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Test <\\/script> Co","url":"https://example.com"}</script>\n'
        + '<!-- canonry:schema:end -->',
      organization: '<p>Organization content</p>\n\n<!-- canonry:schema:start -->\n'
        + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Test <\\/script> Co","url":"https://example.com"}</script>\n'
        + '<!-- canonry:schema:end -->',
      faq: '<p>FAQ content</p>\n\n<!-- canonry:schema:start -->\n'
        + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","name":"Test <\\/script> Co","mainEntity":[{"@type":"Question","name":"Who <\\/script> are you?","acceptedAnswer":{"@type":"Answer","text":"A & B \\"together\\"."}},{"@type":"Question","name":"Where?","acceptedAnswer":{"@type":"Answer","text":"Here."}}]}</script>\n'
        + '<!-- canonry:schema:end -->',
    }
    expect(result).toEqual({ env: 'staging', results: [
      { slug: 'local', status: 'deployed', schemasInjected: ['LocalBusiness'] },
      { slug: 'organization', status: 'deployed', schemasInjected: ['Organization'] },
      { slug: 'faq', status: 'deployed', schemasInjected: ['FAQPage'] },
    ] })
    expect(Object.fromEntries(stored)).toEqual(expectedContents)
    for (const { id, slug } of pages) {
      const getUrl = `https://staging.example.com/wp-json/wp/v2/pages?slug=${slug}&per_page=100&context=edit&_fields=id,slug,status,link,modified,modified_gmt,title,content,meta`
      const content = expectedContents[slug as keyof typeof expectedContents]
      expect(requests.filter(request => request.slug === slug)).toEqual([
        { slug, url: getUrl, method: 'GET', authorization: 'Basic YWRtaW46YXBwLXBhc3M=', contentType: null, body: null },
        { slug, url: `https://staging.example.com/wp-json/wp/v2/pages/${id}`, method: 'POST',
          authorization: 'Basic YWRtaW46YXBwLXBhc3M=', contentType: 'application/json', body: JSON.stringify({ content }) },
        { slug, url: getUrl, method: 'GET', authorization: 'Basic YWRtaW46YXBwLXBhc3M=', contentType: null, body: null },
      ])
    }
    expect(requests).toHaveLength(9)
  })

  it('paginates listActivePlugins across multiple pages', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
      if (url.includes('/wp-json/wp/v2/plugins?per_page=100&page=1')) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({ plugin: `plugin-${i}/plugin-${i}.php`, status: 'active' })),
          { headers: { 'x-wp-totalpages': '2' } },
        )
      }
      if (url.includes('/wp-json/wp/v2/plugins?per_page=100&page=2')) {
        return jsonResponse(
          [
            { plugin: 'extra-plugin/extra.php', status: 'active' },
            { plugin: 'inactive-plugin/inactive.php', status: 'inactive' },
          ],
          { headers: { 'x-wp-totalpages': '2' } },
        )
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const plugins = await listActivePlugins(createConnection(), 'live')
    expect(plugins).toEqual([
      'extra-plugin/extra.php',
      'plugin-0/plugin-0.php',
      'plugin-1/plugin-1.php',
      'plugin-10/plugin-10.php',
      'plugin-11/plugin-11.php',
      'plugin-12/plugin-12.php',
      'plugin-13/plugin-13.php',
      'plugin-14/plugin-14.php',
      'plugin-15/plugin-15.php',
      'plugin-16/plugin-16.php',
      'plugin-17/plugin-17.php',
      'plugin-18/plugin-18.php',
      'plugin-19/plugin-19.php',
      'plugin-2/plugin-2.php',
      'plugin-20/plugin-20.php',
      'plugin-21/plugin-21.php',
      'plugin-22/plugin-22.php',
      'plugin-23/plugin-23.php',
      'plugin-24/plugin-24.php',
      'plugin-25/plugin-25.php',
      'plugin-26/plugin-26.php',
      'plugin-27/plugin-27.php',
      'plugin-28/plugin-28.php',
      'plugin-29/plugin-29.php',
      'plugin-3/plugin-3.php',
      'plugin-30/plugin-30.php',
      'plugin-31/plugin-31.php',
      'plugin-32/plugin-32.php',
      'plugin-33/plugin-33.php',
      'plugin-34/plugin-34.php',
      'plugin-35/plugin-35.php',
      'plugin-36/plugin-36.php',
      'plugin-37/plugin-37.php',
      'plugin-38/plugin-38.php',
      'plugin-39/plugin-39.php',
      'plugin-4/plugin-4.php',
      'plugin-40/plugin-40.php',
      'plugin-41/plugin-41.php',
      'plugin-42/plugin-42.php',
      'plugin-43/plugin-43.php',
      'plugin-44/plugin-44.php',
      'plugin-45/plugin-45.php',
      'plugin-46/plugin-46.php',
      'plugin-47/plugin-47.php',
      'plugin-48/plugin-48.php',
      'plugin-49/plugin-49.php',
      'plugin-5/plugin-5.php',
      'plugin-50/plugin-50.php',
      'plugin-51/plugin-51.php',
      'plugin-52/plugin-52.php',
      'plugin-53/plugin-53.php',
      'plugin-54/plugin-54.php',
      'plugin-55/plugin-55.php',
      'plugin-56/plugin-56.php',
      'plugin-57/plugin-57.php',
      'plugin-58/plugin-58.php',
      'plugin-59/plugin-59.php',
      'plugin-6/plugin-6.php',
      'plugin-60/plugin-60.php',
      'plugin-61/plugin-61.php',
      'plugin-62/plugin-62.php',
      'plugin-63/plugin-63.php',
      'plugin-64/plugin-64.php',
      'plugin-65/plugin-65.php',
      'plugin-66/plugin-66.php',
      'plugin-67/plugin-67.php',
      'plugin-68/plugin-68.php',
      'plugin-69/plugin-69.php',
      'plugin-7/plugin-7.php',
      'plugin-70/plugin-70.php',
      'plugin-71/plugin-71.php',
      'plugin-72/plugin-72.php',
      'plugin-73/plugin-73.php',
      'plugin-74/plugin-74.php',
      'plugin-75/plugin-75.php',
      'plugin-76/plugin-76.php',
      'plugin-77/plugin-77.php',
      'plugin-78/plugin-78.php',
      'plugin-79/plugin-79.php',
      'plugin-8/plugin-8.php',
      'plugin-80/plugin-80.php',
      'plugin-81/plugin-81.php',
      'plugin-82/plugin-82.php',
      'plugin-83/plugin-83.php',
      'plugin-84/plugin-84.php',
      'plugin-85/plugin-85.php',
      'plugin-86/plugin-86.php',
      'plugin-87/plugin-87.php',
      'plugin-88/plugin-88.php',
      'plugin-89/plugin-89.php',
      'plugin-9/plugin-9.php',
      'plugin-90/plugin-90.php',
      'plugin-91/plugin-91.php',
      'plugin-92/plugin-92.php',
      'plugin-93/plugin-93.php',
      'plugin-94/plugin-94.php',
      'plugin-95/plugin-95.php',
      'plugin-96/plugin-96.php',
      'plugin-97/plugin-97.php',
      'plugin-98/plugin-98.php',
      'plugin-99/plugin-99.php',
    ])
    expect(requestedUrls).toEqual([
      'https://example.com/wp-json/wp/v2/plugins?per_page=100&page=1&_fields=plugin,status',
      'https://example.com/wp-json/wp/v2/plugins?per_page=100&page=2&_fields=plugin,status',
    ])
  })

  it('returns an actionable error message when auth fails on connect', async () => {
    const requestedUrls: string[] = []
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
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

    let failure: unknown
    try {
      await verifyWordpressConnection(createConnection())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'WordpressApiError', code: 'AUTH_INVALID', statusCode: 401,
      message: 'Authentication failed — the username or application password is incorrect. Verify the app password belongs to the user specified with --user.',
    } satisfies Partial<WordpressApiError>)
    expect(requestedUrls).toEqual(['https://example.com/wp-json/wp/v2/users/me?_fields=id,slug'])
  })

  it('sanitizes the application password and username from the error details on failure', async () => {
    globalThis.fetch = async () => new Response('Internal Server Error containing app-pass and admin username', { status: 500 })

    await expect(() => verifyWordpressConnection(createConnection())).rejects.toThrow(
      'WordPress API error (500): Internal Server Error containing *** and *** username',
    )
  })
})
