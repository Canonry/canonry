import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('query commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-q-test-${crypto.randomUUID()}`)
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
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: hashed, keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKeyPlain)

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
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removeQueries prints the count of actually deleted queries', async () => {
    await client.appendQueries('test-proj', ['aeo tools', 'answer engine'])

    const { removeQueries } = await import('../src/commands/query.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await removeQueries('test-proj', ['aeo tools'])
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/Removed 1 query from "test-proj"/)
  })

  it('removeQueries reports 0 when none of the requested queries exist', async () => {
    const { removeQueries } = await import('../src/commands/query.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await removeQueries('test-proj', ['does not exist'])
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/Removed 0 queries from "test-proj"/)
  })

  it('removeQueries counts only the queries that actually existed', async () => {
    await client.appendQueries('test-proj', ['real phrase'])

    const { removeQueries } = await import('../src/commands/query.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await removeQueries('test-proj', ['real phrase', 'phantom phrase'])
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/Removed 1 query from "test-proj"/)
  })

  it('query add and query list report the class the server gave each query', async () => {
    // The project is "Test" at example.com, so a query naming Test is branded.
    const added = await invokeCli(['query', 'add', 'test-proj', 'is Test worth it', 'answer engine tools', '--format', 'json'])
    expect(added.exitCode).toBeUndefined()
    expect(parseJsonOutput(added.stdout)).toEqual({
      project: 'test-proj',
      queries: ['is Test worth it', 'answer engine tools'],
      addedCount: 2,
      queryClasses: [
        { query: 'is Test worth it', queryClass: 'branded' },
        { query: 'answer engine tools', queryClass: 'non-brand' },
      ],
    })

    const addedText = await invokeCli(['query', 'add', 'test-proj', 'test pricing'])
    expect(addedText.stdout).toBe('Added 1 query to "test-proj".\n  branded    test pricing')

    const listed = parseJsonOutput((await invokeCli(['query', 'list', 'test-proj', '--format', 'json'])).stdout) as Array<{ query: string; queryClass: string | null }>
    expect(Object.fromEntries(listed.map(row => [row.query, row.queryClass]))).toEqual({
      'is Test worth it': 'branded',
      'answer engine tools': 'non-brand',
      'test pricing': 'branded',
    })

    const listedText = (await invokeCli(['query', 'list', 'test-proj'])).stdout.split('\n')
    expect(listedText.slice(0, 3)).toEqual(['Queries for "test-proj" (3):', '', '  CLASS      QUERY'])
    expect(listedText.slice(3).sort()).toEqual([
      '  branded    is Test worth it',
      '  branded    test pricing',
      '  non-brand  answer engine tools',
    ])
  })

  it('legacy keyword CLI aliases the canonical query store', async () => {
    const addResult = await invokeCli([
      'keyword',
      'add',
      'test-proj',
      'legacy phrase',
      '--format',
      'json',
    ])
    expect(addResult.exitCode).toBeUndefined()
    expect(addResult.stderr).toBe('')
    expect(parseJsonOutput(addResult.stdout)).toMatchObject({
      project: 'test-proj',
      keywords: ['legacy phrase'],
      addedCount: 1,
    })

    const queries = await client.listQueries('test-proj')
    expect(queries.map(q => q.query)).toEqual(['legacy phrase'])

    const listResult = await invokeCli(['keyword', 'list', 'test-proj', '--format', 'json'])
    expect(listResult.exitCode).toBeUndefined()
    expect(parseJsonOutput(listResult.stdout)).toMatchObject([
      { keyword: 'legacy phrase' },
    ])
  })
})
