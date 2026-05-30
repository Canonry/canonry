import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mockApply = vi.fn()

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>()
  return {
    ...actual,
    createApiClient: () => ({ apply: mockApply }),
  }
})

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
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

const { applyConfigs } = await import('../src/commands/apply.js')

const YAML = `apiVersion: canonry/v1
kind: Project
metadata:
  name: demo
spec:
  canonicalDomain: example.com
`

describe('applyConfigs — jsonl degrades to the json document', () => {
  let tmpFile: string

  beforeEach(() => {
    vi.clearAllMocks()
    mockApply.mockResolvedValue({ name: 'demo', configRevision: 7 })
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-')), 'project.yaml')
    fs.writeFileSync(tmpFile, YAML, 'utf-8')
  })

  afterEach(() => {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true })
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => applyConfigs([tmpFile], 'json'))
    const jsonlOut = await captureLog(() => applyConfigs([tmpFile], 'jsonl'))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toMatchObject({ appliedCount: 1, errorCount: 0 })
  })

  it('format=jsonl does NOT print the human "Applied config" line', async () => {
    const out = await captureLog(() => applyConfigs([tmpFile], 'jsonl'))
    expect(out).not.toMatch(/Applied config for/)
  })

  it('no format → human text output is unchanged (prints "Applied config")', async () => {
    const out = await captureLog(() => applyConfigs([tmpFile], undefined))
    expect(out).toMatch(/Applied config for "demo" \(revision 7\)/)
    expect(() => JSON.parse(out)).toThrow()
  })
})
