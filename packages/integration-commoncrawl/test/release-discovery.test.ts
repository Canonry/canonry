import { describe, expect, test } from 'vitest'
import { probeLatestRelease, probeRecentReleases, probeRelease } from '../src/release-discovery.js'

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
  test('returns null when either file is missing', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const s = String(url)
      return s.includes('vertices') ? headOk(100, 'Tue, 24 Mar 2026 00:00:00 GMT') : head404()
    }
    const got = await probeRelease('cc-main-2026-jan-feb-mar', fetchImpl as typeof fetch)
    expect(got).toBeNull()
  })

  test('returns sizes + last-modified when both files resolve', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      return String(url).includes('vertices')
        ? headOk(4_000_000_000, 'Tue, 24 Mar 2026 00:00:00 GMT')
        : headOk(13_000_000_000, 'Tue, 24 Mar 2026 00:00:00 GMT')
    }
    const got = await probeRelease('cc-main-2026-mar-apr-may', fetchImpl as typeof fetch)
    expect(got).toEqual({
      release: 'cc-main-2026-mar-apr-may',
      vertexUrl: expect.stringContaining('/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-vertices.txt.gz'),
      edgesUrl: expect.stringContaining('/cc-main-2026-mar-apr-may/domain/cc-main-2026-mar-apr-may-domain-edges.txt.gz'),
      vertexBytes: 4_000_000_000,
      edgesBytes: 13_000_000_000,
      lastModified: 'Tue, 24 Mar 2026 00:00:00 GMT',
    })
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
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchFor(new Set()),
      maxMonthsBack: 1,
    })
    expect(got).toBeNull()
  })
})

describe('probeRecentReleases', () => {
  test('lists overlapping monthly windows newest-first, truncated to limit', async () => {
    // Candidates from now=2026-04-19: apr-may-jun(miss), mar-apr-may(miss),
    // feb-mar-apr(HIT), jan-feb-mar(HIT) → stops at limit 2.
    const got = await probeRecentReleases({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchFor(new Set([
        'cc-main-2026-feb-mar-apr',
        'cc-main-2026-jan-feb-mar',
        'cc-main-2025-dec-jan-feb',
      ])),
      limit: 2,
    })
    expect(got.map((r) => r.release)).toEqual([
      'cc-main-2026-feb-mar-apr',
      'cc-main-2026-jan-feb-mar',
    ])
  })
})
