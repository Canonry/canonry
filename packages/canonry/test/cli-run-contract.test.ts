import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, runs } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli } from './cli-test-utils.js'

describe('run lifecycle CLI contract', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let origCi: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-cli-run-contract-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    origCi = process.env.CI
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    process.env.CI = '1'

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: hashed,
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({
      config: config as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
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
    if (origTelemetryDisabled === undefined) {
      delete process.env.CANONRY_TELEMETRY_DISABLED
    } else {
      process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    }
    if (origCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = origCi
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function insertRun(opts?: { status?: string; createdAt?: string }): Promise<string> {
    const project = await client.getProject('test-proj') as { id: string }
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId: project.id,
      status: opts?.status ?? 'queued',
      createdAt: opts?.createdAt ?? new Date().toISOString(),
    }).run()
    return runId
  }

  it('prints a JSON usage error for run cancel with missing project', async () => {
    const result = await invokeCli(['run', 'cancel', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('run.cancel')
    expect(parsed.error.details.usage).toBe('canonry run cancel <project> [run-id]')
  })

  it('prints a JSON error envelope when run cancel has no active run', async () => {
    const result = await invokeCli(['run', 'cancel', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string
        message: string
        details: { project: string; suggestedCommands: string[] }
      }
    }
    expect(parsed.error.code).toBe('NO_ACTIVE_RUN')
    expect(parsed.error.message).toBe('No active run found for project "test-proj"')
    expect(parsed.error.details.project).toBe('test-proj')
    expect(parsed.error.details.suggestedCommands).toContain('canonry status test-proj')
  })

  it('prints a JSON usage error when run --all is combined with a project name', async () => {
    const result = await invokeCli(['run', '--all', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('--all cannot be combined with a project name')
    expect(parsed.error.details.usage).toMatch(/canonry run --all/)
  })

  it('prints JSON to stdout for runs <project> --format json', async () => {
    await insertRun()

    const result = await invokeCli(['runs', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; status: string }>
    expect(parsed).toBeInstanceOf(Array)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.status).toBe('queued')
  })

  it('supports runs <project> --limit <n> in JSON mode', async () => {
    const olderRunId = await insertRun({
      status: 'completed',
      createdAt: new Date(Date.now() + 10_000).toISOString(),
    })
    const latestRunId = await insertRun({
      status: 'completed',
      createdAt: new Date(Date.now() + 20_000).toISOString(),
    })

    const result = await invokeCli(['runs', 'test-proj', '--limit', '1', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as Array<{ id: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe(latestRunId)
    expect(parsed[0]?.id).not.toBe(olderRunId)
  })

  it('prints a JSON usage error for runs <project> --limit with a non-integer value', async () => {
    const result = await invokeCli(['runs', 'test-proj', '--limit', 'bogus', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string; option: string; value: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('--limit must be an integer')
    expect(parsed.error.details.command).toBe('runs')
    expect(parsed.error.details.option).toBe('limit')
    expect(parsed.error.details.value).toBe('bogus')
  })
})
