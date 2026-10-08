import { describe, it, afterEach, expect, vi } from 'vitest'
import dns from 'node:dns/promises'
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { fetchAndParseSitemap } from '../src/sitemap-parser.js'

function createServer(routes: Record<string, string>): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url ?? '/']
      if (body) {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        res.end(body)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

describe('fetchAndParseSitemap', () => {
  let server: http.Server | null = null

  afterEach(() => {
    vi.restoreAllMocks()
    if (server) {
      server.close()
      server = null
    }
  })

  it('parses a simple sitemap with <loc> entries', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/blog</loc></url>
</urlset>`

    const s = await createServer({ '/sitemap.xml': xml })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls.length).toBe(3)
    expect(urls.includes('https://example.com/')).toBeTruthy()
    expect(urls.includes('https://example.com/about')).toBeTruthy()
    expect(urls.includes('https://example.com/blog')).toBeTruthy()
  })

  it('deduplicates URLs', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`

    const s = await createServer({ '/sitemap.xml': xml })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls.length).toBe(2)
  })

  it('handles sitemap index files', async () => {
    const childSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`

    // Use a dynamic handler so the index can reference itself
    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url === '/child-sitemap.xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(childSitemap)
        } else if (req.url === '/sitemap.xml') {
          const addr = srv.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${port}/child-sitemap.xml</loc></sitemap>
</sitemapindex>`
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(indexXml)
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      })
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls.length).toBe(2)
    expect(urls.includes('https://example.com/page1')).toBeTruthy()
    expect(urls.includes('https://example.com/page2')).toBeTruthy()
  })

  it('throws when sitemap returns 404', async () => {
    const s = await createServer({})
    server = s.server

    await expect(() => fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)).rejects.toThrow('404')
  })

  it('returns empty array for sitemap with no URLs', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`

    const s = await createServer({ '/sitemap.xml': xml })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls.length).toBe(0)
  })

  it('decompresses gzipped sitemap bodies', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`
    const gz = gzipSync(xml)

    const srv = http.createServer((req, res) => {
      if (req.url === '/sitemap.xml.gz') {
        // Static .gz file at rest — no Content-Encoding header.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(gz)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml.gz`)
    expect(urls.length).toBe(2)
    expect(urls.includes('https://example.com/page1')).toBeTruthy()
    expect(urls.includes('https://example.com/page2')).toBeTruthy()
  })

  it('skips child sitemaps that 404 instead of failing the whole index', async () => {
    const childOk = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-from-good-child</loc></url>
</urlset>`

    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url === '/child-good.xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(childOk)
        } else if (req.url === '/sitemap.xml') {
          const addr = srv.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${port}/child-good.xml</loc></sitemap>
  <sitemap><loc>http://127.0.0.1:${port}/child-missing.xml</loc></sitemap>
</sitemapindex>`
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(indexXml)
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      })
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls).toEqual(['https://example.com/page-from-good-child'])
  })

  it('rejects sitemap URLs that resolve to private / metadata ranges (SSRF guard)', async () => {
    // Literal addresses — no DNS, deterministic. Loopback is intentionally
    // allowed (see `sitemapFetch`), but these non-loopback internal ranges
    // and the cloud metadata IP must be blocked before any fetch.
    await expect(() => fetchAndParseSitemap('http://169.254.169.254/sitemap.xml')).rejects.toThrow(/rejected/)
    await expect(() => fetchAndParseSitemap('http://10.0.0.5/sitemap.xml')).rejects.toThrow(/rejected/)
    await expect(() => fetchAndParseSitemap('http://192.168.1.1/sitemap.xml')).rejects.toThrow(/rejected/)
    // Non-http(s) schemes are rejected too.
    await expect(() => fetchAndParseSitemap('file:///etc/passwd')).rejects.toThrow(/rejected/)
  })

  it('reports a sitemap host that does not resolve as a fetch failure, not a rejection', async () => {
    vi.spyOn(dns, 'resolve4').mockResolvedValue([])
    vi.spyOn(dns, 'resolve6').mockResolvedValue([])

    await expect(() => fetchAndParseSitemap('https://gone.example.test/sitemap.xml'))
      .rejects.toThrow(new Error('Failed to fetch sitemap at https://gone.example.test/sitemap.xml: Could not resolve gone.example.test'))
  })

  it('follows a same-origin redirect to the sitemap', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/moved</loc></url>
</urlset>`
    const srv = http.createServer((req, res) => {
      if (req.url === '/sitemap.xml') {
        res.writeHead(301, { Location: '/sitemap_index.xml' })
        res.end()
      } else if (req.url === '/sitemap_index.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        res.end(xml)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    expect(await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)).toEqual(['https://example.com/moved'])
  })

  // The redirect is checked like the first request. 0.0.0.0 reaches this
  // host, so an unchecked redirect there would show up as a served request.
  it.each([
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['the unspecified address', (port: number) => `http://0.0.0.0:${port}/internal.xml`],
  ])('refuses a sitemap that redirects to %s', async (_name, location) => {
    const served: string[] = []
    const srv = http.createServer((req, res) => {
      served.push(req.url ?? '')
      if (req.url === '/sitemap.xml') {
        const addr = srv.address()
        res.writeHead(302, { Location: location(typeof addr === 'object' && addr ? addr.port : 0) })
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        res.end('<urlset><url><loc>https://internal.example/secret</loc></url></urlset>')
      }
    })
    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    await expect(() => fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`))
      .rejects.toThrow(/^Sitemap URL rejected: Refused to connect to .+: must not resolve to a private or loopback address/)
    expect(served).toEqual(['/sitemap.xml'])
  })

  it('rejects a nested sitemap-index entry pointing at an internal host', async () => {
    // The index itself is on an allowed loopback host, but it references a
    // child sitemap on a blocked private IP — the child fetch must be guarded
    // too. A blocked child is treated like any other failing child (skipped),
    // so the run yields only the safe entries.
    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url === '/sitemap.xml') {
          const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://169.254.169.254/child.xml</loc></sitemap>
</sitemapindex>`
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(indexXml)
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls).toEqual([])
  })

  it('does not refetch a child sitemap referenced more than once', async () => {
    const childCalls: string[] = []
    const childXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/dedup-page</loc></url>
</urlset>`

    const s = await new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url === '/child.xml') {
          childCalls.push(req.url)
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(childXml)
        } else if (req.url === '/sitemap.xml') {
          const addr = srv.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${port}/child.xml</loc></sitemap>
  <sitemap><loc>http://127.0.0.1:${port}/child.xml</loc></sitemap>
</sitemapindex>`
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          res.end(indexXml)
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      srv.listen(0, () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ server: srv, baseUrl: `http://127.0.0.1:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls).toEqual(['https://example.com/dedup-page'])
    expect(childCalls.length).toBe(1)
  })
})
