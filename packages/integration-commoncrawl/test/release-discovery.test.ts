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
    const got = await probeRelease('cc-main-2026-jan-feb-mar', fetchImpl as typeof fetch)
    expect(got).toEqual({
      release: 'cc-main-2026-jan-feb-mar',
      vertexUrl: expect.stringContaining('/cc-main-2026-jan-feb-mar/domain/cc-main-2026-jan-feb-mar-domain-vertices.txt.gz'),
      edgesUrl: expect.stringContaining('/cc-main-2026-jan-feb-mar/domain/cc-main-2026-jan-feb-mar-domain-edges.txt.gz'),
      vertexBytes: 4_000_000_000,
      edgesBytes: 13_000_000_000,
      lastModified: 'Tue, 24 Mar 2026 00:00:00 GMT',
    })
  })
})

describe('probeLatestRelease', () => {
  test('walks current year backward through quarters to find the newest available', async () => {
    const hits = new Set(['cc-main-2026-jan-feb-mar'])
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const s = String(url)
      for (const hit of hits) {
        if (s.includes(`/${hit}/`)) return headOk(100, 'x')
      }
      return head404()
    }
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(got?.release).toBe('cc-main-2026-jan-feb-mar')
  })

  test('prefers newer quarter within the same year', async () => {
    const hits = new Set(['cc-main-2025-jan-feb-mar', 'cc-main-2025-jul-aug-sep'])
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const s = String(url)
      for (const hit of hits) {
        if (s.includes(`/${hit}/`)) return headOk(100, 'x')
      }
      return head404()
    }
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(got?.release).toBe('cc-main-2025-jul-aug-sep')
  })

  test('returns null when nothing published in the lookback window', async () => {
    const fetchImpl = async (): Promise<Response> => head404()
    const got = await probeLatestRelease({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
      maxQuartersBack: 1,
    })
    expect(got).toBeNull()
  })
})

describe('probeRecentReleases', () => {
  test('lists up to `limit` published releases, newest first', async () => {
    const hits = new Set([
      'cc-main-2026-jan-feb-mar',
      'cc-main-2025-oct-nov-dec',
      'cc-main-2025-jul-aug-sep',
    ])
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const s = String(url)
      for (const hit of hits) {
        if (s.includes(`/${hit}/`)) return headOk(100, 'x')
      }
      return head404()
    }
    const got = await probeRecentReleases({
      now: new Date('2026-04-19T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
      limit: 2,
    })
    expect(got.map((r) => r.release)).toEqual([
      'cc-main-2026-jan-feb-mar',
      'cc-main-2025-oct-nov-dec',
    ])
  })
})
