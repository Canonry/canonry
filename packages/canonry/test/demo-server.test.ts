import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemoServer } from '../src/demo-server.js'

const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-integration-'))
let app: Awaited<ReturnType<typeof createDemoServer>>
const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Demo must not use the network'))
beforeAll(async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  app = await createDemoServer({ assetsDir: dir })
}, 20000)
afterAll(async () => { await app?.close(); network.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

describe('populated demo integration', () => {
  it.each(['summit-roofing', 'harbor-resorts'])('serves populated feature reads for %s without any provider call', async name => {
    const paths = [
      'overview', 'visibility-report', 'queries', 'runs', 'google/connections',
      'google/gsc/performance/daily?window=7d', 'bing/status', 'bing/performance', 'bing/coverage',
      'ga/status', 'ga/traffic', 'ga/ai-referral-history',
      'technical-aeo/crawl', 'technical-aeo/graph', 'gbp/summary',
      'backlinks/summary', 'ads/summary', 'conversion-tracking/contracts', 'content/targets', 'history',
    ]
    for (const path of paths) {
      const response = await app.inject(`/api/v1/projects/${name}/${path}`)
      expect(response.statusCode, `${name}/${path}: ${response.body.slice(0, 200)}`).toBe(200)
    }
    expect((await app.inject(`/api/v1/projects/${name}/bing/performance`)).json().length).toBeGreaterThan(0)
    expect((await app.inject(`/api/v1/projects/${name}/ga/status`)).json().connected).toBe(true)
    expect(network).not.toHaveBeenCalled()
  })
  it.each(['summit-roofing', 'harbor-resorts'])('populates traffic, page health and stored research for %s', async name => {
    const read = async (path: string) => {
      const response = await app.inject(`/api/v1/projects/${name}/${path}`)
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    }
    expect((await read('traffic/sources')).sources.length).toBeGreaterThan(0)
    expect(JSON.stringify(await read('traffic/events'))).toContain('gptbot')
    expect(JSON.stringify(await read('technical-aeo/pages'))).toContain('overallScore')
    expect(JSON.stringify(await read('research/runs'))).toContain('completed')
    expect(network).not.toHaveBeenCalled()
  })
  it('keeps stored Bing reads and conversion assessment view-only', async () => {
    const history = '/api/v1/projects/summit-roofing/bing/coverage/history'
    const before = (await app.inject(history)).json()
    await app.inject('/api/v1/projects/summit-roofing/bing/coverage')
    expect((await app.inject(history)).json()).toEqual(before)
    const contracts = (await app.inject('/api/v1/projects/summit-roofing/conversion-tracking/contracts')).json()
    const integrity = await app.inject(`/api/v1/projects/summit-roofing/conversion-tracking/contracts/${contracts[0].id}/integrity`)
    expect(integrity.statusCode, integrity.body).toBe(200)
    expect(integrity.json().assessment.contract.id).toBe(contracts[0].id)
    expect(network).not.toHaveBeenCalled()
  })
})
