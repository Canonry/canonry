import fs from 'node:fs'
import path from 'node:path'
import { CC_CACHE_DIR, RELEASE_ID_REGEX } from './constants.js'

export interface CachedReleaseEntry {
  release: string
  bytes: number
  lastUsedAt: string | null
}

export interface CacheOptions {
  cacheDir?: string
}

function cacheRoot(opts: CacheOptions = {}): string {
  return opts.cacheDir ?? CC_CACHE_DIR
}

function directoryBytesAndLastUsed(dir: string): { bytes: number; lastUsedAt: string | null } {
  let bytes = 0
  let latestMtimeMs = 0
  const walk = (p: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      let entries: string[]
      try {
        entries = fs.readdirSync(p)
      } catch {
        return
      }
      for (const e of entries) walk(path.join(p, e))
    } else if (stat.isFile()) {
      bytes += stat.size
      const mtime = Math.max(stat.mtimeMs, stat.atimeMs)
      if (mtime > latestMtimeMs) latestMtimeMs = mtime
    }
  }
  walk(dir)
  return {
    bytes,
    lastUsedAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
  }
}

/** Enumerate on-disk cached releases under the cache directory. */
export function listCachedReleases(opts: CacheOptions = {}): CachedReleaseEntry[] {
  const root = cacheRoot(opts)
  if (!fs.existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const result: CachedReleaseEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!RELEASE_ID_REGEX.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    const stats = directoryBytesAndLastUsed(dir)
    result.push({ release: entry.name, bytes: stats.bytes, lastUsedAt: stats.lastUsedAt })
  }
  result.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
  return result
}

/** Delete the cached gzip files + sidecars for a release. No-op when absent. */
export function pruneCachedRelease(release: string, opts: CacheOptions = {}): void {
  if (!RELEASE_ID_REGEX.test(release)) {
    throw new Error(`Invalid release id: ${release}`)
  }
  const dir = path.join(cacheRoot(opts), release)
  fs.rmSync(dir, { recursive: true, force: true })
}
