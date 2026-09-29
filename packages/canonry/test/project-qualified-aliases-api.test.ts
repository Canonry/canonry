import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { CliError, printCliError } from '../src/cli-error.js'

// `project update` against the real routes: what an operator sees when the
// server refuses a qualified alias, and that a competitor added through the
// API never leaves a stored name that turns later CLI edits into a 400.

const state = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../src/client.js', async importOriginal => ({
  ...await importOriginal(),
  createApiClient: () => state.client,
}))
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function harness(): Promise<{ db: DatabaseClient; api: ApiClient }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-qualified-aliases-api-'))
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
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await api.putProject('harborline', {
    displayName: 'Harborline Labs',
    canonicalDomain: 'harborline.example',
    aliases: ['HBLNYC', 'HBL NYC', 'HBL', 'Tidewater'],
    qualifiedAliases: ['HBLNYC', 'Tidewater'],
    country: 'US',
    language: 'en',
  })
  return { db, api }
}

function storedQualifiedAliases(db: DatabaseClient): string[] {
  return db.select().from(projects).where(eq(projects.name, 'harborline')).get()!.qualifiedAliases
}

async function update(...flags: string[]): Promise<unknown> {
  try {
    await dispatchRegisteredCommand(['project', 'update', 'harborline', ...flags], 'text', PROJECT_CLI_COMMANDS)
    return undefined
  } catch (error) {
    return error
  }
}

describe('canonry project update qualified aliases against the API', () => {
  it('a refused entry names itself and its reason in human output, with details in JSON', async () => {
    const { db } = await harness()
    const error = await update('--add-qualified-alias', 'HBL')
    expect(error).toBeInstanceOf(CliError)
    expect(storedQualifiedAliases(db)).toEqual(['HBLNYC', 'Tidewater'])

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCliError(error, 'text')
    expect(stderr.mock.calls[0]![0]).toBe('Error: Rejected qualifiedAliases: HBL (too-short)')

    printCliError(error, 'json')
    expect(JSON.parse(stderr.mock.calls[1]![0] as string).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { rejectedQualifiedAliases: [{ name: 'HBL', reason: 'too-short' }] },
    })
  })

  it('a competitor added through the API drops the name it claims, so the next edit still succeeds', async () => {
    const { db, api } = await harness()
    await api.appendCompetitors('harborline', ['tidewater.example'])
    expect(storedQualifiedAliases(db)).toEqual(['HBLNYC'])

    expect(await update('--add-qualified-alias', 'HBL NYC')).toBeUndefined()
    expect(storedQualifiedAliases(db)).toEqual(['HBL NYC', 'HBLNYC'])
  })

  it('a display name that now spells a qualified alias drops it instead of failing the edit', async () => {
    const { db } = await harness()
    expect(await update('--display-name', 'HBL NYC', '--add-qualified-alias', 'Tidewater')).toBeUndefined()
    expect(storedQualifiedAliases(db)).toEqual(['Tidewater'])
  })
})
