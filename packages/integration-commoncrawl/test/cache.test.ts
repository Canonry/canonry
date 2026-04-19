import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listCachedReleases, pruneCachedRelease } from '../src/cache.js'

describe('listCachedReleases', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cache-'))
  })

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true })
  })

  it('returns an empty array when the cache dir does not exist', () => {
    expect(listCachedReleases({ cacheDir: path.join(cacheDir, 'missing') })).toEqual([])
  })

  it('returns an empty array when the cache dir is empty', () => {
    expect(listCachedReleases({ cacheDir })).toEqual([])
  })

  it('returns only directories that match the release-id regex', async () => {
    await fs.mkdir(path.join(cacheDir, 'cc-main-2026-jan-feb-mar'))
    await fs.mkdir(path.join(cacheDir, 'not-a-release'))
    await fs.writeFile(path.join(cacheDir, 'stray.txt'), 'x')

    const rows = listCachedReleases({ cacheDir })
    expect(rows.map((r) => r.release)).toEqual(['cc-main-2026-jan-feb-mar'])
  })

  it('aggregates bytes and reports a last-used timestamp per release', async () => {
    const release = 'cc-main-2026-jan-feb-mar'
    const dir = path.join(cacheDir, release)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, `${release}-domain-vertices.txt.gz`), Buffer.alloc(1024))
    await fs.writeFile(path.join(dir, `${release}-domain-edges.txt.gz`), Buffer.alloc(2048))

    const rows = listCachedReleases({ cacheDir })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.release).toBe(release)
    expect(rows[0]!.bytes).toBe(3072)
    expect(rows[0]!.lastUsedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('sorts releases by lastUsedAt descending (newest first)', async () => {
    const older = 'cc-main-2025-oct-nov-dec'
    const newer = 'cc-main-2026-jan-feb-mar'
    await fs.mkdir(path.join(cacheDir, older))
    await fs.mkdir(path.join(cacheDir, newer))
    await fs.writeFile(path.join(cacheDir, older, 'a'), 'x')
    // Force different mtimes
    await new Promise((r) => setTimeout(r, 20))
    await fs.writeFile(path.join(cacheDir, newer, 'a'), 'x')

    const rows = listCachedReleases({ cacheDir })
    expect(rows.map((r) => r.release)).toEqual([newer, older])
  })
})

describe('pruneCachedRelease', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cache-'))
  })

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true })
  })

  it('removes the release directory and all its files', async () => {
    const release = 'cc-main-2026-jan-feb-mar'
    const dir = path.join(cacheDir, release)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'a'), 'x')

    pruneCachedRelease(release, { cacheDir })
    await expect(fs.access(dir)).rejects.toThrow()
  })

  it('is a no-op when the directory does not exist', () => {
    expect(() => pruneCachedRelease('cc-main-2026-jan-feb-mar', { cacheDir })).not.toThrow()
  })

  it('rejects invalid release ids', () => {
    expect(() => pruneCachedRelease('not-valid', { cacheDir })).toThrow(/Invalid release id/)
  })
})
