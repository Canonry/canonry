import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, runs } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'

describe('cancelRun command', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-cancel-cmd-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: hashed, keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)

    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function insertQueuedRun(): Promise<string> {
    const project = await client.getProject('test-proj') as { id: string }
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId: project.id,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }).run()
    return runId
  }

  it('cancels a run by explicit run ID and outputs confirmation', async () => {
    const runId = await insertQueuedRun()

    const { cancelRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await cancelRun('test-proj', runId)
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toContain(runId)
    expect(output).toContain('cancelled')
  })

  it('auto-detects and cancels the active run when no run ID given', async () => {
    const runId = await insertQueuedRun()

    const { cancelRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await cancelRun('test-proj')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toContain(runId)
    expect(output).toContain('cancelled')
  })

  it('throws an actionable CLI error when no active run exists', async () => {
    const { cancelRun } = await import('../src/commands/run.js')
    await expect(cancelRun('test-proj')).rejects.toBeInstanceOf(CliError)

    try {
      await cancelRun('test-proj')
    } catch (err) {
      const cliErr = err as CliError
      expect(cliErr.code).toBe('NO_ACTIVE_RUN')
      expect(cliErr.message).toMatch(/No active run found/)
      expect(cliErr.displayMessage).toMatch(/canonry run cancel/)
      expect(cliErr.displayMessage).toMatch(/no active run found/)
      expect(cliErr.displayMessage).toMatch(/canonry status/)
    }
  })

  it('outputs JSON with status cancelled when format is json', async () => {
    const runId = await insertQueuedRun()

    const { cancelRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await cancelRun('test-proj', runId, 'json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n'))
    expect(parsed.id).toBe(runId)
    expect(parsed.status).toBe('cancelled')
  })
})
