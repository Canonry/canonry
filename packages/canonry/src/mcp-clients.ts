import os from 'node:os'
import path from 'node:path'

export type McpClientFormat = 'json-mcp-servers' | 'json-context-servers' | 'toml-mcp-servers'

export interface McpClientDefinition {
  id: string
  label: string
  format: McpClientFormat
  configPath: () => string
  /** True when `canonry mcp install` can merge a server entry into the config file in place. */
  installSupported: boolean
}

const CLAUDE_DESKTOP_CONFIG_FILENAME = 'claude_desktop_config.json'

function homeRelative(...segments: string[]): string {
  return path.join(os.homedir(), ...segments)
}

function claudeDesktopConfigPath(): string {
  switch (process.platform) {
    case 'darwin':
      return homeRelative('Library', 'Application Support', 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME)
    case 'win32': {
      const appData = process.env.APPDATA ?? homeRelative('AppData', 'Roaming')
      return path.join(appData, 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME)
    }
    default:
      return homeRelative('.config', 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME)
  }
}

function cursorConfigPath(): string {
  return homeRelative('.cursor', 'mcp.json')
}

function codexConfigPath(): string {
  return homeRelative('.codex', 'config.toml')
}

export const SUPPORTED_MCP_CLIENTS: readonly McpClientDefinition[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    format: 'json-mcp-servers',
    configPath: claudeDesktopConfigPath,
    installSupported: true,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json-mcp-servers',
    configPath: cursorConfigPath,
    installSupported: true,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    format: 'toml-mcp-servers',
    configPath: codexConfigPath,
    installSupported: false,
  },
]

export function findMcpClient(id: string): McpClientDefinition | undefined {
  return SUPPORTED_MCP_CLIENTS.find(client => client.id === id)
}

export function listMcpClientIds(): string[] {
  return SUPPORTED_MCP_CLIENTS.map(client => client.id)
}
