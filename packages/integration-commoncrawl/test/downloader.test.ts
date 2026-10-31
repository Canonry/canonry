import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
    let finishBody!: () => void
    const heldBody = new Promise<void>((resolve) => { finishBody = resolve })
    const response = new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(body.slice(0, 2))
        await heldBody
        controller.enqueue(body.slice(2))
        controller.close()
      },
    }), { headers: { 'content-length': '5' } })
    const download = downloadFile({
      url: 'https://example.test/blob',
      destPath: dest,
      fetchImpl: async () => response,
    })
    try {
      await vi.waitFor(async () => {
        const files = await fs.readdir(tmpDir)
        expect(files).toHaveLength(1)
        expect(await fs.readFile(path.join(tmpDir, files[0]!))).toEqual(Buffer.from([1, 2]))
      })
      await expect(fs.access(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      finishBody()
      await download
    }
    const result = await download

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
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 3))
          controller.enqueue(body.slice(3))
          controller.close()
        },
      }), { headers: { 'content-length': '8' } }),
    })
    expect(progress).toEqual([{ bytes: 3, total: 8 }, { bytes: 8, total: 8 }])
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
