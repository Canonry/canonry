import { ccReleasePaths } from './constants.js'
import { formatReleaseId } from './release-id.js'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const

/** Build the `mon-mon-mon` window slug for a window whose FIRST month is `firstMonthIndex` (0-11). */
function windowSlug(firstMonthIndex: number): string {
  const a = MONTHS[firstMonthIndex % 12]
  const b = MONTHS[(firstMonthIndex + 1) % 12]
  const c = MONTHS[(firstMonthIndex + 2) % 12]
  return `${a}-${b}-${c}`
}

export interface ProbedRelease {
  release: string
  vertexUrl: string
  edgesUrl: string
  vertexBytes: number | null
  edgesBytes: number | null
  lastModified: string | null
}

export interface ProbeOptions {
  now?: Date
  /** How many months to walk back from `now`, inclusive. Default 14 (15 candidate windows). */
  maxMonthsBack?: number
  fetchImpl?: typeof fetch
}

/**
 * Generate candidate releases newest-first by walking the window's FIRST month
 * back one month at a time from `now`. Common Crawl names a release by its first
 * month's year, so the wrapped 2nd/3rd months never change the slug year
 * (`cc-main-2025-oct-nov-dec` = Oct/Nov/Dec 2025). Cross-year windows (first
 * month Nov/Dec) are generated and probed too — they 404 today but cost one HEAD
 * pair and future-proof discovery if Common Crawl ever publishes them.
 */
function probeCandidates(now: Date, maxMonthsBack: number): { year: number; window: string }[] {
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth() // 0-11, the candidate window's FIRST month
  const out: { year: number; window: string }[] = []
  for (let step = 0; step <= maxMonthsBack; step++) {
    out.push({ year, window: windowSlug(month) })
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
  }
  return out
}

export async function probeRelease(release: string, fetchImpl: typeof fetch = fetch): Promise<ProbedRelease | null> {
  const paths = ccReleasePaths(release)
  const [vertex, edges] = await Promise.all([
    fetchImpl(paths.vertexUrl, { method: 'HEAD' }),
    fetchImpl(paths.edgesUrl, { method: 'HEAD' }),
  ])
  if (!vertex.ok || !edges.ok) return null
  return {
    release,
    vertexUrl: paths.vertexUrl,
    edgesUrl: paths.edgesUrl,
    vertexBytes: parseContentLength(vertex.headers.get('content-length')),
    edgesBytes: parseContentLength(edges.headers.get('content-length')),
    lastModified: vertex.headers.get('last-modified'),
  }
}

export async function probeLatestRelease(opts: ProbeOptions = {}): Promise<ProbedRelease | null> {
  const now = opts.now ?? new Date()
  const maxBack = opts.maxMonthsBack ?? 14
  const fetchImpl = opts.fetchImpl ?? fetch
  const candidates = probeCandidates(now, maxBack)
  for (const { year, window } of candidates) {
    const release = formatReleaseId(year, window)
    const result = await probeRelease(release, fetchImpl)
    if (result) return result
  }
  return null
}

export async function probeRecentReleases(opts: ProbeOptions & { limit?: number } = {}): Promise<ProbedRelease[]> {
  const now = opts.now ?? new Date()
  const maxBack = opts.maxMonthsBack ?? 14
  const fetchImpl = opts.fetchImpl ?? fetch
  const limit = opts.limit ?? 8
  const candidates = probeCandidates(now, maxBack)
  const out: ProbedRelease[] = []
  for (const { year, window } of candidates) {
    if (out.length >= limit) break
    const release = formatReleaseId(year, window)
    const result = await probeRelease(release, fetchImpl)
    if (result) out.push(result)
  }
  return out
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}
