import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'

// `project update --competitor-auto-aliases off|preview|apply` and `project
// show` through the real routes: the mode is sent only when the flag is given,
// so an unrelated edit never overwrites a mode set elsewhere.

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

async function harness(): Promise<{ db: DatabaseClient; api: ApiClient }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-auto-alias-mode-cli-'))
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

const storedMode = (db: DatabaseClient) =>
  db.select({ mode: projects.competitorAutoAliases }).from(projects).where(eq(projects.name, PROJECT)).get()!.mode

async function cli(args: string[], format: 'text' | 'json' = 'text'): Promise<{ lines: string[]; error?: unknown }> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) })
  try {
    await dispatchRegisteredCommand([...args, '--format', format], format, PROJECT_CLI_COMMANDS)
    return { lines }
  } catch (error) {
    return { lines, error }
  } finally {
    vi.mocked(console.log).mockRestore()
  }
}

describe('project --competitor-auto-aliases against the API', () => {
  it('sets the mode, keeps it through an edit that does not name it, and shows it', async () => {
    const { db, api } = await harness()
    expect(storedMode(db)).toBe('preview')
    expect((await cli(['project', 'show', PROJECT])).lines)
      .toContain('  Competitor auto aliases: preview (detected after each sweep and logged; nothing stored)')

    const put = vi.spyOn(api, 'putProject')
    expect((await cli(['project', 'update', PROJECT, '--competitor-auto-aliases', 'APPLY'])).error).toBeUndefined()
    expect(put.mock.calls.at(-1)![1].competitorAutoAliases).toBe('apply')
    expect(storedMode(db)).toBe('apply')

    expect((await cli(['project', 'update', PROJECT, '--country', 'GB'])).error).toBeUndefined()
    expect(put.mock.calls.at(-1)![1]).not.toHaveProperty('competitorAutoAliases')
    expect(storedMode(db)).toBe('apply')

    expect((await cli(['project', 'show', PROJECT])).lines)
      .toContain('  Competitor auto aliases: apply (names detected after each sweep are stored and counted)')
    expect(JSON.parse((await cli(['project', 'show', PROJECT], 'json')).lines.join('\n'))).toMatchObject({ competitorAutoAliases: 'apply' })

    expect((await cli(['project', 'update', PROJECT, '--competitor-auto-aliases', 'off'])).error).toBeUndefined()
    expect((await cli(['project', 'show', PROJECT])).lines).toContain('  Competitor auto aliases: off (no detection after sweeps)')
  })

  it('rejects an unknown mode before any request', async () => {
    const { db, api } = await harness()
    const put = vi.spyOn(api, 'putProject')
    const { error } = await cli(['project', 'update', PROJECT, '--competitor-auto-aliases', 'auto'])
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain('--competitor-auto-aliases must be off, preview or apply')
    expect(put).not.toHaveBeenCalled()
    expect(storedMode(db)).toBe('preview')
  })
})
