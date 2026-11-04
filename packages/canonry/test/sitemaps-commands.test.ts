import { beforeEach, expect, it, vi } from 'vitest'
import type { SitemapCoverageResponseDto } from '@canonry/canonry-contracts'

const sitemaps = vi.fn<(project: string) => Promise<SitemapCoverageResponseDto>>()
const bingSubmitSitemap = vi.fn()
vi.mock('../src/client.js', () => ({ createApiClient: () => ({ sitemaps, bingSubmitSitemap }) }))

const { sitemapsCommand } = await import('../src/commands/sitemaps.js')
const { bingSubmitSitemap: bingSubmitSitemapCommand } = await import('../src/commands/bing.js')

async function capture(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return logs.join('\n')
}

const S = 'https://example.com'
const COVERAGE: SitemapCoverageResponseDto = {
  site: { scannedAt: '2026-11-02T00:00:00.000Z', runId: 'scan', sitemaps: [`${S}/pages.xml`, `${S}/area.xml`] },
  google: {
    syncedAt: '2026-11-04T06:00:00.000Z',
    sitemaps: [
      { url: `${S}/index.xml`, parentUrl: null, isIndex: true, type: 'sitemap', state: 'ok', statusLabel: 'Success', warnings: 0, errors: 0, urlCount: 40, submittedAt: '2026-10-01T00:00:00.000Z', lastReadAt: null },
      { url: `${S}/pages.xml`, parentUrl: `${S}/index.xml`, isIndex: false, type: 'sitemap', state: 'ok', statusLabel: 'Success', warnings: 0, errors: 0, urlCount: 40, submittedAt: null, lastReadAt: null },
    ],
    missing: [{ url: `${S}/area.xml`, foundIn: ['site'] }],
  },
  bing: null,
}

beforeEach(() => {
  sitemaps.mockReset()
  bingSubmitSitemap.mockReset()
})

it('prints each engine with what it is missing, and says when one is not read', async () => {
  sitemaps.mockResolvedValue(COVERAGE)
  const out = await capture(() => sitemapsCommand('demo', {}))
  expect(out).toContain('Site: 2 sitemap files in the Site Health scan of 2026-11-02T00:00:00.000Z')
  expect(out).toContain('Google: 1 sitemap (2 with files inside indexes), read 2026-11-04T06:00:00.000Z')
  expect(out).toContain(`  Success    ${S}/index.xml (index, 1 file)`)
  expect(out).toContain(`    ${S}/area.xml  (seen in: site)`)
  expect(out).toContain('Bing: not connected, or its list has not been read yet.')
})

it('limits the output to one engine, and prints the API response as JSON', async () => {
  sitemaps.mockResolvedValue(COVERAGE)
  const google = await capture(() => sitemapsCommand('demo', { engine: 'google' }))
  expect(google).not.toContain('Bing:')
  const json = await capture(() => sitemapsCommand('demo', { format: 'json' }))
  expect(JSON.parse(json)).toEqual(COVERAGE)
})

it('confirms a Bing submission and points at the next sync', async () => {
  bingSubmitSitemap.mockResolvedValue({ sitemapUrl: `${S}/area.xml`, accepted: true })
  const out = await capture(() => bingSubmitSitemapCommand('demo', `${S}/area.xml`, {}))
  expect(bingSubmitSitemap).toHaveBeenCalledWith('demo', `${S}/area.xml`)
  expect(out).toBe(`Bing accepted ${S}/area.xml. A new sitemap shows in "canonry sitemaps demo" after the next Bing sync.`)
})
