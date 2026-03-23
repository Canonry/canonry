import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, keywords, querySnapshots, runs } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { loadConfig } from '../src/config.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('operator CLI contract', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined
  let origCi: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-cli-operator-contract-${crypto.randomUUID()}`)
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

  it('prints a JSON usage error for status with missing project', async () => {
    const result = await invokeCli(['status', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('status')
    expect(parsed.error.details.usage).toBe('canonry status <project>')
  })

  it('prints project status to stdout in JSON mode', async () => {
    const result = await invokeCli(['status', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      project: { name: string }
      runs: unknown[]
    }
    expect(parsed.project.name).toBe('test-proj')
    expect(parsed.runs).toBeInstanceOf(Array)
  })

  it('prints evidence to stdout in JSON mode', async () => {
    const project = await client.getProject('test-proj') as { id: string }
    const keywordId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const createdAt = new Date().toISOString()

    db.insert(keywords).values({
      id: keywordId,
      projectId: project.id,
      keyword: 'answer engine optimization',
      createdAt,
    }).run()

    db.insert(runs).values({
      id: runId,
      projectId: project.id,
      status: 'completed',
      createdAt,
      finishedAt: createdAt,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId,
      provider: 'gemini',
      citationState: 'cited',
      createdAt,
    }).run()

    const result = await invokeCli(['evidence', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as Array<{ keyword: string; cited: boolean }>
    expect(parsed).toBeInstanceOf(Array)
    expect(parsed[0]?.keyword).toBe('answer engine optimization')
    expect(parsed[0]?.cited).toBe(true)
  })

  it('prints audit history to stdout in JSON mode', async () => {
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })

    const result = await invokeCli(['history', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as Array<{ action: string }>
    expect(parsed).toBeInstanceOf(Array)
    expect(parsed.some(entry => entry.action === 'location.added')).toBe(true)
  })

  it('prints a JSON usage error for history with missing project', async () => {
    const result = await invokeCli(['history', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('history')
  })

  it('prints project export to stdout in JSON mode', async () => {
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })

    const result = await invokeCli(['export', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      metadata: { name: string }
      spec: { canonicalDomain: string; locations: Array<{ label: string }> }
    }
    expect(parsed.metadata.name).toBe('test-proj')
    expect(parsed.spec.canonicalDomain).toBe('example.com')
    expect(parsed.spec.locations[0]?.label).toBe('nyc')
  })

  it('prints a JSON usage error for analytics with missing project', async () => {
    const result = await invokeCli(['analytics', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('analytics')
  })

  it('prints a typed JSON error for unknown analytics feature', async () => {
    const result = await invokeCli(['analytics', 'test-proj', '--feature', 'bogus', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { feature: string; validFeatures: string[] } }
    }
    expect(parsed.error.code).toBe('INVALID_ANALYTICS_FEATURE')
    expect(parsed.error.message).toBe('Unknown analytics feature "bogus"')
    expect(parsed.error.details.feature).toBe('bogus')
    expect(parsed.error.details.validFeatures).toEqual(['metrics', 'gaps', 'sources'])
  })

  it('applies a config file and prints a JSON summary', async () => {
    const applyPath = path.join(tmpDir, 'apply.yaml')
    fs.writeFileSync(applyPath, [
      'apiVersion: canonry/v1',
      'kind: Project',
      'metadata:',
      '  name: applied-proj',
      '  labels: {}',
      'spec:',
      '  displayName: Applied',
      '  canonicalDomain: applied.example.com',
      '  country: US',
      '  language: en',
      '  keywords:',
      '    - answer engine optimization',
      '  competitors: []',
      '  providers: []',
      '  locations: []',
      '  notifications: []',
    ].join('\n'))

    const result = await invokeCli(['apply', applyPath, '--format', 'json'])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      appliedCount: number
      errorCount: number
      files: Array<{ filePath: string; applied: Array<{ name: string }> }>
    }
    expect(parsed.appliedCount).toBe(1)
    expect(parsed.errorCount).toBe(0)
    expect(parsed.files[0]?.filePath).toBe(applyPath)
    expect(parsed.files[0]?.applied[0]?.name).toBe('applied-proj')

    const project = await client.getProject('applied-proj') as { name: string }
    expect(project.name).toBe('applied-proj')
  })

  it('prints a typed JSON error for apply failures', async () => {
    const missingPath = path.join(tmpDir, 'missing.yaml')
    const result = await invokeCli(['apply', missingPath, '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string
        message: string
        details: { appliedCount: number; errorCount: number; files: Array<{ filePath: string; errors: string[] }> }
      }
    }
    expect(parsed.error.code).toBe('APPLY_FAILED')
    expect(parsed.error.details.errorCount).toBe(1)
    expect(parsed.error.details.files[0]?.filePath).toBe(missingPath)
    expect(parsed.error.details.files[0]?.errors[0]).toMatch(/File not found/)
  })

  it('supports JSON output for schedule commands', async () => {
    const setResult = await invokeCli([
      'schedule',
      'set',
      'test-proj',
      '--preset',
      'daily',
      '--timezone',
      'UTC',
      '--format',
      'json',
    ])
    const setParsed = parseJsonOutput(setResult.stdout) as { preset: string | null; timezone: string; enabled: boolean }
    expect(setResult.exitCode).toBe(undefined)
    expect(setParsed.preset).toBe('daily')
    expect(setParsed.timezone).toBe('UTC')
    expect(setParsed.enabled).toBe(true)

    const showResult = await invokeCli(['schedule', 'show', 'test-proj', '--format', 'json'])
    const showParsed = parseJsonOutput(showResult.stdout) as { preset: string | null }
    expect(showParsed.preset).toBe('daily')

    const disableResult = await invokeCli(['schedule', 'disable', 'test-proj', '--format', 'json'])
    const disableParsed = parseJsonOutput(disableResult.stdout) as { enabled: boolean }
    expect(disableParsed.enabled).toBe(false)

    const enableResult = await invokeCli(['schedule', 'enable', 'test-proj', '--format', 'json'])
    const enableParsed = parseJsonOutput(enableResult.stdout) as { enabled: boolean }
    expect(enableParsed.enabled).toBe(true)

    const removeResult = await invokeCli(['schedule', 'remove', 'test-proj', '--format', 'json'])
    const removeParsed = parseJsonOutput(removeResult.stdout) as { project: string; removed: boolean }
    expect(removeParsed.project).toBe('test-proj')
    expect(removeParsed.removed).toBe(true)
  })

  it('prints a JSON usage error for schedule set without preset or cron', async () => {
    const result = await invokeCli(['schedule', 'set', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; required: string[] } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('schedule preset or cron is required')
    expect(parsed.error.details.command).toBe('schedule.set')
    expect(parsed.error.details.required).toEqual(['preset | cron'])
  })

  it('prints a JSON usage error for project add-location when required flags are missing', async () => {
    const result = await invokeCli(['project', 'add-location', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; required: string[] } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('location label, city, region, and country are required')
    expect(parsed.error.details.command).toBe('project.add-location')
    expect(parsed.error.details.required).toEqual(['label', 'city', 'region', 'country'])
  })

  it('supports JSON output for notify add/list/remove/events', async () => {
    const addResult = await invokeCli([
      'notify',
      'add',
      'test-proj',
      '--webhook',
      'https://1.1.1.1/canonry-webhook',
      '--events',
      'run.completed,run.failed',
      '--format',
      'json',
    ])
    const added = JSON.parse(addResult.stdout) as { id: string; url: string; events: string[] }
    expect(added.url).toBe('https://1.1.1.1/redacted')
    expect(added.events).toEqual(['run.completed', 'run.failed'])

    const listResult = await invokeCli(['notify', 'list', 'test-proj', '--format', 'json'])
    const listed = JSON.parse(listResult.stdout) as Array<{ id: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(added.id)

    const eventsResult = await invokeCli(['notify', 'events', '--format', 'json'])
    const events = JSON.parse(eventsResult.stdout) as Array<{ event: string }>
    expect(events.some(event => event.event === 'run.completed')).toBe(true)

    const removeResult = await invokeCli(['notify', 'remove', 'test-proj', added.id, '--format', 'json'])
    const removed = JSON.parse(removeResult.stdout) as { id: string; removed: boolean }
    expect(removed.id).toBe(added.id)
    expect(removed.removed).toBe(true)
  })

  it('prints a JSON usage error for notify add without required flags', async () => {
    const result = await invokeCli(['notify', 'add', 'test-proj', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.details.command).toBe('notify.add')
    expect(parsed.error.message).toBe('--webhook is required')
  })

  it('supports JSON output for project location commands', async () => {
    const addResult = await invokeCli([
      'project',
      'add-location',
      'test-proj',
      '--label',
      'nyc',
      '--city',
      'New York',
      '--region',
      'NY',
      '--country',
      'US',
      '--format',
      'json',
    ])
    const added = JSON.parse(addResult.stdout) as { label: string; city: string }
    expect(added.label).toBe('nyc')
    expect(added.city).toBe('New York')

    const setDefaultResult = await invokeCli([
      'project',
      'set-default-location',
      'test-proj',
      'nyc',
      '--format',
      'json',
    ])
    const defaulted = JSON.parse(setDefaultResult.stdout) as { project: string; defaultLocation: string }
    expect(defaulted.project).toBe('test-proj')
    expect(defaulted.defaultLocation).toBe('nyc')

    const listResult = await invokeCli(['project', 'locations', 'test-proj', '--format', 'json'])
    const listed = JSON.parse(listResult.stdout) as {
      locations: Array<{ label: string }>
      defaultLocation: string | null
    }
    expect(listed.locations).toHaveLength(1)
    expect(listed.locations[0]?.label).toBe('nyc')
    expect(listed.defaultLocation).toBe('nyc')

    const removeResult = await invokeCli([
      'project',
      'remove-location',
      'test-proj',
      'nyc',
      '--format',
      'json',
    ])
    const removed = JSON.parse(removeResult.stdout) as { project: string; label: string; removed: boolean }
    expect(removed.project).toBe('test-proj')
    expect(removed.label).toBe('nyc')
    expect(removed.removed).toBe(true)
  })

  it('supports JSON output for project create/update/list/delete', async () => {
    const createResult = await invokeCli([
      'project',
      'create',
      'created-proj',
      '--domain',
      'created.example.com',
      '--owned-domain',
      'www.created.example.com',
      '--display-name',
      'Created Project',
      '--format',
      'json',
    ])
    expect(createResult.exitCode).toBe(undefined)
    expect(createResult.stderr).toBe('')
    const created = JSON.parse(createResult.stdout) as {
      name: string
      canonicalDomain: string
      displayName: string
      ownedDomains: string[]
    }
    expect(created.name).toBe('created-proj')
    expect(created.canonicalDomain).toBe('created.example.com')
    expect(created.displayName).toBe('Created Project')
    expect(created.ownedDomains).toEqual(['www.created.example.com'])

    const updateResult = await invokeCli([
      'project',
      'update',
      'created-proj',
      '--add-domain',
      'blog.created.example.com',
      '--display-name',
      'Created Project V2',
      '--format',
      'json',
    ])
    const updated = JSON.parse(updateResult.stdout) as {
      displayName: string
      ownedDomains: string[]
    }
    expect(updated.displayName).toBe('Created Project V2')
    expect(updated.ownedDomains).toContain('blog.created.example.com')

    const listResult = await invokeCli(['project', 'list', '--format', 'json'])
    const listed = JSON.parse(listResult.stdout) as Array<{ name: string }>
    expect(listed.some(project => project.name === 'created-proj')).toBe(true)

    const deleteResult = await invokeCli(['project', 'delete', 'created-proj', '--format', 'json'])
    const deleted = JSON.parse(deleteResult.stdout) as { name: string; deleted: boolean }
    expect(deleted.name).toBe('created-proj')
    expect(deleted.deleted).toBe(true)
  })

  it('prints a JSON usage error for project create with missing name', async () => {
    const result = await invokeCli(['project', 'create', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('project name is required')
    expect(parsed.error.details.command).toBe('project.create')
  })

  it('supports JSON output for keyword add/import/list/remove', async () => {
    const keywordFile = path.join(tmpDir, 'keywords.txt')
    fs.writeFileSync(keywordFile, ['site authority', 'answer engine roi'].join('\n'), 'utf-8')

    const addResult = await invokeCli([
      'keyword',
      'add',
      'test-proj',
      'answer engine optimization',
      'brand monitoring',
      '--format',
      'json',
    ])
    const added = JSON.parse(addResult.stdout) as { project: string; keywords: string[]; addedCount: number }
    expect(added.project).toBe('test-proj')
    expect(added.addedCount).toBe(2)
    expect(added.keywords).toEqual(['answer engine optimization', 'brand monitoring'])

    const importResult = await invokeCli(['keyword', 'import', 'test-proj', keywordFile, '--format', 'json'])
    const imported = JSON.parse(importResult.stdout) as { filePath: string; importedCount: number; keywords: string[] }
    expect(imported.filePath).toBe(keywordFile)
    expect(imported.importedCount).toBe(2)
    expect(imported.keywords).toEqual(['site authority', 'answer engine roi'])

    const listResult = await invokeCli(['keyword', 'list', 'test-proj', '--format', 'json'])
    const listed = JSON.parse(listResult.stdout) as Array<{ keyword: string }>
    expect(listed).toHaveLength(4)
    expect(listed.map(entry => entry.keyword)).toEqual(expect.arrayContaining([
      'answer engine optimization',
      'brand monitoring',
      'site authority',
      'answer engine roi',
    ]))

    const removeResult = await invokeCli([
      'keyword',
      'remove',
      'test-proj',
      'site authority',
      '--format',
      'json',
    ])
    const removed = JSON.parse(removeResult.stdout) as {
      removedKeywords: string[]
      removedCount: number
    }
    expect(removed.removedKeywords).toEqual(['site authority'])
    expect(removed.removedCount).toBe(1)
  })

  it('prints typed JSON errors for keyword usage and import failures', async () => {
    const missingResult = await invokeCli([
      'keyword',
      'import',
      'test-proj',
      path.join(tmpDir, 'missing-keywords.txt'),
      '--format',
      'json',
    ])
    expect(missingResult.exitCode).toBe(1)
    const missingParsed = JSON.parse(missingResult.stderr) as {
      error: { code: string; message: string; details: { filePath: string } }
    }
    expect(missingParsed.error.code).toBe('KEYWORD_IMPORT_FILE_NOT_FOUND')
    expect(missingParsed.error.details.filePath).toMatch(/missing-keywords\.txt$/)

    const usageResult = await invokeCli(['keyword', 'generate', 'test-proj', '--format', 'json'])
    expect(usageResult.exitCode).toBe(1)
    const usageParsed = JSON.parse(usageResult.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(usageParsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(usageParsed.error.message).toBe('--provider is required (e.g. gemini, openai, claude, perplexity, local)')
    expect(usageParsed.error.details.command).toBe('keyword.generate')
  })

  it('supports JSON output for competitor add/list', async () => {
    const addResult = await invokeCli([
      'competitor',
      'add',
      'test-proj',
      'comp-a.example',
      'comp-b.example',
      '--format',
      'json',
    ])
    const added = JSON.parse(addResult.stdout) as {
      addedDomains: string[]
      addedCount: number
      domains: string[]
    }
    expect(added.addedDomains).toEqual(['comp-a.example', 'comp-b.example'])
    expect(added.addedCount).toBe(2)
    expect(added.domains).toEqual(['comp-a.example', 'comp-b.example'])

    const listResult = await invokeCli(['competitor', 'list', 'test-proj', '--format', 'json'])
    const listed = JSON.parse(listResult.stdout) as Array<{ domain: string }>
    expect(listed.map(entry => entry.domain)).toEqual(['comp-a.example', 'comp-b.example'])
  })

  it('supports JSON output for settings show/provider/google', async () => {
    const showBeforeResult = await invokeCli(['settings', '--format', 'json'])
    const before = JSON.parse(showBeforeResult.stdout) as {
      providers: Array<{ name: string; configured: boolean }>
      google: { configured: boolean }
    }
    expect(before.providers).toBeInstanceOf(Array)
    expect(before.google.configured).toBe(false)

    const providerResult = await invokeCli([
      'settings',
      'provider',
      'openai',
      '--api-key',
      'sk-test',
      '--model',
      'gpt-4.1',
      '--max-concurrent',
      '3',
      '--max-per-minute',
      '30',
      '--max-per-day',
      '300',
      '--format',
      'json',
    ])
    const provider = JSON.parse(providerResult.stdout) as {
      name: string
      configured: boolean
      model: string
      quota: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
    }
    expect(provider.name).toBe('openai')
    expect(provider.configured).toBe(true)
    expect(provider.model).toBe('gpt-4.1')
    expect(provider.quota.maxConcurrency).toBe(3)
    expect(provider.quota.maxRequestsPerMinute).toBe(30)
    expect(provider.quota.maxRequestsPerDay).toBe(300)

    const googleResult = await invokeCli([
      'settings',
      'google',
      '--client-id',
      'google-client-id',
      '--client-secret',
      'google-client-secret',
      '--format',
      'json',
    ])
    const google = JSON.parse(googleResult.stdout) as {
      configured: boolean
      configPath: string
      restartRequired: boolean
    }
    expect(google.configured).toBe(true)
    expect(google.restartRequired).toBe(true)
    expect(google.configPath).toMatch(/config\.yaml$/)

    const config = loadConfig()
    expect(config.google?.clientId).toBe('google-client-id')
    expect(config.google?.clientSecret).toBe('google-client-secret')

    const showAfterResult = await invokeCli(['settings', '--format', 'json'])
    const after = JSON.parse(showAfterResult.stdout) as {
      providers: Array<{ name: string; configured: boolean; model?: string }>
      google: { configured: boolean }
    }
    const openai = after.providers.find(entry => entry.name === 'openai')
    expect(openai?.configured).toBe(true)
    expect(openai?.model).toBe('gpt-4.1')
    expect(after.google.configured).toBe(true)
  })

  it('prints a JSON usage error for local settings provider without base-url', async () => {
    const result = await invokeCli(['settings', 'provider', 'local', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; required: string[] } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('--base-url is required for the local provider')
    expect(parsed.error.details.command).toBe('settings.provider')
    expect(parsed.error.details.required).toEqual(['base-url'])
  })

  it('supports JSON output for google, bing, and cdp status-style commands', async () => {
    const googleStatusResult = await invokeCli(['google', 'status', 'test-proj', '--format', 'json'])
    const googleStatus = JSON.parse(googleStatusResult.stdout) as {
      connections: unknown[]
    }
    expect(googleStatus.connections).toEqual([])

    const bingStatusResult = await invokeCli(['bing', 'status', 'test-proj', '--format', 'json'])
    const bingStatus = JSON.parse(bingStatusResult.stdout) as {
      connected: boolean
      domain: string
    }
    expect(bingStatus.connected).toBe(false)
    expect(bingStatus.domain).toBe('example.com')

    const cdpStatusResult = await invokeCli(['cdp', 'status', '--format', 'json'])
    const cdpStatus = JSON.parse(cdpStatusResult.stdout) as {
      connected: boolean
      targets: unknown[]
    }
    expect(cdpStatus.connected).toBe(false)
    expect(cdpStatus.targets).toEqual([])
  })

  it('supports JSON output for cdp connect and persists the endpoint locally', async () => {
    const result = await invokeCli([
      'cdp',
      'connect',
      '--host',
      'localhost',
      '--port',
      '9333',
      '--format',
      'json',
    ])

    expect(result.exitCode).toBe(undefined)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as {
      host: string
      port: number
      endpoint: string
      restartRequired: boolean
    }
    expect(parsed.host).toBe('localhost')
    expect(parsed.port).toBe(9333)
    expect(parsed.endpoint).toBe('ws://localhost:9333')
    expect(parsed.restartRequired).toBe(true)

    const config = loadConfig()
    expect(config.cdp?.host).toBe('localhost')
    expect(config.cdp?.port).toBe(9333)
  })

  it('prints JSON usage errors for google/bing request-indexing and cdp screenshot', async () => {
    const googleResult = await invokeCli(['google', 'request-indexing', 'test-proj', '--format', 'json'])
    expect(googleResult.exitCode).toBe(1)
    const googleParsed = JSON.parse(googleResult.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(googleParsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(googleParsed.error.message).toBe('provide a URL or use --all-unindexed')
    expect(googleParsed.error.details.command).toBe('google.request-indexing')

    const bingResult = await invokeCli(['bing', 'request-indexing', 'test-proj', '--format', 'json'])
    expect(bingResult.exitCode).toBe(1)
    const bingParsed = JSON.parse(bingResult.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(bingParsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(bingParsed.error.message).toBe('provide a URL or use --all-unindexed')
    expect(bingParsed.error.details.command).toBe('bing.request-indexing')

    const cdpResult = await invokeCli(['cdp', 'screenshot', '--format', 'json'])
    expect(cdpResult.exitCode).toBe(1)
    const cdpParsed = JSON.parse(cdpResult.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(cdpParsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(cdpParsed.error.message).toBe('query is required')
    expect(cdpParsed.error.details.command).toBe('cdp.screenshot')
  })

  it('supports JSON output for telemetry status, disable, and enable', async () => {
    const originalTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    const originalCi = process.env.CI
    delete process.env.CANONRY_TELEMETRY_DISABLED
    delete process.env.CI

    try {
      const statusResult = await invokeCli(['telemetry', 'status', '--format', 'json'])
      expect(statusResult.exitCode).toBe(undefined)
      expect(statusResult.stderr).toBe('')
      const statusParsed = JSON.parse(statusResult.stdout) as {
        enabled: boolean
        configPath: string
      }
      expect(statusParsed.enabled).toBe(true)
      expect(statusParsed.configPath).toMatch(/config\.yaml$/)

      const disableResult = await invokeCli(['telemetry', 'disable', '--format', 'json'])
      expect(disableResult.exitCode).toBe(undefined)
      const disableParsed = JSON.parse(disableResult.stdout) as { enabled: boolean }
      expect(disableParsed.enabled).toBe(false)
      expect(loadConfig().telemetry).toBe(false)

      const enableResult = await invokeCli(['telemetry', 'enable', '--format', 'json'])
      expect(enableResult.exitCode).toBe(undefined)
      const enableParsed = JSON.parse(enableResult.stdout) as { enabled: boolean }
      expect(enableParsed.enabled).toBe(true)
      expect(loadConfig().telemetry).toBe(true)
    } finally {
      if (originalTelemetryDisabled === undefined) {
        delete process.env.CANONRY_TELEMETRY_DISABLED
      } else {
        process.env.CANONRY_TELEMETRY_DISABLED = originalTelemetryDisabled
      }
      if (originalCi === undefined) {
        delete process.env.CI
      } else {
        process.env.CI = originalCi
      }
    }
  })

  it('prints a typed JSON error for telemetry enable when config is missing', async () => {
    fs.rmSync(path.join(tmpDir, 'config.yaml'))

    const result = await invokeCli(['telemetry', 'enable', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string } }
    }
    expect(parsed.error.code).toBe('CONFIG_REQUIRED')
    expect(parsed.error.message).toBe('No config found. Run "canonry init" first.')
    expect(parsed.error.details.command).toBe('telemetry.enable')
  })

  it('supports JSON output for bootstrap and stop', async () => {
    const isolatedConfigDir = path.join(os.tmpdir(), `canonry-cli-bootstrap-${crypto.randomUUID()}`)
    fs.mkdirSync(isolatedConfigDir, { recursive: true })
    const originalConfigDir = process.env.CANONRY_CONFIG_DIR
    const originalGeminiApiKey = process.env.GEMINI_API_KEY
    process.env.CANONRY_CONFIG_DIR = isolatedConfigDir
    process.env.GEMINI_API_KEY = 'test-gemini-key'

    try {
      const bootstrapResult = await invokeCli(['bootstrap', '--format', 'json'])
      expect(bootstrapResult.exitCode).toBe(undefined)
      expect(bootstrapResult.stderr).toBe('')
      const bootstrapParsed = JSON.parse(bootstrapResult.stdout) as {
        bootstrapped: boolean
        providers: string[]
        configPath: string
      }
      expect(bootstrapParsed.bootstrapped).toBe(true)
      expect(bootstrapParsed.providers).toContain('gemini')
      expect(bootstrapParsed.configPath).toMatch(/config\.yaml$/)

      const stopResult = await invokeCli(['stop', '--format', 'json'])
      expect(stopResult.exitCode).toBe(undefined)
      expect(stopResult.stderr).toBe('')
      const stopParsed = JSON.parse(stopResult.stdout) as {
        stopped: boolean
        reason: string
      }
      expect(stopParsed.stopped).toBe(false)
      expect(stopParsed.reason).toBe('not_running')
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CANONRY_CONFIG_DIR
      } else {
        process.env.CANONRY_CONFIG_DIR = originalConfigDir
      }
      if (originalGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = originalGeminiApiKey
      }
      fs.rmSync(isolatedConfigDir, { recursive: true, force: true })
    }
  })

  it('prints a typed JSON error for init when Google OAuth credentials are incomplete', async () => {
    const result = await invokeCli([
      'init',
      '--force',
      '--google-client-id',
      'google-client-id',
      '--format',
      'json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { required: string[] } }
    }
    expect(parsed.error.code).toBe('GOOGLE_OAUTH_CREDENTIALS_INCOMPLETE')
    expect(parsed.error.message).toBe('Google OAuth requires both a client ID and client secret when configured non-interactively.')
    expect(parsed.error.details.required).toEqual(['google-client-id', 'google-client-secret'])
  })

  it('prints a JSON usage error for unknown commands', async () => {
    const result = await invokeCli(['does-not-exist', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { command: string; usage: string } }
    }
    expect(parsed.error.code).toBe('CLI_USAGE_ERROR')
    expect(parsed.error.message).toBe('unknown command: does-not-exist')
    expect(parsed.error.details.command).toBe('does-not-exist')
    expect(parsed.error.details.usage).toBe('canonry --help')
  })
})
