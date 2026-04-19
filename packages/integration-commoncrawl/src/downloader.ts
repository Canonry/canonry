import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'

export interface DownloadOptions {
  url: string
  destPath: string
  onProgress?: (bytesSoFar: number, totalBytes: number | null) => void
  fetchImpl?: typeof fetch
}

export interface DownloadResult {
  bytes: number
  sha256: string
  cached: boolean
  elapsedMs: number
}

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const start = Date.now()
  const fetchImpl = opts.fetchImpl ?? fetch
  const sidecarPath = `${opts.destPath}.sha256`

  try {
    const stat = await fs.stat(opts.destPath)
    const sidecar = await readSidecar(sidecarPath)
    const sha256 = sidecar ?? await hashFile(opts.destPath)
    if (!sidecar) await writeSidecar(sidecarPath, sha256)
    return { bytes: stat.size, sha256, cached: true, elapsedMs: Date.now() - start }
  } catch {
    // not cached — download fresh
  }

  const partialPath = `${opts.destPath}.partial`
  await fs.mkdir(path.dirname(opts.destPath), { recursive: true })
  await unlinkIfExists(partialPath)

  const res = await fetchImpl(opts.url)
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${opts.url}`)
  }

  const total = parseContentLength(res.headers.get('content-length'))
  const hasher = createHash('sha256')
  let bytes = 0

  const hashAndCount = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hasher.update(chunk)
      bytes += chunk.length
      opts.onProgress?.(bytes, total)
      cb(null, chunk)
    },
  })

  await pipeline(
    Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>),
    hashAndCount,
    createWriteStream(partialPath),
  )

  const sha256 = hasher.digest('hex')
  await fs.rename(partialPath, opts.destPath)
  await writeSidecar(sidecarPath, sha256)

  return { bytes, sha256, cached: false, elapsedMs: Date.now() - start }
}

async function hashFile(filePath: string): Promise<string> {
  const hasher = createHash('sha256')
  const handle = await fs.open(filePath, 'r')
  try {
    const stream = handle.createReadStream()
    for await (const chunk of stream) hasher.update(chunk as Buffer)
  } finally {
    await handle.close()
  }
  return hasher.digest('hex')
}

async function readSidecar(sidecarPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8')
    const trimmed = raw.trim()
    return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null
  } catch {
    return null
  }
}

async function writeSidecar(sidecarPath: string, sha256: string): Promise<void> {
  await fs.writeFile(sidecarPath, `${sha256}\n`)
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch {
    // ignore
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}
