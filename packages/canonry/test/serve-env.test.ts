import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyServerEnv } from '../src/cli-commands/system.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { buildServeOpenLine, readServeOpenState, resolveServePort, shouldWarnAboutRemoteSetup } from '../src/commands/serve.js'

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

describe('shouldWarnAboutRemoteSetup', () => {
  it('warns for IPv4, IPv6, and specific non-loopback binds', () => {
    expect(shouldWarnAboutRemoteSetup('0.0.0.0')).toBe(true)
    expect(shouldWarnAboutRemoteSetup('::')).toBe(true)
    expect(shouldWarnAboutRemoteSetup('[::]')).toBe(true)
    expect(shouldWarnAboutRemoteSetup('192.168.1.10')).toBe(true)
  })

  it('does not warn for loopback binds', () => {
    expect(shouldWarnAboutRemoteSetup('127.0.0.1')).toBe(false)
    expect(shouldWarnAboutRemoteSetup('::1')).toBe(false)
    expect(shouldWarnAboutRemoteSetup('localhost')).toBe(false)
  })
})

describe('buildServeOpenLine', () => {
  const url = 'http://127.0.0.1:4100'

  it('points an empty install at /setup', () => {
    expect(buildServeOpenLine({ url, projectCount: 0, hasSiteAudit: false })).toContain(`${url}/setup to map your site`)
  })

  it('points an unscanned project at Site Health setup', () => {
    expect(buildServeOpenLine({
      url,
      projectCount: 1,
      firstProjectName: 'example-com',
      hasSiteAudit: false,
    })).toBe(`Open ${url}/setup?onboarding=site-health&setupProject=example-com to run your first Page Health scan.`)
  })

  it('opens the dashboard when a site audit already exists', () => {
    expect(buildServeOpenLine({
      url,
      projectCount: 1,
      firstProjectName: 'example-com',
      hasSiteAudit: true,
    })).toBe(`Open ${url}`)
  })
})

describe('readServeOpenState', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  const addProject = (id: string, name: string, createdAt: string) => {
    db.insert(projects).values({
      id, name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', createdAt, updatedAt: createdAt,
    }).run()
  }
  const addRun = (id: string, projectId: string, status: string, trigger = 'manual') => {
    db.insert(runs).values({
      id, projectId, kind: 'site-audit', status, trigger,
      createdAt: '2026-01-01T00:00:00.000Z',
    }).run()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-open-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports an empty install', () => {
    expect(readServeOpenState(db)).toEqual({ projectCount: 0, hasSiteAudit: false })
  })

  it('names the first unscanned project in created-at order', () => {
    addProject('p2', 'bravo', '2026-01-02T00:00:00.000Z')
    addProject('p1', 'alpha', '2026-01-01T00:00:00.000Z')
    addRun('r1', 'p1', 'completed')

    expect(readServeOpenState(db)).toEqual({
      projectCount: 2, firstProjectName: 'bravo', hasSiteAudit: false,
    })
  })

  it('stops pointing at first-run setup once every project is scanned', () => {
    addProject('p1', 'alpha', '2026-01-01T00:00:00.000Z')
    addRun('r1', 'p1', 'partial')

    expect(readServeOpenState(db)).toMatchObject({ projectCount: 1, hasSiteAudit: true })
  })

  it('does not count a probe as a scan the operator can read', () => {
    addProject('p1', 'alpha', '2026-01-01T00:00:00.000Z')
    addRun('r_probe', 'p1', 'completed', 'probe')

    expect(readServeOpenState(db)).toEqual({
      projectCount: 1, firstProjectName: 'alpha', hasSiteAudit: false,
    })
  })

  it('does not count an unfinished scan', () => {
    addProject('p1', 'alpha', '2026-01-01T00:00:00.000Z')
    addRun('r_running', 'p1', 'running')

    expect(readServeOpenState(db)).toEqual({
      projectCount: 1, firstProjectName: 'alpha', hasSiteAudit: false,
    })
  })
})
