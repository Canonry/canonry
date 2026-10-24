import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { CliError } from '../src/cli-error.js'
import { getConfigPath, loadConfig, saveConfigPatch, type CanonryConfig } from '../src/config.js'
import { resolveJourneyKeySecret } from '../src/journey-secret.js'

const LONG = 'a-configured-journey-secret-of-32-plus-chars'

function config(journeys?: CanonryConfig['journeys']): CanonryConfig {
  return { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: 'cnry_test', ...(journeys ? { journeys } : {}) } as CanonryConfig
}

describe('resolveJourneyKeySecret', () => {
  it('prefers the environment, then the config file, without writing', () => {
    const persist = vi.fn()
    expect(resolveJourneyKeySecret(config({ visitorKeySecret: LONG }), { CANONRY_JOURNEY_KEY_SECRET: `  env-${LONG}  ` }, persist)).toBe(`env-${LONG}`)
    expect(resolveJourneyKeySecret(config({ visitorKeySecret: LONG }), {}, persist)).toBe(LONG)
    expect(persist).not.toHaveBeenCalled()
  })

  it('refuses a short environment secret', () => {
    expect(() => resolveJourneyKeySecret(config(), { CANONRY_JOURNEY_KEY_SECRET: 'short' }, vi.fn())).toThrow(CliError)
  })

  it('generates and saves a secret once', () => {
    const cfg = config()
    const persist = vi.fn()
    const secret = resolveJourneyKeySecret(cfg, {}, persist)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(persist).toHaveBeenCalledWith({ journeys: { visitorKeySecret: secret } })
    expect(resolveJourneyKeySecret(cfg, {}, persist)).toBe(secret)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('keeps serving with a process-only secret when the file cannot be written', () => {
    const warn = vi.fn()
    const secret = resolveJourneyKeySecret(config(), {}, () => { throw new Error('read-only file system') }, warn)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only file system'))
    expect(warn.mock.calls[0]![0]).not.toContain(secret)
  })
})

describe('journeys.visitorKeySecret in config.yaml', () => {
  let configDir: string

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-journey-secret-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
    vi.stubEnv('CANONRY_BASE_PATH', undefined as unknown as string)
    vi.stubEnv('CANONRY_EXTERNAL_MCP', undefined as unknown as string)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function write(journeys: unknown): void {
    fs.writeFileSync(getConfigPath(), stringify({ apiUrl: 'http://127.0.0.1:4999', database: path.join(configDir, 'data.sqlite'), apiKey: 'cnry_journey_fixture', providers: {}, journeys }), { mode: 0o600 })
  }

  it('accepts a long secret or a blank one', () => {
    write({ visitorKeySecret: LONG })
    expect(loadConfig().journeys?.visitorKeySecret).toBe(LONG)
    write({ visitorKeySecret: null })
    expect(loadConfig().journeys?.visitorKeySecret).toBeNull()
  })

  it('rejects a short secret', () => {
    write({ visitorKeySecret: 'short' })
    let error: unknown
    try { loadConfig() } catch (err) { error = err }
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe('CONFIG_INVALID')
  })

  it('a generated secret is saved beside the existing settings and read back', () => {
    write(null)
    const cfg = loadConfig()
    const secret = resolveJourneyKeySecret(cfg, {}, saveConfigPatch)
    const onDisk = parse(fs.readFileSync(getConfigPath(), 'utf-8')) as { apiKey: string; journeys: { visitorKeySecret: string } }
    expect(onDisk).toMatchObject({ apiKey: 'cnry_journey_fixture', journeys: { visitorKeySecret: secret } })
    expect(resolveJourneyKeySecret(loadConfig(), {}, saveConfigPatch)).toBe(secret)
  })
})
