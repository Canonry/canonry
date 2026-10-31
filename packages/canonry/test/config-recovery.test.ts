import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { apiKeys, createClient, migrate, projects } from '@canonry/canonry-db'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { getConfigPath, loadConfig, type CanonryConfig } from '../src/config.js'

let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-config-recovery-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
  vi.stubEnv('CANONRY_BASE_PATH', undefined as unknown as string)
  vi.stubEnv('CANONRY_EXTERNAL_MCP', undefined as unknown as string)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('invalid config recovery guidance', () => {
  it.each([
    { provider: 'missing-provider' },
    { provider: 'openrouter', model: '   ' },
    { provider: 'openrouter', model: 'Not an OpenRouter model' },
    { provider: 'claude', model: 'missing-claude-model' },
  ])('rejects an invalid independent classification role without rewriting the file: %j', classification => {
    const document = stringify({ apiUrl: 'http://127.0.0.1:4100', database: ':memory:', apiKey: 'cnry_fixture', providers: { openrouter: { apiKey: 'synthetic-shared-key' } }, classification })
    fs.writeFileSync(getConfigPath(), document, { mode: 0o600 })
    expect(loadConfig).toThrow(/classification/)
    expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(document)
  })

  it('accepts an OpenRouter classification model newer than pi-ai, to be checked against the live catalog when it runs', () => {
    const classification = { provider: 'openrouter', model: 'vendor/released-after-pi' }
    fs.writeFileSync(getConfigPath(), stringify({ apiUrl: 'http://127.0.0.1:4100', database: ':memory:', apiKey: 'cnry_fixture', providers: { openrouter: { apiKey: 'synthetic-shared-key' } }, classification }), { mode: 0o600 })
    expect(loadConfig().classification).toEqual(classification)
  })

  it('keeps independent OpenRouter classification and Aero models separate from the measured model', () => {
    fs.writeFileSync(getConfigPath(), stringify({ apiUrl: 'http://127.0.0.1:4100', database: ':memory:', apiKey: 'cnry_fixture', providers: { openrouter: { apiKey: 'synthetic-shared-key', model: 'google/gemini-3.8-flash' } }, agent: { provider: 'openrouter', model: 'anthropic/claude-opus-4.7' }, classification: { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' } }), { mode: 0o600 })
    expect(loadConfig()).toMatchObject({ providers: { openrouter: { model: 'google/gemini-3.8-flash' } }, agent: { provider: 'openrouter', model: 'anthropic/claude-opus-4.7' }, classification: { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' } })
  })

  it.each(['apiUrl', 'database', 'apiKey'] as const)(
    'restores a missing %s from a private backup without replacing existing state',
    async missingField => {
      const original: CanonryConfig = {
        apiUrl: 'http://127.0.0.1:4999',
        database: path.join(configDir, 'custom.sqlite'),
        apiKey: 'cnry_recovery_fixture',
        providers: { gemini: { apiKey: 'fixture-provider-key', model: 'fixture-model' } },
        telemetry: false,
      }
      const db = createClient(original.database)
      migrate(db)
      const now = new Date().toISOString()
      db.insert(apiKeys).values({
        id: 'existing-key',
        name: 'default',
        keyHash: crypto.createHash('sha256').update(original.apiKey).digest('hex'),
        keyPrefix: original.apiKey.slice(0, 9),
        scopes: ['*'],
        createdAt: now,
      }).run()
      db.insert(projects).values({
        id: 'existing-project',
        name: 'existing-project',
        displayName: 'Existing project',
        canonicalDomain: 'existing.example',
        country: 'US',
        language: 'en',
        createdAt: now,
        updatedAt: now,
      }).run()
      const keysBefore = db.select().from(apiKeys).all()
      const projectsBefore = db.select().from(projects).all()
      const backupPath = path.join(configDir, 'private-backup.yaml')
      fs.writeFileSync(backupPath, stringify(original), { mode: 0o600 })
      const incomplete: Partial<CanonryConfig> = { ...original }
      delete incomplete[missingField]
      const invalidContents = stringify(incomplete)
      fs.writeFileSync(getConfigPath(), invalidContents, { mode: 0o600 })

      try {
        const message = expect.objectContaining({
          message: expect.stringContaining(`missing: ${missingField}`),
        })
        expect(loadConfig).toThrow(message)
        await expect(bootstrapCommand({ format: 'json' })).rejects.toThrow(message)
        try {
          loadConfig()
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          const text = (error as Error).message
          expect(text).toContain('Restore the missing values from a known-good backup.')
          expect(text).toContain('If none exists, recover the original values before you retry.')
          expect(text).toContain('Keep the original API key and database path.')
          expect(text).toContain('Do not share secrets.')
          expect(text).toContain('Do not use "canonry init --force" for recovery.')
          expect(text).not.toContain('Run "canonry bootstrap"')
          expect(text).not.toContain(original.apiKey)
          expect(text).not.toContain('fixture-provider-key')
        }
        expect(fs.readFileSync(getConfigPath(), 'utf8')).toBe(invalidContents)
        expect(fs.existsSync(path.join(configDir, 'data.db'))).toBe(false)

        // Follow the recovery message: restore only the missing value from the
        // private backup, retaining all other config and database state.
        const backup = parse(fs.readFileSync(backupPath, 'utf8')) as CanonryConfig
        fs.writeFileSync(getConfigPath(), stringify({
          ...incomplete,
          [missingField]: backup[missingField],
        }), { mode: 0o600 })
        expect(loadConfig()).toEqual(original)
        expect(db.select().from(apiKeys).all()).toEqual(keysBefore)
        expect(db.select().from(projects).all()).toEqual(projectsBefore)
        expect(fs.existsSync(path.join(configDir, 'data.db'))).toBe(false)
      } finally {
        db.$client.close()
      }
    },
  )

  it('keeps the bootstrap guidance for a missing config file', () => {
    expect(loadConfig).toThrow('Run "canonry bootstrap" to create the local Page Health runtime; provider credentials are optional.')
    expect(fs.existsSync(getConfigPath())).toBe(false)
  })
})
