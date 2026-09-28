import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSentimentInstallConfig } from '../src/sentiment-config.js'
let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentiment-config-')); vi.stubEnv('CANONRY_CONFIG_DIR', directory); vi.stubEnv('CANONRY_SENTIMENT_ENABLED', ''); vi.stubEnv('TYPESAFE_API_KEY', ''); vi.stubEnv('TYPESAFE_MODEL', 'jev-1.13.0') })
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { force: true, recursive: true }) })
describe('sentiment live configuration', () => {
  it('reloads each request and observes disablement without a server restart', () => {
    const file = path.join(directory, 'config.yaml')
    fs.writeFileSync(file, 'sentiment:\n  enabled: true\n')
    expect(loadSentimentInstallConfig().enabled).toBe(true)
    fs.writeFileSync(file, 'sentiment:\n  enabled: false\n')
    expect(loadSentimentInstallConfig().enabled).toBe(false)
    fs.writeFileSync(file, 'sentiment: [invalid')
    expect(loadSentimentInstallConfig().enabled).toBe(false)
  })
  it('marks invalid or unreadable configuration so it holds dispatch instead of disabling the install', () => {
    vi.stubEnv('CANONRY_SENTIMENT_ENABLED', 'true'); vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-key')
    const file = path.join(directory, 'config.yaml')
    const invalid = { enabled: false, invalid: true }
    expect(loadSentimentInstallConfig()).toMatchObject(invalid)
    for (const contents of [
      'sentiment:\n  enabled: true\n  maxConcurency: 4\n',
      'sentiment:\n  enabled: true\n  maxConcurrency: 10\n',
      'sentiment: [invalid',
      'sentiment: true\n',
      '',
      '- sentiment\n',
    ]) {
      fs.writeFileSync(file, contents)
      expect(loadSentimentInstallConfig(), JSON.stringify(contents)).toMatchObject(invalid)
    }
  })
  it('treats only a readable disabled or absent block as an install disable', () => {
    const file = path.join(directory, 'config.yaml')
    for (const contents of ['sentiment:\n  enabled: false\n', 'apiUrl: http://127.0.0.1:4100\n', 'sentiment:\n']) {
      fs.writeFileSync(file, contents)
      const config = loadSentimentInstallConfig()
      expect(config.enabled, JSON.stringify(contents)).toBe(false)
      expect(config, JSON.stringify(contents)).not.toHaveProperty('invalid')
    }
  })
})
