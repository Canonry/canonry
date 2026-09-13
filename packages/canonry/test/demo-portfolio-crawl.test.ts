import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SiteCrawlGraphResponseDto } from '@ainyc/canonry-contracts'
import { createDemoServer } from '../src/demo-server.js'

const dir = mkdtempSync(join(tmpdir(), 'canonry-portfolio-map-'))
const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Demo must not contact providers'))
let app: Awaited<ReturnType<typeof createDemoServer>>
const base = '/api/v1/projects/harbor-resorts/technical-aeo'

beforeAll(async () => {
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>')
  app = await createDemoServer({ assetsDir: dir })
}, 20_000)
afterAll(async () => { await app?.close(); network.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

async function graph(linkKind = 'all'): Promise<SiteCrawlGraphResponseDto> {
  const response = await app.inject(`${base}/graph?linkKind=${linkKind}`)
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200)
  return response.json<SiteCrawlGraphResponseDto>()
}

describe('public portfolio site map', () => {
  it('represents every published property with hundreds of connected pages on one domain', async () => {
    const data = await graph()
    expect(data.nodes.length).toBeGreaterThanOrEqual(500)
    expect(data.totalNodes).toBe(data.nodes.length)
    expect(data.totalEdges).toBe(data.edges.length)
    expect(data.sampled).toBe(false)
    expect(data.layout.state).toBe('ready')
    const keys = new Set(data.nodes.map(node => node.nodeKey))
    expect(keys.has(data.rootNodeKey!)).toBe(true)
    expect(data.nodes.every(node => new URL(node.url).hostname === 'harbor-resorts.example')).toBe(true)
    for (const market of ['key-west', 'coastal-maine', 'pacific-northwest']) {
      expect(data.nodes.some(node => node.path === `/destinations/${market}/`)).toBe(true)
      for (const property of ['resort', 'villas-2', 'villas-3', 'villas-4']) {
        const prefix = `/destinations/${market}/${property}/`
        const pages = data.nodes.filter(node => node.path.startsWith(prefix))
        expect(pages.length, prefix).toBeGreaterThanOrEqual(30)
        for (const section of ['rooms/', 'dining/', 'amenities/', 'offers/']) {
          expect(pages.some(node => node.path === prefix + section), prefix + section).toBe(true)
        }
      }
    }
    expect(data.edges.every(edge => keys.has(edge.sourceNodeKey) && keys.has(edge.targetNodeKey))).toBe(true)
    const reached = new Set([data.rootNodeKey!])
    for (let prior = -1; prior !== reached.size;) {
      prior = reached.size
      for (const edge of data.edges) if (!edge.isTemplate && reached.has(edge.sourceNodeKey)) reached.add(edge.targetNodeKey)
    }
    expect(reached.size).toBe(data.nodes.length)
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps navigation links separate and supplies real page health evidence for property pages', async () => {
    const all = await graph()
    const content = await graph('content')
    expect(all.totalTemplateEdges).toBeGreaterThan(100)
    expect(content.nodes).toEqual(all.nodes)
    expect(content.edges.every(edge => !edge.isTemplate)).toBe(true)
    expect(content.edges.length).toBe(all.totalContentEdges)
    const states = new Set(all.nodes.map(node => node.healthState))
    expect(states).toEqual(new Set(['eligible', 'hidden', 'failed', 'redirect', 'resource']))
    expect(all.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
    const room = all.nodes.find(node => node.path === '/destinations/key-west/resort/rooms/ocean-suite/')
    expect(room).toBeDefined()
    const detail = await app.inject(`${base}/crawl/pages/audit?nodeKey=${encodeURIComponent(room!.nodeKey)}`)
    expect(detail.statusCode, detail.body.slice(0, 200)).toBe(200)
    expect(detail.json()).toMatchObject({ state: 'ready', evidenceState: 'complete' })
    expect(detail.json().factors.length).toBeGreaterThan(0)
    const audit = await app.inject(`${base}/pages?limit=1`)
    expect(audit.statusCode).toBe(200)
    expect(audit.json().total).toBe(all.nodes.filter(node => node.auditState === 'success').length)
    expect(network).not.toHaveBeenCalled()
  })
})
