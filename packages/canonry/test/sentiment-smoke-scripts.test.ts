import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptsDir = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const sentimentScripts = readdirSync(scriptsDir).filter(name => /sentiment/.test(name) && /\.(?:mjs|ts)$/.test(name)).sort()

describe('sentiment smoke scripts', () => {
  it('finds the sentiment smoke scripts', () => {
    expect(sentimentScripts).toEqual(expect.arrayContaining(['smoke-sentiment-browser.mjs', 'smoke-sentiment-engines-browser.mjs', 'smoke-sentiment-engines.mjs']))
  })

  // The repo is public and the scripts must run on any machine: no home
  // directory, per-user cache or pinned local browser build may be baked in.
  it.each(sentimentScripts)('%s names no machine-specific path', name => {
    const source = readFileSync(path.join(scriptsDir, name), 'utf8')
    expect(source).not.toMatch(/\/home\/|\/Users\/|ms-playwright|chromium-\d+/)
    expect(source).not.toMatch(/CANONRY_(?:PLAYWRIGHT_MODULE|BROWSER_EXECUTABLE)\s*\?\?\s*['"`]\//)
  })

  it('launches the browser with a custom executable only when one is set', () => {
    for (const name of ['smoke-sentiment-browser.mjs', 'smoke-sentiment-engines-browser.mjs']) {
      const source = readFileSync(path.join(scriptsDir, name), 'utf8')
      expect(source).toContain("process.env.CANONRY_PLAYWRIGHT_MODULE ?? 'playwright'")
      expect(source).toContain('...(process.env.CANONRY_BROWSER_EXECUTABLE ? { executablePath: process.env.CANONRY_BROWSER_EXECUTABLE } : {})')
    }
  })
})
