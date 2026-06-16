import { describe, it, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  backlinkDomains,
  backlinkSummaries,
  createClient,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import type { BingInboundLink, BingLinkCount } from '@ainyc/canonry-integration-bing'
import {
  aggregateInboundLinksByDomain,
  bingReleaseId,
  computeBingSummary,
  executeBingBacklinkSync,
} from '../src/bing-backlinks-sync.js'

describe('bingReleaseId', () => {
  it('formats a synthetic per-UTC-day window id', () => {
    expect(bingReleaseId(new Date('2026-06-15T23:30:00Z'))).toBe('bing-2026-06-15')
    expect(bingReleaseId(new Date('2026-01-02T00:00:00Z'))).toBe('bing-2026-01-02')
  })
})

describe('aggregateInboundLinksByDomain', () => {
  function links(...urls: string[]): BingInboundLink[] {
    return urls.map((Url) => ({ Url, AnchorText: 'x' }))
  }

  it('groups by normalized host and counts DISTINCT linking pages, strongest-first', () => {
    const result = aggregateInboundLinksByDomain(
      links(
        'https://blog.acme.com/post-1',
        'https://blog.acme.com/post-2',
        'https://news.example.org/story',
      ),
      'roots.io',
    )
    expect(result).toEqual([
      { linkingDomain: 'blog.acme.com', numHosts: 2 },
      { linkingDomain: 'news.example.org', numHosts: 1 },
    ])
  })

  it('strips www, lowercases, and dedupes identical linking URLs', () => {
    const result = aggregateInboundLinksByDomain(
      links(
        'https://WWW.Acme.com/a',
        'https://acme.com/a', // same host (www stripped) + same path -> distinct? path differs only by host; both normalize to acme.com/a
        'https://acme.com/a', // exact duplicate URL -> counted once
        'https://acme.com/b',
      ),
      'roots.io',
    )
    // Hosts all normalize to acme.com. Distinct URLs: 'https://WWW.Acme.com/a',
    // 'https://acme.com/a', 'https://acme.com/b' = 3 (the repeated acme.com/a dedupes).
    expect(result).toHaveLength(1)
    expect(result[0]!.linkingDomain).toBe('acme.com')
    expect(result[0]!.numHosts).toBe(3)
  })

  it('excludes self-links from the target domain and its subdomains', () => {
    const result = aggregateInboundLinksByDomain(
      links(
        'https://roots.io/page',
        'https://blog.roots.io/post',
        'https://external.com/ref',
      ),
      'roots.io',
    )
    expect(result).toEqual([{ linkingDomain: 'external.com', numHosts: 1 }])
  })

  it('skips malformed URLs and returns [] for no usable links', () => {
    expect(aggregateInboundLinksByDomain(links('not a url', ''), 'roots.io')).toEqual([])
    expect(aggregateInboundLinksByDomain([], 'roots.io')).toEqual([])
  })
})

describe('computeBingSummary', () => {
  it('returns zeros and "0" share for no rows', () => {
    expect(computeBingSummary([])).toEqual({ totalLinkingDomains: 0, totalHosts: 0, top10HostsShare: '0' })
  })

  it('sums hosts and computes the top-10 concentration share', () => {
    const rows = [
      { linkingDomain: 'a.com', numHosts: 60 },
      { linkingDomain: 'b.com', numHosts: 30 },
      { linkingDomain: 'c.com', numHosts: 10 },
    ]
    const summary = computeBingSummary(rows)
    expect(summary.totalLinkingDomains).toBe(3)
    expect(summary.totalHosts).toBe(100)
    expect(summary.top10HostsShare).toBe('1.000000') // all 3 are within the top 10
  })

  it('top-10 share excludes the long tail beyond the 10 strongest', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ linkingDomain: `d${i}.com`, numHosts: i + 1 }))
    // numHosts 1..12, total = 78. Top 10 strongest = 12+11+...+3 = 75. share = 75/78.
    const summary = computeBingSummary(rows)
    expect(summary.totalLinkingDomains).toBe(12)
    expect(summary.totalHosts).toBe(78)
    expect(Number(summary.top10HostsShare)).toBeCloseTo(75 / 78, 6)
  })
})

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-bing-backlinks-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProjectAndRun(db: ReturnType<typeof createClient>, domain = 'roots.io') {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'roots', displayName: 'roots', canonicalDomain: domain,
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'backlink-extract', status: 'queued', trigger: 'manual', createdAt: now,
  }).run()
  return { projectId, runId }
}

const FIXED_NOW = () => new Date('2026-06-15T12:00:00Z')

