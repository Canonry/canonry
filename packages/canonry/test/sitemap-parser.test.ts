import { describe, it, afterEach, expect } from 'vitest'
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
      resolve({ server, baseUrl: `http://localhost:${port}` })
    })
  })
}

describe('fetchAndParseSitemap', () => {
  let server: http.Server | null = null

  afterEach(() => {
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
  <sitemap><loc>http://localhost:${port}/child-sitemap.xml</loc></sitemap>
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
        resolve({ server: srv, baseUrl: `http://localhost:${port}` })
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
        resolve({ server: srv, baseUrl: `http://localhost:${port}` })
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
  <sitemap><loc>http://localhost:${port}/child-good.xml</loc></sitemap>
  <sitemap><loc>http://localhost:${port}/child-missing.xml</loc></sitemap>
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
        resolve({ server: srv, baseUrl: `http://localhost:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls).toEqual(['https://example.com/page-from-good-child'])
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
  <sitemap><loc>http://localhost:${port}/child.xml</loc></sitemap>
  <sitemap><loc>http://localhost:${port}/child.xml</loc></sitemap>
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
        resolve({ server: srv, baseUrl: `http://localhost:${port}` })
      })
    })
    server = s.server

    const urls = await fetchAndParseSitemap(`${s.baseUrl}/sitemap.xml`)
    expect(urls).toEqual(['https://example.com/dedup-page'])
    expect(childCalls.length).toBe(1)
  })
})
