import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli } from './cli-test-utils.js'

// `canonry competitor aliases` and `competitor add --alias` against a real
// server: same data and shape as the API, no prompts, usage errors exit 1.

describe('competitor alias CLI', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-competitor-aliases-cli-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    const db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()
    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKeyPlain)
    await client.putProject('roofwise', { displayName: 'Roofwise', canonicalDomain: 'roofwise.example', country: 'US', language: 'en' })
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adds a competitor with --alias and reports its aliases in JSON', async () => {
    const result = await invokeCli(['competitor', 'add', 'roofwise', 'www.sealfoamworks.example', '--alias', 'FoamSeal', '--alias', 'Foam Seal', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      project: 'roofwise',
      domains: ['sealfoamworks.example'],
      addedDomains: ['sealfoamworks.example'],
      addedCount: 1,
      aliases: { domain: 'sealfoamworks.example', aliases: ['FoamSeal', 'Foam Seal'] },
    })
    expect((await client.listCompetitors('roofwise')).map(c => c.aliases)).toEqual([['FoamSeal', 'Foam Seal']])
  })

  it('refuses --alias with more than one domain', async () => {
    const result = await invokeCli(['competitor', 'add', 'roofwise', 'a.example', 'b.example', '--alias', 'Alpha', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--alias names one competitor, so pass exactly one domain',
    })
  })

  it('reads, sets, adds, removes and clears aliases with the API response shape', async () => {
    await client.appendCompetitors('roofwise', ['qvx.example'])

    const read = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example', '--format', 'json'])
    expect(JSON.parse(read.stdout)).toMatchObject({ domain: 'qvx.example', aliases: [] })

    const set = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example', '--set', 'QVX', '--set', 'QVX Stores', '--format', 'json'])
    expect(set.exitCode).toBeUndefined()
    const setBody = JSON.parse(set.stdout) as { id: string; domain: string; aliases: string[]; createdAt: string }
    expect(Object.keys(setBody).sort()).toEqual(['aliases', 'createdAt', 'domain', 'id'])
    expect(setBody.aliases).toEqual(['QVX', 'QVX Stores'])

    const added = await invokeCli(['competitor', 'aliases', 'roofwise', 'shop.qvx.example', '--add', 'Quiet Vox Supply', '--remove', 'qvx stores', '--format', 'json'])
    expect(JSON.parse(added.stdout).aliases).toEqual(['QVX', 'Quiet Vox Supply'])

    const text = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example'])
    expect(text.stdout).toBe('Aliases for qvx.example: QVX, Quiet Vox Supply')

    const list = await invokeCli(['competitor', 'list', 'roofwise'])
    expect(list.stdout).toContain('  qvx.example  (aliases: QVX, Quiet Vox Supply)')

    const cleared = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example', '--clear', '--format', 'json'])
    expect(JSON.parse(cleared.stdout).aliases).toEqual([])
    expect((await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example'])).stdout).toBe('Aliases for qvx.example: (none)')
  })

  it('surfaces the server validation error and exits 1', async () => {
    await client.appendCompetitors('roofwise', ['qvx.example'])
    const result = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example', '--set', 'Roofwise', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const error = JSON.parse(result.stderr).error as { code: string; message: string }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toContain('"Roofwise" is one of the project\'s own brand names')
  })

  it('reports an untracked competitor and conflicting flags as user errors', async () => {
    const missing = await invokeCli(['competitor', 'aliases', 'roofwise', 'nobody.example', '--add', 'Nobody', '--format', 'json'])
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stderr).error).toMatchObject({ code: 'NOT_FOUND', details: { project: 'roofwise', domain: 'nobody.example' } })

    const conflict = await invokeCli(['competitor', 'aliases', 'roofwise', 'qvx.example', '--set', 'QVX', '--add', 'Other', '--format', 'json'])
    expect(conflict.exitCode).toBe(1)
    expect(JSON.parse(conflict.stderr).error.code).toBe('CLI_USAGE_ERROR')

    const noDomain = await invokeCli(['competitor', 'aliases', 'roofwise', '--format', 'json'])
    expect(noDomain.exitCode).toBe(1)
    expect(JSON.parse(noDomain.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR', message: 'competitor domain is required' })
  })

  it('documents the command in contextual help', async () => {
    const result = await invokeCli(['competitor', 'aliases', '--help'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('canonry competitor aliases <project> <domain> [--set <name>]... [--add <name>]... [--remove <name>]... [--clear] [--format json]')
    const add = await invokeCli(['competitor', 'add', '--help'])
    expect(add.stdout).toContain('canonry competitor add <project> <domain...> [--alias <name>]... [--format json]')
  })
})