describe('executeBingBacklinkSync', () => {
  it('pulls Bing links, writes source=bing-webmaster rows + summary, completes the run', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)

    const counts: BingLinkCount[] = [
      { Url: 'https://roots.io/page-a', Count: 9 },
      { Url: 'https://roots.io/page-b', Count: 2 },
    ]
    const linksByPage: Record<string, BingInboundLink[]> = {
      'https://roots.io/page-a': [
        { Url: 'https://news.example.org/1', AnchorText: 'a' },
        { Url: 'https://news.example.org/2', AnchorText: 'b' },
        { Url: 'https://blog.acme.com/x', AnchorText: 'c' },
      ],
      'https://roots.io/page-b': [
        { Url: 'https://blog.acme.com/y', AnchorText: 'd' },
      ],
    }

    await executeBingBacklinkSync(db, runId, projectId, {
      resolveConnection: () => ({ apiKey: 'k', siteUrl: 'https://roots.io/' }),
      deps: {
        now: FIXED_NOW,
        getLinkCounts: async () => counts,
        getUrlLinks: async (_apiKey, _siteUrl, link) => linksByPage[link] ?? [],
      },
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('completed')

    const rows = db.select().from(backlinkDomains)
      .where(and(eq(backlinkDomains.projectId, projectId), eq(backlinkDomains.source, 'bing-webmaster')))
      .all()
    // news.example.org (2 distinct pages) + blog.acme.com (2 distinct pages).
    expect(rows).toHaveLength(2)
    const byDomain = Object.fromEntries(rows.map((r) => [r.linkingDomain, r.numHosts]))
    expect(byDomain['news.example.org']).toBe(2)
    expect(byDomain['blog.acme.com']).toBe(2)
    expect(rows.every((r) => r.source === 'bing-webmaster')).toBe(true)
    expect(rows.every((r) => r.releaseSyncId === null)).toBe(true)
    expect(rows.every((r) => r.release === 'bing-2026-06-15')).toBe(true)

    const summary = db.select().from(backlinkSummaries)
      .where(and(eq(backlinkSummaries.projectId, projectId), eq(backlinkSummaries.source, 'bing-webmaster')))
      .get()
    expect(summary?.totalLinkingDomains).toBe(2)
    expect(summary?.totalHosts).toBe(4)
    expect(summary?.release).toBe('bing-2026-06-15')
  })

  it('re-syncing the same day replaces the snapshot (idempotent per window)', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)

    const run = async (links: BingInboundLink[]) =>
      executeBingBacklinkSync(db, runId, projectId, {
        resolveConnection: () => ({ apiKey: 'k', siteUrl: 'https://roots.io/' }),
        deps: {
          now: FIXED_NOW,
          getLinkCounts: async () => [{ Url: 'https://roots.io/p', Count: 1 }],
          getUrlLinks: async () => links,
        },
      })

    await run([{ Url: 'https://a.com/1', AnchorText: 'x' }, { Url: 'https://b.com/1', AnchorText: 'y' }])
    await run([{ Url: 'https://a.com/1', AnchorText: 'x' }]) // second sync: only a.com

    const rows = db.select().from(backlinkDomains)
      .where(eq(backlinkDomains.projectId, projectId)).all()
    expect(rows.map((r) => r.linkingDomain)).toEqual(['a.com'])
    const summaries = db.select().from(backlinkSummaries)
      .where(eq(backlinkSummaries.projectId, projectId)).all()
    expect(summaries).toHaveLength(1) // upserted, not duplicated
    expect(summaries[0]!.totalLinkingDomains).toBe(1)
  })

  it('fails the run when no Bing connection resolves', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)
    await expect(
      executeBingBacklinkSync(db, runId, projectId, { resolveConnection: () => undefined, deps: { now: FIXED_NOW } }),
    ).rejects.toThrow(/No Bing Webmaster connection/)
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    expect(run?.error).toMatch(/No Bing Webmaster connection/)
  })

  it('fails the run when the connection has no site URL selected', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)
    await expect(
      executeBingBacklinkSync(db, runId, projectId, {
        resolveConnection: () => ({ apiKey: 'k', siteUrl: null }),
        deps: { now: FIXED_NOW },
      }),
    ).rejects.toThrow(/no verified site/)
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
  })

  it('respects the maxPages cap (most-linked pages first)', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)
    const fetched: string[] = []

    await executeBingBacklinkSync(db, runId, projectId, {
      resolveConnection: () => ({ apiKey: 'k', siteUrl: 'https://roots.io/' }),
      maxPages: 1,
      deps: {
        now: FIXED_NOW,
        getLinkCounts: async () => [
          { Url: 'https://roots.io/low', Count: 1 },
          { Url: 'https://roots.io/high', Count: 99 },
        ],
        getUrlLinks: async (_a, _s, link) => {
          fetched.push(link)
          return [{ Url: 'https://x.com/1', AnchorText: 'q' }]
        },
      },
    })

    // Only the single most-linked page is pulled.
    expect(fetched).toEqual(['https://roots.io/high'])
  })

  it('degrades to partial when some pages fail but others succeed', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)

    await executeBingBacklinkSync(db, runId, projectId, {
      resolveConnection: () => ({ apiKey: 'k', siteUrl: 'https://roots.io/' }),
      deps: {
        now: FIXED_NOW,
        getLinkCounts: async () => [
          { Url: 'https://roots.io/ok', Count: 5 },
          { Url: 'https://roots.io/bad', Count: 3 },
        ],
        getUrlLinks: async (_a, _s, link) => {
          if (link === 'https://roots.io/bad') throw new Error('bing 500')
          return [{ Url: 'https://news.example.org/1', AnchorText: 'a' }]
        },
      },
    })

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('partial')
    expect(run?.error).toMatch(/1 of 2/)
    // The page that succeeded still produced rows — the snapshot isn't discarded.
    const rows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, projectId)).all()
    expect(rows.map((r) => r.linkingDomain)).toEqual(['news.example.org'])
  })

  it('fails the run when every page fetch fails (no partial snapshot)', async () => {
    const db = freshDb()
    const { projectId, runId } = seedProjectAndRun(db)

    await expect(
      executeBingBacklinkSync(db, runId, projectId, {
        resolveConnection: () => ({ apiKey: 'k', siteUrl: 'https://roots.io/' }),
        deps: {
          now: FIXED_NOW,
          getLinkCounts: async () => [
            { Url: 'https://roots.io/a', Count: 5 },
            { Url: 'https://roots.io/b', Count: 3 },
          ],
          getUrlLinks: async () => { throw new Error('bing down') },
        },
      }),
    ).rejects.toThrow(/All 2 Bing inbound-link page/)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    // Nothing is written when the whole pull fails.
    const rows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, projectId)).all()
    expect(rows).toHaveLength(0)
  })
})
