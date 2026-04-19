import { ccReleasePaths } from './constants.js'
import { formatReleaseId, type ParsedRelease } from './release-id.js'

const QUARTERS: ParsedRelease['quarter'][] = [
  'oct-nov-dec',
  'jul-aug-sep',
  'apr-may-jun',
  'jan-feb-mar',
]

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
  maxQuartersBack?: number
  fetchImpl?: typeof fetch
}

function probeCandidates(now: Date, maxBack: number): { year: number; quarter: ParsedRelease['quarter'] }[] {
  const year = now.getUTCFullYear()
  const out: { year: number; quarter: ParsedRelease['quarter'] }[] = []
  for (let y = year; y >= year - maxBack; y--) {
    for (const q of QUARTERS) {
      out.push({ year: y, quarter: q })
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
  const maxBack = opts.maxQuartersBack ?? 3
  const fetchImpl = opts.fetchImpl ?? fetch
  const candidates = probeCandidates(now, maxBack)
  for (const { year, quarter } of candidates) {
    const release = formatReleaseId(year, quarter)
    const result = await probeRelease(release, fetchImpl)
    if (result) return result
  }
  return null
}

export async function probeRecentReleases(opts: ProbeOptions & { limit?: number } = {}): Promise<ProbedRelease[]> {
  const now = opts.now ?? new Date()
  const maxBack = opts.maxQuartersBack ?? 3
  const fetchImpl = opts.fetchImpl ?? fetch
  const limit = opts.limit ?? 8
  const candidates = probeCandidates(now, maxBack)
  const out: ProbedRelease[] = []
  for (const { year, quarter } of candidates) {
    if (out.length >= limit) break
    const release = formatReleaseId(year, quarter)
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
