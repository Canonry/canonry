import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { BacklinksInstallStatusDto } from '@ainyc/canonry-contracts'

const mockBacklinksStatus = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    backlinksStatus: mockBacklinksStatus,
  }),
}))

/** Capture console.log lines (the machine + human paths both go to console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { backlinksDoctor } = await import('../src/commands/backlinks.js')

const status: BacklinksInstallStatusDto = {
  duckdbInstalled: true,
  duckdbVersion: '1.1.0',
  duckdbSpec: 'duckdb@1.1.0',
  pluginDir: '/home/u/.canonry/plugins',
}

describe('backlinksDoctor — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBacklinksStatus.mockResolvedValue(status)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => backlinksDoctor({ format: 'json' }))
    const jsonlOut = await captureLog(() => backlinksDoctor({ format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(status)
  })

  it('format=jsonl does NOT print the human DuckDB status block', async () => {
    const out = await captureLog(() => backlinksDoctor({ format: 'jsonl' }))
    expect(out).not.toMatch(/DuckDB: installed/)
    // It IS parseable JSON.
    expect(JSON.parse(out)).toEqual(status)
  })

  it('no format → human status block is unchanged', async () => {
    const out = await captureLog(() => backlinksDoctor({}))
    expect(out).toMatch(/DuckDB: installed/)
    expect(out).toMatch(/Version: 1\.1\.0/)
    expect(() => JSON.parse(out)).toThrow()
  })
})
