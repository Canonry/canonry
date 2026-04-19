import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { downloadFile } from '../src/downloader.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-download-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function okResponse(body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-length': String(body.length) },
  })
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('downloadFile', () => {
  test('writes the full body via atomic rename, hashes it, and reports uncached', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5])
    const dest = path.join(tmpDir, 'out.bin')
    const result = await downloadFile({
      url: 'https://example.test/blob',
      destPath: dest,
      fetchImpl: async () => okResponse(body),
    })

    expect(result.cached).toBe(false)
    expect(result.bytes).toBe(body.length)
    expect(result.sha256).toBe(sha256(body))
    await expect(fs.readFile(dest)).resolves.toEqual(Buffer.from(body))
    await expect(fs.readFile(`${dest}.sha256`, 'utf8')).resolves.toBe(`${result.sha256}\n`)
    await expect(fs.access(`${dest}.partial`)).rejects.toBeTruthy()
  })

  test('second call hits cache via sidecar and does not invoke fetch', async () => {
    const body = new Uint8Array([9, 8, 7, 6])
    const dest = path.join(tmpDir, 'out.bin')
    await downloadFile({ url: 'https://x', destPath: dest, fetchImpl: async () => okResponse(body) })

    let called = 0
    const second = await downloadFile({
      url: 'https://x',
      destPath: dest,
      fetchImpl: async () => {
        called += 1
        throw new Error('should not be called')
      },
    })
    expect(called).toBe(0)
    expect(second.cached).toBe(true)
    expect(second.sha256).toBe(sha256(body))
  })

  test('rehashes when sidecar is missing and writes a fresh sidecar', async () => {
    const body = new Uint8Array([1, 2, 3])
    const dest = path.join(tmpDir, 'out.bin')
    await downloadFile({ url: 'https://x', destPath: dest, fetchImpl: async () => okResponse(body) })
    await fs.unlink(`${dest}.sha256`)

    const result = await downloadFile({
      url: 'https://x',
      destPath: dest,
      fetchImpl: async () => { throw new Error('not reached') },
    })
    expect(result.cached).toBe(true)
    expect(result.sha256).toBe(sha256(body))
    await expect(fs.readFile(`${dest}.sha256`, 'utf8')).resolves.toBe(`${result.sha256}\n`)
  })

  test('invokes onProgress with running byte counts', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const dest = path.join(tmpDir, 'out.bin')
    const progress: { bytes: number; total: number | null }[] = []
    await downloadFile({
      url: 'https://x',
      destPath: dest,
      onProgress: (bytes, total) => progress.push({ bytes, total }),
      fetchImpl: async () => okResponse(body),
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)?.bytes).toBe(body.length)
    expect(progress.at(-1)?.total).toBe(body.length)
  })

  test('throws on HTTP error and leaves no dest file behind', async () => {
    const dest = path.join(tmpDir, 'nope.bin')
    await expect(
      downloadFile({
        url: 'https://x',
        destPath: dest,
        fetchImpl: async () => new Response('nope', { status: 500, statusText: 'Server Error' }),
      }),
    ).rejects.toThrow(/HTTP 500/)
    await expect(fs.access(dest)).rejects.toBeTruthy()
  })
})
