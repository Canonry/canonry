import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { CliError } from '../src/cli-error.js'
import { getConfigPath, loadConfig } from '../src/config.js'

describe('mcpGateway config', () => {
  let configDir: string

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-gateway-config-'))
    vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
    vi.stubEnv('CANONRY_PORT', undefined as unknown as string)
    vi.stubEnv('CANONRY_BASE_PATH', undefined as unknown as string)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function writeConfig(mcpGateway: unknown): void {
    const cfg = {
      apiUrl: 'http://127.0.0.1:4999',
      database: path.join(configDir, 'data.sqlite'),
      apiKey: 'cnry_gateway_fixture',
      providers: {},
      mcpGateway,
    }
    fs.writeFileSync(getConfigPath(), stringify(cfg), { mode: 0o600 })
  }

  function configError(): CliError | undefined {
    try {
      loadConfig()
    } catch (err) {
      return err as CliError
    }
    return undefined
  }

  it('loads a gateway with and without an operator-named workspace, and leaves it unset when blank', () => {
    writeConfig({ url: 'https://mcp.example/mcp' })
    expect(loadConfig().mcpGateway).toEqual({ url: 'https://mcp.example/mcp' })
    writeConfig({ url: 'https://mcp.example/mcp', workspace: 'tenant-one' })
    expect(loadConfig().mcpGateway).toEqual({ url: 'https://mcp.example/mcp', workspace: 'tenant-one' })
    writeConfig(null)
    expect(loadConfig().mcpGateway ?? undefined).toBeUndefined()
  })

  it.each([
    [{ url: 'http://mcp.example/mcp' }],
    [{ url: 'https://user:secret@mcp.example/mcp' }],
    [{ url: 'https://mcp.example/mcp?token=secret' }],
    [{ url: 'https://mcp.example/mcp#fragment' }],
    [{ url: 'not-a-url' }],
    [{ workspace: 'tenant-one' }],
    [{ url: 'https://mcp.example/mcp', workspace: '   ' }],
    [{ url: 'https://mcp.example/mcp', extra: true }],
  ])('rejects %j before the server starts', mcpGateway => {
    writeConfig(mcpGateway)
    const error = configError()
    expect(error).toBeInstanceOf(CliError)
    expect(error?.code).toBe('CONFIG_INVALID')
    expect(error?.message).toContain('mcpGateway')
  })
})
