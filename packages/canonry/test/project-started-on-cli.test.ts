import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@canonry/canonry-api-routes'
import { createClient, migrate, projects, type DatabaseClient } from '@canonry/canonry-db'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'

// The project start date through the real routes: what `project update
// --started-on` writes and `project show` prints. Charts mark the date "We
// started" and fit their visit trends from it.

const state = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../src/client.js', async importOriginal => ({
  ...await importOriginal(),
  createApiClient: () => state.client,
}))
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

const PROJECT = 'northwind'
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness(): Promise<{ db: DatabaseClient, api: ApiClient }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-started-on-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const app = Fastify()
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.register(apiRoutes, { db, skipAuth: true })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  const api = new ApiClient(`http://127.0.0.1:${address.port}`, 'cnry_test', { skipProbe: true })
  state.client = api
  await api.putProject(PROJECT, { displayName: 'Northwind', canonicalDomain: 'northwind.example', country: 'US', language: 'en' })
  return { db, api }
}

const stored = (db: DatabaseClient) => db.select().from(projects).where(eq(projects.name, PROJECT)).get()!

async function cli(args: string[], format: 'text' | 'json' = 'text'): Promise<{ lines: string[]; error?: unknown }> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) })
  try {
    await dispatchRegisteredCommand([...args, '--format', format], format, [...PROJECT_CLI_COMMANDS])
    return { lines }
  } catch (error) {
    return { lines, error }
  } finally {
    vi.mocked(console.log).mockRestore()
  }
}

describe('project --started-on against the API', () => {
  it('saves a date, keeps it through an edit that does not name it, and clears it with "none"', async () => {
    const { db, api } = await harness()
    const patch = vi.spyOn(api, 'patchProject')
    expect((await cli(['project', 'update', PROJECT, '--started-on', '2026-06-01'])).error).toBeUndefined()
    expect(patch.mock.calls.at(-1)![1].startedOn).toBe('2026-06-01')
    expect(stored(db).startedOn).toBe('2026-06-01')

    expect((await cli(['project', 'update', PROJECT, '--country', 'GB'])).error).toBeUndefined()
    expect(patch.mock.calls.at(-1)![1]).not.toHaveProperty('startedOn')
    expect(stored(db)).toMatchObject({ country: 'GB', startedOn: '2026-06-01' })

    expect((await cli(['project', 'update', PROJECT, '--started-on', 'none'])).error).toBeUndefined()
    expect(stored(db).startedOn).toBeNull()
  })

  it('project show prints the date, and JSON carries the field', async () => {
    const { api } = await harness()
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Started on: not set')
    await api.patchProject(PROJECT, { startedOn: '2026-06-01' })
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Started on: 2026-06-01')
    expect(JSON.parse((await cli(['project', 'show', PROJECT], 'json')).lines.join('\n'))).toMatchObject({ startedOn: '2026-06-01' })
  })

  it('rejects anything but a calendar date or "none" before any request', async () => {
    const { db, api } = await harness()
    const patch = vi.spyOn(api, 'patchProject')
    for (const value of ['2026-06', '2026-02-30', 'yesterday', '']) {
      const { error } = await cli(['project', 'update', PROJECT, '--started-on', value])
      expect(error, value).toBeInstanceOf(CliError)
      expect(error, value).toMatchObject({
        code: 'CLI_USAGE_ERROR',
        exitCode: 1,
        message: '--started-on must be YYYY-MM-DD or "none"',
        details: { command: 'project.update', option: 'started-on', value },
      })
    }
    expect(patch).not.toHaveBeenCalled()
    expect(stored(db).startedOn).toBeNull()
  })
})
