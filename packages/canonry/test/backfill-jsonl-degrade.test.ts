import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { backfillNormalizedPathsCommand } from '../src/commands/backfill.js'

/**
 * `backfill normalized-paths` is the representative command for backfill.ts:
 * its machine-output gate used to read `format === 'json'`, so `--format jsonl`
 * fell straight into the decorated human-text branch. The gate now degrades —
 * both `json` and `jsonl` emit the same JSON document; human/text is unchanged.
 *
 * Uses a real temp DB through CANONRY_CONFIG_DIR like the sibling backfill tests.
 */
describe('backfill — jsonl degrades to the json document', () => {
  let tmpDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-degrade-'))
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      JSON.stringify({
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: 'cnry_test_key',
        providers: {},
      }),
      'utf-8',
    )

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_1',
      name: 'test-project',
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

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

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => backfillNormalizedPathsCommand({ format: 'json' }))
    const jsonlOut = await captureLog(() => backfillNormalizedPathsCommand({ format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    // The payload itself: no project filter → project null, nothing to examine.
    expect(JSON.parse(jsonlOut)).toEqual({
      project: null,
      examined: 0,
      updated: 0,
      unchanged: 0,
    })
  })

  it('format=jsonl does NOT print the human summary block', async () => {
    const out = await captureLog(() => backfillNormalizedPathsCommand({ format: 'jsonl' }))
    expect(out).not.toMatch(/Normalized-path backfill complete/)
    expect(JSON.parse(out)).toMatchObject({ examined: 0 })
  })

  it('no format → human summary block is unchanged', async () => {
    const out = await captureLog(() => backfillNormalizedPathsCommand({}))
    expect(out).toMatch(/Normalized-path backfill complete\./)
    expect(out).toMatch(/Examined:/)
    expect(() => JSON.parse(out)).toThrow()
  })
})
