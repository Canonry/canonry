import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  findMcpClient,
  listMcpClientIds,
  type McpClientDefinition,
  type McpClientFormat,
} from '../mcp-clients.js'
import { CliError } from '../cli-error.js'

export interface McpInstallOptions {
  client: string
  name?: string
  readOnly?: boolean
  configPath?: string
  binPath?: string
  dryRun?: boolean
  format?: string
  platform?: NodeJS.Platform
}

export interface McpConfigOptions {
  client: string
  name?: string
  readOnly?: boolean
  binPath?: string
  format?: string
  platform?: NodeJS.Platform
}

export interface McpServerEntry {
  command: string
  args: string[]
}

export interface McpInstallResult {
  client: string
  configPath: string
  serverName: string
  entry: McpServerEntry
  status: 'installed' | 'updated' | 'already-installed' | 'dry-run' | 'snippet-only'
  backupPath?: string
  snippet?: string
  message: string
}

const _require = createRequire(import.meta.url)

function resolveCanonryMcpBin(): string {
  const packageJsonPath = _require.resolve('../package.json')
  const packageRoot = path.dirname(packageJsonPath)
  const pkg = _require('../package.json') as { bin?: Record<string, string> }
  const relativeBin = pkg.bin?.['canonry-mcp']
  if (!relativeBin) {
    throw new CliError({
      code: 'INTERNAL_ERROR',
      message: 'Could not resolve canonry-mcp bin path from package.json',
      exitCode: 2,
    })
  }
  return path.resolve(packageRoot, relativeBin)
}

function buildEntry(opts: { binPath?: string; readOnly?: boolean; platform?: NodeJS.Platform }): McpServerEntry {
  const target = opts.binPath ?? resolveCanonryMcpBin()
  const flagArgs = opts.readOnly ? ['--read-only'] : []
  const platform = opts.platform ?? process.platform
  // Windows can't spawn a `.mjs` file directly via shebang — wrap it in `node` so the
  // command line MCP clients write resolves to a real executable across platforms.
  if (platform === 'win32' && target.toLowerCase().endsWith('.mjs')) {
    return { command: 'node', args: [target, ...flagArgs] }
  }
  return { command: target, args: flagArgs }
}

function entryArgs(entry: McpServerEntry): string[] {
  return Array.isArray(entry.args) ? entry.args : []
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false
  const aArgs = entryArgs(a)
  const bArgs = entryArgs(b)
  return aArgs.length === bArgs.length && aArgs.every((arg, i) => arg === bArgs[i])
}

function renderJsonSnippet(serverName: string, entry: McpServerEntry, format: McpClientFormat): string {
  const key = format === 'json-context-servers' ? 'context_servers' : 'mcpServers'
  return JSON.stringify({ [key]: { [serverName]: entry } }, null, 2)
}

function renderTomlSnippet(serverName: string, entry: McpServerEntry): string {
  const argsLine = entry.args.length
    ? `args = [${entry.args.map(arg => JSON.stringify(arg)).join(', ')}]`
    : 'args = []'
  return [`[mcp_servers.${serverName}]`, `command = ${JSON.stringify(entry.command)}`, argsLine, ''].join('\n')
}

export function renderClientSnippet(client: McpClientDefinition, serverName: string, entry: McpServerEntry): string {
  if (client.format === 'toml-mcp-servers') return renderTomlSnippet(serverName, entry)
  return renderJsonSnippet(serverName, entry, client.format)
}

function readJsonConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  const raw = fs.readFileSync(configPath, 'utf-8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config root must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw new CliError({
      code: 'VALIDATION_ERROR',
      message: `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      details: { configPath },
    })
  }
}

function writeJsonConfig(configPath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function backupConfigIfPresent(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) return undefined
  const backupPath = `${configPath}.canonry.bak`
  fs.copyFileSync(configPath, backupPath)
  return backupPath
}

function findClientOrThrow(id: string): McpClientDefinition {
  const client = findMcpClient(id)
  if (client) return client
  throw new CliError({
    code: 'VALIDATION_ERROR',
    message: `Unknown MCP client "${id}". Supported: ${listMcpClientIds().join(', ')}`,
    exitCode: 1,
    details: { client: id, supportedClients: listMcpClientIds() },
  })
}

export async function installMcp(opts: McpInstallOptions): Promise<McpInstallResult> {
  const client = findClientOrThrow(opts.client)
  const serverName = opts.name?.trim() || 'canonry'
  const configPath = opts.configPath ?? client.configPath()
  const entry = buildEntry({ binPath: opts.binPath, readOnly: opts.readOnly, platform: opts.platform })

  if (!client.installSupported) {
    const snippet = renderClientSnippet(client, serverName, entry)
    const result: McpInstallResult = {
      client: client.id,
      configPath,
      serverName,
      entry,
      status: 'snippet-only',
      snippet,
      message: `Auto-install is not supported for ${client.label}. Add the snippet below to ${configPath}.`,
    }
    emitInstallResult(result, opts.format)
    return result
  }

  const containerKey = client.format === 'json-context-servers' ? 'context_servers' : 'mcpServers'
  const existing = readJsonConfig(configPath)
  const existingContainer = (existing[containerKey] as Record<string, McpServerEntry> | undefined) ?? {}
  const existingEntry = existingContainer[serverName]

  if (existingEntry && entriesEqual(existingEntry, entry)) {
    const result: McpInstallResult = {
      client: client.id,
      configPath,
      serverName,
      entry,
      status: 'already-installed',
      message: `${client.label} already has a "${serverName}" entry pointing to canonry-mcp.`,
    }
    emitInstallResult(result, opts.format)
    return result
  }

  const status: McpInstallResult['status'] = existingEntry ? 'updated' : 'installed'

  if (opts.dryRun) {
    const result: McpInstallResult = {
      client: client.id,
      configPath,
      serverName,
      entry,
      status: 'dry-run',
      snippet: renderClientSnippet(client, serverName, entry),
      message: `Would ${status === 'installed' ? 'install' : 'update'} "${serverName}" in ${configPath}.`,
    }
    emitInstallResult(result, opts.format)
    return result
  }

  const backupPath = backupConfigIfPresent(configPath)
  const next = {
    ...existing,
    [containerKey]: { ...existingContainer, [serverName]: entry },
  }
  writeJsonConfig(configPath, next)

  const result: McpInstallResult = {
    client: client.id,
    configPath,
    serverName,
    entry,
    status,
    backupPath,
    message: `${status === 'installed' ? 'Installed' : 'Updated'} "${serverName}" in ${client.label} at ${configPath}. Restart ${client.label} to load it.`,
  }
  emitInstallResult(result, opts.format)
  return result
}

export async function printMcpConfig(opts: McpConfigOptions): Promise<void> {
  const client = findClientOrThrow(opts.client)
  const serverName = opts.name?.trim() || 'canonry'
  const entry = buildEntry({ binPath: opts.binPath, readOnly: opts.readOnly, platform: opts.platform })
  const snippet = renderClientSnippet(client, serverName, entry)

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      client: client.id,
      configPath: client.configPath(),
      serverName,
      entry,
      snippet,
    }, null, 2))
    return
  }

  console.log(`# ${client.label} — paste into ${client.configPath()}`)
  console.log(snippet)
}

function emitInstallResult(result: McpInstallResult, format?: string): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.message)
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`)
  if (result.snippet && (result.status === 'snippet-only' || result.status === 'dry-run')) {
    console.log()
    console.log(result.snippet)
  }
}
