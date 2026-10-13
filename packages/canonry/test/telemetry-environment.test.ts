import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { detectTelemetryEnvironment, installAttribution, recordInstallRef } from '../src/telemetry-environment.js'

const none = () => false

describe('detectTelemetryEnvironment', () => {
  it('reports nothing for an ordinary install', () => {
    expect(detectTelemetryEnvironment({ env: {}, configDir: '/home/me/.canonry', root: '/usr/lib/node_modules/@canonry/canonry', exists: none, tmpDirs: ['/tmp'] })).toEqual([])
  })

  it('flags containers, throwaway config dirs, source checkouts and the WordPress plugin', () => {
    expect(detectTelemetryEnvironment({ env: { CANONRY_INSTALL_METHOD: 'docker' }, configDir: '/data', root: '/app', exists: none, tmpDirs: ['/tmp'] })).toEqual(['container'])
    expect(detectTelemetryEnvironment({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, configDir: '/data', root: '/app', exists: none, tmpDirs: ['/tmp'] })).toEqual(['container'])
    expect(detectTelemetryEnvironment({ env: {}, configDir: '/tmp/canonry-qa', root: '/app', exists: none, tmpDirs: ['/tmp'] })).toEqual(['temp_config'])
    expect(detectTelemetryEnvironment({
      env: {},
      configDir: '/home/me/.canonry',
      root: '/src/canonry/packages/canonry',
      exists: p => p === path.join('/src/canonry/packages/canonry', '..', '..', 'pnpm-workspace.yaml'),
      tmpDirs: ['/tmp'],
    })).toEqual(['dev_build'])
    expect(detectTelemetryEnvironment({ env: { CANONRY_TELEMETRY_SOURCE: 'wp-plugin' }, configDir: '/srv/wp/.canonry', root: '/app', exists: none, tmpDirs: ['/tmp'] })).toEqual(['wp_subprocess'])
  })

  it('does not mistake a directory that merely starts with the temp path', () => {
    expect(detectTelemetryEnvironment({ env: {}, configDir: '/tmpfs-data/.canonry', root: '/app', exists: none, tmpDirs: ['/tmp'] })).toEqual([])
  })
})

describe('install ref', () => {
  let dir: string
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.CANONRY_CONFIG_DIR
    dir = path.join(os.tmpdir(), `canonry-ref-${crypto.randomUUID()}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), stringify({ apiUrl: 'http://127.0.0.1:4100', database: path.join(dir, 'data.db'), apiKey: 'cnry_test' }))
    process.env.CANONRY_CONFIG_DIR = dir
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the first valid tag and never overwrites it', () => {
    recordInstallRef('Hero-CTA', {})
    expect(installAttribution().installRef).toBe('hero-cta')
    recordInstallRef('pricing', {})
    expect(installAttribution().installRef).toBe('hero-cta')
  })

  it('reads CANONRY_REF and ignores tags that are not slugs', () => {
    recordInstallRef(undefined, { CANONRY_REF: 'https://evil.example/x' })
    expect(installAttribution().installRef).toBeUndefined()
    recordInstallRef(undefined, { CANONRY_REF: 'docs-quickstart' })
    expect(installAttribution().installRef).toBe('docs-quickstart')
  })

  it('always reports an install source', () => {
    expect(['npm', 'homebrew', 'docker', 'source']).toContain(installAttribution().installSource)
  })
})
