import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { apiKeys, competitors, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
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
  let db: DatabaseClient
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
    db = createClient(dbPath)
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
    await client.putProject('rotorwise', { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' })
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
    const result = await invokeCli(['competitor', 'add', 'rotorwise', 'www.spoketuneworks.example', '--alias', 'TuneSpoke', '--alias', 'Tune Spoke', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    const body = JSON.parse(result.stdout) as Record<string, unknown> & { competitor: Record<string, unknown> }
    expect(body).toMatchObject({
      project: 'rotorwise',
      domains: ['spoketuneworks.example'],
      addedDomains: ['spoketuneworks.example'],
      addedCount: 1,
      competitor: { domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Tune Spoke'] },
    })
    // `competitor` is the API's CompetitorDto, the same shape `competitor list` returns.
    expect(Object.keys(body.competitor).sort()).toEqual(['aliases', 'autoAliases', 'blockedAliases', 'createdAt', 'domain', 'id'])
    expect((await client.listCompetitors('rotorwise')).map(c => c.aliases)).toEqual([['TuneSpoke', 'Tune Spoke']])
  })

  it('refuses --alias with more than one domain', async () => {
    const result = await invokeCli(['competitor', 'add', 'rotorwise', 'a.example', 'b.example', '--alias', 'Alpha', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--alias names one competitor, so pass exactly one domain',
    })
  })

  it('reads, sets, adds, removes and clears aliases with the API response shape', async () => {
    await client.appendCompetitors('rotorwise', ['qvx.example'])

    const read = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--format', 'json'])
    expect(JSON.parse(read.stdout)).toMatchObject({ domain: 'qvx.example', aliases: [] })

    const set = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--set', 'QVX', '--set', 'QVX Stores', '--format', 'json'])
    expect(set.exitCode).toBeUndefined()
    const setBody = JSON.parse(set.stdout) as { id: string; domain: string; aliases: string[]; createdAt: string }
    expect(Object.keys(setBody).sort()).toEqual(['aliases', 'autoAliases', 'blockedAliases', 'createdAt', 'domain', 'id'])
    expect(setBody.aliases).toEqual(['QVX', 'QVX Stores'])

    const edited = await invokeCli(['competitor', 'aliases', 'rotorwise', 'shop.qvx.example', '--add', 'Quiet Vox Supply', '--remove', 'qvx stores', '--format', 'json'])
    expect(JSON.parse(edited.stdout).aliases).toEqual(['QVX', 'Quiet Vox Supply'])

    // --add alone appends server-side in one call (POST with { domain, aliases })
    // instead of writing back a locally edited list.
    await client.setCompetitorAliases('rotorwise', 'qvx.example', ['QVX', 'Quiet Vox Supply', 'QVX Depot'])
    const appended = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--add', 'QVX Outlet', '--format', 'json'])
    expect(appended.exitCode).toBeUndefined()
    expect(JSON.parse(appended.stdout).aliases).toEqual(['QVX', 'Quiet Vox Supply', 'QVX Depot', 'QVX Outlet'])
    await client.setCompetitorAliases('rotorwise', 'qvx.example', ['QVX', 'Quiet Vox Supply'])

    const text = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example'])
    expect(text.stdout).toBe([
      'Aliases for qvx.example: QVX, Quiet Vox Supply',
      'Auto-detected from stored answers: (none)',
      'Blocked from auto-detection: (none)',
    ].join('\n'))

    const list = await invokeCli(['competitor', 'list', 'rotorwise'])
    expect(list.stdout).toContain('  qvx.example  (aliases: QVX, Quiet Vox Supply)')

    const cleared = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--clear', '--format', 'json'])
    expect(JSON.parse(cleared.stdout).aliases).toEqual([])
    expect((await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example'])).stdout.split('\n')[0]).toBe('Aliases for qvx.example: (none)')
  })

  it('surfaces the server validation error and exits 1', async () => {
    await client.appendCompetitors('rotorwise', ['qvx.example'])
    const result = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--set', 'Rotorwise', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const error = JSON.parse(result.stderr).error as { code: string; message: string }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toContain('"Rotorwise" is one of the project\'s own brand names')
  })

  it('finds a competitor stored as a subdomain by its registrable domain, and reports its removal', async () => {
    // A row an older build's discovery promote stored without normalizing.
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    db.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      domain: 'offers.spoketuneworks.example',
      provenance: 'discovery:legacy',
      createdAt: new Date().toISOString(),
    }).run()

    const added = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--add', 'TuneSpoke', '--format', 'json'])
    expect(added.exitCode, added.stderr).toBeUndefined()
    expect(JSON.parse(added.stdout)).toMatchObject({ domain: 'offers.spoketuneworks.example', aliases: ['TuneSpoke'] })
    expect((await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example'])).stdout)
      .toContain('Aliases for offers.spoketuneworks.example: TuneSpoke\n')

    const removed = await invokeCli(['competitor', 'remove', 'rotorwise', 'spoketuneworks.example', '--format', 'json'])
    expect(removed.exitCode, removed.stderr).toBeUndefined()
    expect(JSON.parse(removed.stdout)).toEqual({ project: 'rotorwise', domains: [], removedDomains: ['offers.spoketuneworks.example'], removedCount: 1 })
  })

  it('refuses a competitor stored as two rows with a remove-then-add hint that restates its aliases', async () => {
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    for (const [domain, aliases] of [['spoketuneworks.example', ['TuneSpoke']], ['offers.spoketuneworks.example', ['Spoke Tune Pros']]] as const) {
      db.insert(competitors).values({ id: crypto.randomUUID(), projectId: project.id, domain, aliases: [...aliases], provenance: 'discovery:legacy', createdAt: new Date().toISOString() }).run()
    }
    const addAgain = 'canonry competitor add rotorwise spoketuneworks.example --alias "Spoke Tune Pros" --alias "TuneSpoke"'

    // A local edit (--add) refuses before writing, naming the aliases to restate.
    const local = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--add', 'Tune Spoke Crew', '--format', 'json'])
    expect(local.exitCode).toBe(1)
    const localError = JSON.parse(local.stderr).error as { code: string; message: string; details: { aliases: string[] } }
    expect(localError.code).toBe('VALIDATION_ERROR')
    expect(localError.message).toBe(`Competitor spoketuneworks.example is stored as 2 rows (offers.spoketuneworks.example, spoketuneworks.example); remove the competitor (every row goes) and add it again: ${addAgain}`)
    expect(localError.details.aliases).toEqual(['Spoke Tune Pros', 'TuneSpoke'])

    // A server-side write (--set) gets the API's refusal, which names the same way out.
    const server = await invokeCli(['competitor', 'aliases', 'rotorwise', 'spoketuneworks.example', '--set', 'Tune Spoke Crew', '--format', 'json'])
    expect(server.exitCode).toBe(1)
    expect(JSON.parse(server.stderr).error.message).toContain('Remove the competitor, which removes every row (canonry competitor remove <project> spoketuneworks.example)')
  })

  it('reports an untracked competitor and conflicting flags as user errors', async () => {
    const missing = await invokeCli(['competitor', 'aliases', 'rotorwise', 'nobody.example', '--add', 'Nobody', '--format', 'json'])
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stderr).error).toMatchObject({ code: 'NOT_FOUND', details: { project: 'rotorwise', domain: 'nobody.example' } })

    const conflict = await invokeCli(['competitor', 'aliases', 'rotorwise', 'qvx.example', '--set', 'QVX', '--add', 'Other', '--format', 'json'])
    expect(conflict.exitCode).toBe(1)
    expect(JSON.parse(conflict.stderr).error.code).toBe('CLI_USAGE_ERROR')

    const noDomain = await invokeCli(['competitor', 'aliases', 'rotorwise', '--format', 'json'])
    expect(noDomain.exitCode).toBe(1)
    expect(JSON.parse(noDomain.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR', message: 'competitor domain is required' })
  })

  it('documents the command in contextual help', async () => {
    const result = await invokeCli(['competitor', 'aliases', '--help'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('canonry competitor aliases <project> <domain> [--set <name>]... [--add <name>]... [--remove <name>]... [--clear] [--block <name>]... [--unblock <name>]... [--format json]')
    const detect = await invokeCli(['competitor', 'aliases', 'detect', '--help'])
    expect(detect.stdout).toContain('canonry competitor aliases detect <project> [--apply] [--format json|jsonl]')
    const add = await invokeCli(['competitor', 'add', '--help'])
    expect(add.stdout).toContain('canonry competitor add <project> <domain...> [--alias <name>]... [--format json]')
  })
})
