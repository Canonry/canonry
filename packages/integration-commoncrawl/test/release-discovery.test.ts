import { describe, expect, test, vi } from 'vitest'
import { probeLatestRelease, probeRelease } from '../src/release-discovery.js'

function headOk(bytes: number, lastModified: string): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-length': String(bytes),
      'last-modified': lastModified,
    },
  })
}

function head404(): Response {
  return new Response(null, { status: 404 })
}

/** Build a fetch stub that returns 200 for any release slug in `hits`, else 404. */
function fetchFor(hits: Set<string>): typeof fetch {
  const impl = async (url: string | URL | Request): Promise<Response> => {
    const s = String(url)
    for (const hit of hits) {
      if (s.includes(`/${hit}/`)) return headOk(100, 'x')
    }
    return head404()
  }
  return impl as typeof fetch
}

describe('probeRelease', () => {
  test.each(['vertices', 'edges'])('returns null when %s is missing', async (missing) => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const s = String(url)
      return s.includes(missing) ? head404() : headOk(100, 'Tue, 24 Mar 2026 00:00:00 GMT')
    }
    const got = await probeRelease('cc-main-2026-jan-feb-mar', fetchImpl as typeof fetch)
    expect(got).toBeNull()
  })

  test('returns sizes + last-modified when both files resolve', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return String(url).includes('vertices')
        ? headOk(4_000_000_000, 'Tue, 24 Mar 2026 00:00:00 GMT')
        : headOk(13_000_000_000, 'Tue, 24 Mar 2026 00:00:00 GMT')
    })
    const vertexUrl = 'https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-vertices.txt.gz'
    const edgesUrl = 'https://data.commoncrawl.org/projects/hyperlinkgraph/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-edges.txt.gz'
    const got = await probeRelease('cc-main-2026-mar-apr-may', fetchImpl as typeof fetch)
    expect(got).toEqual({
      release: 'cc-main-2026-mar-apr-may',
      vertexUrl,
      edgesUrl,
      vertexBytes: 4_000_000_000,
      edgesBytes: 13_000_000_000,
      lastModified: 'Tue, 24 Mar 2026 00:00:00 GMT',
    })
    expect(fetchImpl.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method }))).toEqual([
      { url: vertexUrl, method: 'HEAD' },
      { url: edgesUrl, method: 'HEAD' },
    ])
  })
})

describe('probeLatestRelease', () => {
  test('walks month-by-month to find the newest available window', async () => {
    // now=2026-04-19 → first candidate window is apr-may-jun (404), step back one
    // month to mar-apr-may (HIT). Proves monthly stepping reaches the issue exemplar.
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchFor(new Set(['cc-main-2026-mar-apr-may'])),
    })
    expect(got?.release).toBe('cc-main-2026-mar-apr-may')
  })

  test('prefers the newest window when several overlapping windows are published', async () => {
    // Candidates: apr-may-jun(miss) → mar-apr-may(miss) → feb-mar-apr(HIT).
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchFor(new Set(['cc-main-2026-feb-mar-apr', 'cc-main-2026-jan-feb-mar'])),
    })
    expect(got?.release).toBe('cc-main-2026-feb-mar-apr')
  })

  test('crosses the year boundary while stepping back', async () => {
    // now=2026-01-15 → jan-feb-mar(2026,miss) → dec-jan-feb(2025,miss) →
    // nov-dec-jan(2025,miss) → oct-nov-dec(2025,HIT). Proves the year decrement
    // and that a release's slug year is its FIRST month's year.
    const got = await probeLatestRelease({
      now: new Date('2026-01-15T00:00:00Z'),
      fetchImpl: fetchFor(new Set(['cc-main-2025-oct-nov-dec'])),
    })
    expect(got?.release).toBe('cc-main-2025-oct-nov-dec')
  })

  test('returns null when nothing published in the lookback window', async () => {
    const fetchImpl = vi.fn(fetchFor(new Set()))
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl,
      maxMonthsBack: 1,
    })
    expect(got).toBeNull()
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/')[3])).toEqual([
      'cc-main-2026-apr-may-jun', 'cc-main-2026-apr-may-jun',
      'cc-main-2026-mar-apr-may', 'cc-main-2026-mar-apr-may',
    ])
  })
})
