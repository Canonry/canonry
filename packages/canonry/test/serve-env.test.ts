import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyServerEnv } from '../src/cli-commands/system.js'
import { resolveServePort } from '../src/commands/serve.js'

const KEYS = ['CANONRY_PORT', 'CANONRY_HOST', 'CANONRY_BASE_PATH'] as const

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
