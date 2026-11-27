import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, migrate, notifications } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli } from './cli-test-utils.js'

// `canonry notify update` end to end: flags -> ApiClient -> PATCH route -> the
// stored webhook. The route's own rules are covered in api-routes; this covers
// the flag mapping and the CLI's own usage errors.
describe('canonry notify update', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let close: () => Promise<void>
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let hookId: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-notify-update-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

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

    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: { gemini: { apiKey: 'test-key' } } }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const serverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)

    await client.putProject('demo', { displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en' })
    const hook = await client.createNotification('demo', {
      channel: 'webhook',
      url: 'https://8.8.8.8/hook',
      events: ['run.failed', 'citation.gained', 'citation.lost'],
    })
    hookId = hook.id
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function storedHook() {
    return db.select().from(notifications).where(eq(notifications.id, hookId)).get()!
  }

  it('adds events and turns the webhook off, printing the updated webhook as JSON', async () => {
    const result = await invokeCli(['notify', 'update', 'demo', hookId, '--add-events', 'mention.lost, mention.gained', '--disable', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    const printed = JSON.parse(result.stdout) as { id: string; events: string[]; enabled: boolean }
    expect(printed).toMatchObject({
      id: hookId,
      events: ['run.failed', 'citation.gained', 'citation.lost', 'mention.lost', 'mention.gained'],
      enabled: false,
    })
    expect(storedHook().config.events).toEqual(printed.events)
    expect(storedHook().enabled).toBe(false)
  })

  it('replaces the list with --events and removes with --remove-events', async () => {
    const replaced = await invokeCli(['notify', 'update', 'demo', hookId, '--events', 'mention.lost,mention.gained,run.failed', '--format', 'json'])
    expect(replaced.exitCode).toBeUndefined()
    expect(storedHook().config.events).toEqual(['mention.lost', 'mention.gained', 'run.failed'])

    const removed = await invokeCli(['notify', 'update', 'demo', hookId, '--remove-events', 'run.failed'])
    expect(removed.exitCode).toBeUndefined()
    expect(removed.stdout).toContain(`Notification ${hookId} updated for "demo"`)
    expect(removed.stdout).toContain('Events:  mention.lost, mention.gained')
    expect(storedHook().config.events).toEqual(['mention.lost', 'mention.gained'])
  })

  it.each([
    ['no change named', ['notify', 'update', 'demo', 'HOOK'], 'name a change'],
    ['--enable with --disable', ['notify', 'update', 'demo', 'HOOK', '--enable', '--disable'], 'not both'],
    ['no webhook id', ['notify', 'update', 'demo', '--enable'], 'notification ID is required'],
  ])('exits 1 on %s without changing the webhook', async (_label, args, message) => {
    const before = storedHook()

    const result = await invokeCli([...args.map(arg => arg === 'HOOK' ? hookId : arg), '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
    expect(storedHook()).toEqual(before)
  })

  it('exits 1 with the server message when the event is unknown', async () => {
    const result = await invokeCli(['notify', 'update', 'demo', hookId, '--add-events', 'mention.changed', '--format', 'json'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Invalid event(s): mention.changed')
    expect(storedHook().config.events).toEqual(['run.failed', 'citation.gained', 'citation.lost'])
  })
})
