import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli-error.js'
import { installMcp, printMcpConfig, renderClientSnippet } from '../src/commands/mcp.js'
import { findMcpClient } from '../src/mcp-clients.js'

let tmpRoot: string
let logs: string[]
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-install-'))
  logs = []
  logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
    logs.push(String(value))
  })
})

afterEach(() => {
  logSpy.mockRestore()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function configFile(name = 'claude_desktop_config.json'): string {
  return path.join(tmpRoot, name)
}

describe('canonry mcp install (claude-desktop)', () => {
  it('creates a fresh config file when none exists', async () => {
    const configPath = configFile()
    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
    })

    expect(result.status).toBe('installed')
    expect(result.backupPath).toBeUndefined()
    expect(fs.existsSync(configPath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written).toEqual({
      mcpServers: {
        canonry: { command: '/usr/local/bin/canonry-mcp', args: [] },
      },
    })
  })

  it('merges into an existing config and backs up the original', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        other: { command: '/usr/local/bin/other-mcp', args: [] },
      },
      keepMe: { ok: true },
    }, null, 2))

    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      readOnly: true,
    })

    expect(result.status).toBe('installed')
    expect(result.backupPath).toBe(`${configPath}.canonry.bak`)
    expect(fs.existsSync(result.backupPath!)).toBe(true)

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written).toEqual({
      keepMe: { ok: true },
      mcpServers: {
        other: { command: '/usr/local/bin/other-mcp', args: [] },
        canonry: { command: '/usr/local/bin/canonry-mcp', args: ['--read-only'] },
      },
    })
  })

  it('is idempotent when the same entry already exists', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        canonry: { command: '/usr/local/bin/canonry-mcp', args: [] },
      },
    }, null, 2))

    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
    })

    expect(result.status).toBe('already-installed')
    expect(result.backupPath).toBeUndefined()
  })

  it('updates the entry when args differ (e.g. flipping --read-only)', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        canonry: { command: '/usr/local/bin/canonry-mcp', args: [] },
      },
    }, null, 2))

    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      readOnly: true,
    })

    expect(result.status).toBe('updated')
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers.canonry.args).toEqual(['--read-only'])
  })

  it('honors --dry-run and does not write', async () => {
    const configPath = configFile()
    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      dryRun: true,
    })

    expect(result.status).toBe('dry-run')
    expect(fs.existsSync(configPath)).toBe(false)
    expect(result.snippet).toContain('mcpServers')
  })

  it('emits structured JSON when --format json is set', async () => {
    const configPath = configFile()
    await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      format: 'json',
    })

    const parsed = JSON.parse(logs[0]!)
    expect(parsed).toMatchObject({
      client: 'claude-desktop',
      configPath,
      serverName: 'canonry',
      status: 'installed',
      entry: { command: '/usr/local/bin/canonry-mcp', args: [] },
    })
  })

  it('lets --name customize the server entry key', async () => {
    const configPath = configFile()
    await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      name: 'canonry-prod',
    })

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers).toHaveProperty('canonry-prod')
  })

  it('rejects an unsupported client', async () => {
    await expect(installMcp({
      client: 'cline',
      binPath: '/usr/local/bin/canonry-mcp',
    })).rejects.toBeInstanceOf(CliError)
  })

  it('returns a snippet-only result for clients without auto-install (codex)', async () => {
    const result = await installMcp({
      client: 'codex',
      configPath: configFile('codex-config.toml'),
      binPath: '/usr/local/bin/canonry-mcp',
    })

    expect(result.status).toBe('snippet-only')
    expect(result.snippet).toContain('[mcp_servers.canonry]')
    expect(result.snippet).toContain('command = "/usr/local/bin/canonry-mcp"')
  })

  it('throws a structured error on unparseable JSON', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, '{not json')

    await expect(installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
    })).rejects.toBeInstanceOf(CliError)
  })

  it('treats an existing entry without args as args: []', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        canonry: { command: '/usr/local/bin/canonry-mcp' },
      },
    }, null, 2))

    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
    })

    expect(result.status).toBe('already-installed')
  })

  it('updates when an existing entry without args differs in flags', async () => {
    const configPath = configFile()
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        canonry: { command: '/usr/local/bin/canonry-mcp' },
      },
    }, null, 2))

    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/bin/canonry-mcp',
      readOnly: true,
    })

    expect(result.status).toBe('updated')
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers.canonry.args).toEqual(['--read-only'])
  })

  it('wraps a .mjs target in node when installing on Windows', async () => {
    const configPath = configFile()
    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: 'C:\\Program Files\\nodejs\\canonry\\bin\\canonry-mcp.mjs',
      readOnly: true,
      platform: 'win32',
    })

    expect(result.entry).toEqual({
      command: 'node',
      args: ['C:\\Program Files\\nodejs\\canonry\\bin\\canonry-mcp.mjs', '--read-only'],
    })
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(written.mcpServers.canonry.command).toBe('node')
  })

  it('leaves a non-.mjs target unwrapped on Windows', async () => {
    const configPath = configFile()
    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: 'C:\\npm\\canonry-mcp.cmd',
      platform: 'win32',
    })

    expect(result.entry).toEqual({
      command: 'C:\\npm\\canonry-mcp.cmd',
      args: [],
    })
  })

  it('does not wrap .mjs paths on non-Windows platforms', async () => {
    const configPath = configFile()
    const result = await installMcp({
      client: 'claude-desktop',
      configPath,
      binPath: '/usr/local/lib/node_modules/@ainyc/canonry/bin/canonry-mcp.mjs',
      platform: 'darwin',
    })

    expect(result.entry).toEqual({
      command: '/usr/local/lib/node_modules/@ainyc/canonry/bin/canonry-mcp.mjs',
      args: [],
    })
  })
})

describe('canonry mcp config', () => {
  it('prints a JSON snippet for claude-desktop', async () => {
    await printMcpConfig({
      client: 'claude-desktop',
      binPath: '/usr/local/bin/canonry-mcp',
    })

    const output = logs.join('\n')
    expect(output).toContain('Claude Desktop')
    expect(output).toContain('"mcpServers"')
    expect(output).toContain('"canonry"')
  })

  it('prints a TOML snippet for codex', async () => {
    await printMcpConfig({
      client: 'codex',
      binPath: '/usr/local/bin/canonry-mcp',
    })

    const output = logs.join('\n')
    expect(output).toContain('[mcp_servers.canonry]')
    expect(output).toContain('args = []')
  })

  it('emits structured JSON when --format json is set', async () => {
    await printMcpConfig({
      client: 'cursor',
      binPath: '/usr/local/bin/canonry-mcp',
      readOnly: true,
      format: 'json',
    })

    const parsed = JSON.parse(logs[0]!)
    expect(parsed.client).toBe('cursor')
    expect(parsed.entry).toEqual({ command: '/usr/local/bin/canonry-mcp', args: ['--read-only'] })
    expect(parsed.snippet).toContain('mcpServers')
  })
})

describe('renderClientSnippet', () => {
  it('renders TOML with quoted args', () => {
    const codex = findMcpClient('codex')!
    const snippet = renderClientSnippet(codex, 'canonry', { command: '/bin/canonry-mcp', args: ['--read-only'] })
    expect(snippet).toContain('args = ["--read-only"]')
  })
})
