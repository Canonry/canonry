import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyServerEnv } from '../src/cli-commands/system.js'
import { resolveServePort } from '../src/commands/serve.js'

const KEYS = [
  'CANONRY_PORT',
  'CANONRY_HOST',
  'CANONRY_BASE_PATH',
  'CANONRY_EMBED',
  'CANONRY_EMBED_ORIGINS',
  'CANONRY_EMBED_VIEWS',
] as const

describe('applyServerEnv', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('preserves an inherited CANONRY_PORT when --port is not passed', () => {
    process.env.CANONRY_PORT = '4101'
    applyServerEnv({})
    expect(process.env.CANONRY_PORT).toBe('4101')
  })

  it('overwrites CANONRY_PORT when --port is passed', () => {
    process.env.CANONRY_PORT = '4101'
    applyServerEnv({ port: '4200' })
    expect(process.env.CANONRY_PORT).toBe('4200')
  })

  it('leaves CANONRY_PORT unset when no env var or flag is provided', () => {
    applyServerEnv({})
    expect(process.env.CANONRY_PORT).toBeUndefined()
  })

  it('preserves inherited CANONRY_HOST and CANONRY_BASE_PATH when no flags are passed', () => {
    process.env.CANONRY_HOST = '0.0.0.0'
    process.env.CANONRY_BASE_PATH = '/canonry'
    applyServerEnv({})
    expect(process.env.CANONRY_HOST).toBe('0.0.0.0')
    expect(process.env.CANONRY_BASE_PATH).toBe('/canonry')
  })

  it('applies --host and --base-path flags', () => {
    applyServerEnv({ host: '127.0.0.1', 'base-path': '/x' })
    expect(process.env.CANONRY_HOST).toBe('127.0.0.1')
    expect(process.env.CANONRY_BASE_PATH).toBe('/x')
  })

  it('sets CANONRY_EMBED=1 when --embed is passed', () => {
    applyServerEnv({ embed: true })
    expect(process.env.CANONRY_EMBED).toBe('1')
  })

  it('leaves all three embed env vars unset when no embed flags are passed', () => {
    applyServerEnv({})
    expect(process.env.CANONRY_EMBED).toBeUndefined()
    expect(process.env.CANONRY_EMBED_ORIGINS).toBeUndefined()
    expect(process.env.CANONRY_EMBED_VIEWS).toBeUndefined()
  })

  it('preserves an inherited CANONRY_EMBED when --embed is not passed', () => {
    process.env.CANONRY_EMBED = '1'
    applyServerEnv({})
    expect(process.env.CANONRY_EMBED).toBe('1')
  })

  it('joins multiple --embed-allow-origin into a comma-separated CANONRY_EMBED_ORIGINS', () => {
    applyServerEnv({ embed: true, 'embed-allow-origin': ['https://a.com', 'https://b.com'] })
    expect(process.env.CANONRY_EMBED_ORIGINS).toBe('https://a.com,https://b.com')
  })

  it('joins multiple --embed-view into a comma-separated CANONRY_EMBED_VIEWS', () => {
    applyServerEnv({ embed: true, 'embed-view': ['overview', 'project'] })
    expect(process.env.CANONRY_EMBED_VIEWS).toBe('overview,project')
  })

  it('leaves CANONRY_EMBED_ORIGINS unset when the origins array is empty or absent', () => {
    applyServerEnv({ embed: true, 'embed-allow-origin': [] })
    expect(process.env.CANONRY_EMBED_ORIGINS).toBeUndefined()
  })
})

describe('resolveServePort', () => {
  it('honors CANONRY_PORT when set', () => {
    expect(resolveServePort('4101', undefined)).toBe(4101)
    expect(resolveServePort('4101', 5000)).toBe(4101)
  })

  it('falls back to config.port when env is unset or blank', () => {
    expect(resolveServePort(undefined, 5000)).toBe(5000)
    expect(resolveServePort('', 5000)).toBe(5000)
    expect(resolveServePort('   ', 5000)).toBe(5000)
  })

  it('uses 4100 default when neither env nor config provides a port', () => {
    expect(resolveServePort(undefined, undefined)).toBe(4100)
    expect(resolveServePort('', undefined)).toBe(4100)
  })
})
