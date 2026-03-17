import { test, expect, onTestFinished } from 'vitest'
import dns from 'node:dns/promises'

import { auditClientDescriptor, describeAuditClient, runTechnicalAudit } from '../src/audit-client.js'

const EXAMPLE_IP = '93.184.216.34'

test('audit client descriptor identifies the published npm package boundary', () => {
  expect(auditClientDescriptor).toEqual({
    packageName: '@ainyc/aeo-audit',
    source: 'npm',
  })
  expect(describeAuditClient()).toBe('@ainyc/aeo-audit via npm')
})

test('runTechnicalAudit delegates to the published audit package', async () => {
  const realFetch = globalThis.fetch
  const dnsStub = dns as typeof dns & {
    resolve4: typeof dns.resolve4
    resolve6: typeof dns.resolve6
  }
  const realResolve4 = dnsStub.resolve4
  const realResolve6 = dnsStub.resolve6

  dnsStub.resolve4 = async () => [EXAMPLE_IP]
  dnsStub.resolve6 = async () => []

  globalThis.fetch = (async (input) => {
    const requestUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url

    if (requestUrl === 'https://example.com/' || requestUrl === 'https://example.com') {
      return new Response(
        `
          <!doctype html>
          <html lang="en">
            <head>
              <title>Example AEO Page</title>
              <meta name="description" content="A test page for the external audit package." />
              <script type="application/ld+json">
                {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is AEO?","acceptedAnswer":{"@type":"Answer","text":"Answer Engine Optimization improves citation readiness."}}]}
              </script>
            </head>
            <body>
              <main>
                <h1>Answer Engine Optimization</h1>
                <p>Answer Engine Optimization helps AI systems understand and cite a page.</p>
                <section>
                  <h2>FAQ</h2>
                  <p>Question: What is AEO?</p>
                  <p>Answer: It improves citation readiness.</p>
                </section>
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        },
      )
    }

    if (requestUrl.endsWith('/llms.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      })
    }

    if (requestUrl.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      })
    }

    if (requestUrl.endsWith('/sitemap.xml')) {
      return new Response('<?xml version="1.0"?><urlset></urlset>', {
        status: 200,
        headers: {
          'content-type': 'application/xml; charset=utf-8',
        },
      })
    }

    return new Response('not found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    })
  }) as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
    dnsStub.resolve4 = realResolve4
    dnsStub.resolve6 = realResolve6
  })

  const report = await runTechnicalAudit('https://example.com')

  expect(report.url).toBe('https://example.com/')
  expect(report.finalUrl).toBe('https://example.com/')
  expect(report.metadata.pageTitle).toBe('Example AEO Page')
  expect(report.metadata.auxiliary.llmsTxt).toBe('ok')
  expect(report.metadata.auxiliary.robotsTxt).toBe('ok')
  expect(report.metadata.auxiliary.sitemapXml).toBe('ok')
  expect(typeof report.overallScore).toBe('number')
  expect(report.factors.length > 0).toBeTruthy()
  expect(report.summary).toMatch(/Overall grade/)
})
