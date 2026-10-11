import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mockApply = vi.fn()
const mockPreviewApply = vi.fn()

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>()
  return { ...actual, createApiClient: () => ({ apply: mockApply, previewApply: mockPreviewApply }) }
})

const { applyConfigs } = await import('../src/commands/apply.js')
const { CliError } = await import('../src/cli-error.js')

const YAML = `apiVersion: canonry/v1
kind: Project
metadata:
  name: demo
spec:
  displayName: Demo
  canonicalDomain: example.com
  country: US
  language: en
`

const PREVIEW = {
  project: { id: 'project-1', name: 'demo' }, action: 'update', changed: true,
  configRevision: { before: 1, after: 2 }, fields: { displayName: { before: 'Old', after: 'Demo' } },
  queries: { managed: false, added: [], removed: [], unchangedCount: 0, snapshotsDetached: 0 },
  competitors: { managed: true, added: [], removed: [], aliasChanges: [], droppedAliases: [] },
  schedule: { managed: true, action: 'none', before: null, after: null },
  notifications: { managed: false, added: [], removed: [], kept: [], secretsRotated: 0 }, effects: [],
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => logs.join('\n'))
}

describe('apply --dry-run', () => {
  let tmpFile: string

  beforeEach(() => {
    vi.clearAllMocks()
    mockPreviewApply.mockResolvedValue(PREVIEW)
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-dry-run-')), 'project.yaml')
    fs.writeFileSync(tmpFile, YAML, 'utf8')
  })

  afterEach(() => fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }))

  it('uses preview only and emits equal json and jsonl documents', async () => {
    const json = await captureLog(() => applyConfigs([tmpFile], 'json', { dryRun: true }))
    const jsonl = await captureLog(() => applyConfigs([tmpFile], 'jsonl', { dryRun: true }))
    expect(jsonl).toBe(json)
    expect(JSON.parse(json)).toMatchObject({ dryRun: true, changedCount: 1, errorCount: 0 })
    expect(mockPreviewApply).toHaveBeenCalledTimes(2)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('maps a missing preview route without falling back to apply', async () => {
    mockPreviewApply.mockRejectedValue(new CliError({ code: 'HTTP_ERROR', message: 'Not found', details: { httpStatus: 404 } }))
    await expect(applyConfigs([tmpFile], 'json', { dryRun: true })).rejects.toMatchObject({ code: 'APPLY_PREVIEW_UNSUPPORTED' })
    expect(mockApply).not.toHaveBeenCalled()
  })
})
