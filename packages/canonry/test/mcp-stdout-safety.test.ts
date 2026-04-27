import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../src/client.js'
import { loadConfig } from '../src/config.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const mcpSourceRoot = path.join(packageRoot, 'src', 'mcp')

describe('MCP stdout safety', () => {
  const originalConfigDir = process.env.CANONRY_CONFIG_DIR

  afterEach(() => {
    restoreEnv('CANONRY_CONFIG_DIR', originalConfigDir)
    delete process.env.CANONRY_BASE_PATH
  })

  it('keeps MCP source free of stdout, CLI dispatch, telemetry, logger, route, and DB imports', () => {
    const files = readFiles(mcpSourceRoot)
    const combined = files.map(file => fs.readFileSync(file, 'utf-8')).join('\n')

    expect(combined).not.toMatch(/console\.log/)
    expect(combined).not.toMatch(/process\.stdout\.write/)
    expect(combined).not.toMatch(/cli-dispatch|src\/commands|\/commands/)
    expect(combined).not.toMatch(/from ['"][^'"]*telemetry|import\([^)]*telemetry|telemetry\./)
    expect(combined).not.toMatch(/from ['"][^'"]*logger|import\([^)]*logger|logger\./)
    expect(combined).not.toMatch(/@ainyc\/canonry-db|canonry-db/)
    expect(combined).not.toMatch(/@ainyc\/canonry-api-routes|api-routes/)
    expect(combined).not.toMatch(/\bmigrate\b/)
  })

  it('does not write stdout during config loading or API client initialization', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-config-'))
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'apiUrl: http://127.0.0.1:4100',
      'database: /tmp/canonry-mcp.sqlite',
      'apiKey: cnry_test',
      '',
    ].join('\n'))
    process.env.CANONRY_CONFIG_DIR = configDir
    process.env.CANONRY_BASE_PATH = ''

    const writes: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      loadConfig()
      createApiClient()
    } finally {
      process.stdout.write = originalWrite
    }

    expect(writes).toEqual([])
  })
})

function readFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return readFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
