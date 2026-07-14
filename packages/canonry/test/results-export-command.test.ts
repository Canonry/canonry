import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDownloadResultsExport = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ downloadResultsExport: mockDownloadResultsExport }),
}))

const { exportResults } = await import('../src/commands/results-export.js')

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-results-export-command-'))
  vi.clearAllMocks()
  mockDownloadResultsExport.mockResolvedValue({
    content: '{"schemaVersion":"canonry.results-export/v1"}',
    filename: 'canonry-results-demo-2026-07-14.json',
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('canonry results export', () => {
  it('writes the server-suggested attachment to an explicit file path', async () => {
    const output = path.join(tmpDir, 'exports', 'demo.json')
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await exportResults('demo', {
        format: 'json',
        since: '2026-07-01',
        until: '2026-07-14',
        includeProbes: true,
        output,
      })
    } finally {
      console.log = originalLog
    }

    expect(mockDownloadResultsExport).toHaveBeenCalledWith('demo', {
      format: 'json',
      since: '2026-07-01',
      until: '2026-07-14',
      includeProbes: true,
    })
    expect(fs.readFileSync(output, 'utf8')).toBe('{"schemaVersion":"canonry.results-export/v1"}')
    expect(logs.join('\n')).toContain('Results export written to')
  })

  it('writes only the attachment content to stdout when output is -', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await exportResults('demo', { format: 'csv', output: '-' })
    } finally {
      process.stdout.write = originalWrite
    }

    expect(writes).toEqual(['{"schemaVersion":"canonry.results-export/v1"}'])
  })
})
