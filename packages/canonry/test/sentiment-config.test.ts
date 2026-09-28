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
})
