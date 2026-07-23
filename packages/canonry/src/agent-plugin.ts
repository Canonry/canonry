import fs from 'node:fs'
import path from 'node:path'
import type { AgentPluginClient, AgentPluginState } from '@ainyc/canonry-contracts'

interface DetectAgentPluginOptions {
  home?: string | null
  claudeConfigDir?: string | null
  codexHome?: string | null
}

const CANONRY_PLUGIN_ID = 'canonry@canonry'
const REQUIRED_SKILLS = ['canonry', 'aero'] as const

interface ParsedSemver {
  core: [number, number, number]
  prerelease?: string[]
}

function parseSemver(version: string): ParsedSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i.exec(version)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match.at(4)?.split('.'),
  }
}

function compareSemver(left: string, right: string): number {
  const leftVersion = parseSemver(left)!
  const rightVersion = parseSemver(right)!
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index]! > rightVersion.core[index]! ? 1 : -1
    }
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0
  if (!leftVersion.prerelease) return 1
  if (!rightVersion.prerelease) return -1
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease.at(index)
    const rightIdentifier = rightVersion.prerelease.at(index)
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) > Number(rightIdentifier) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier > rightIdentifier ? 1 : -1
  }
  return 0
}

function isCanonryPluginId(value: string): boolean {
  return value.trim() === CANONRY_PLUGIN_ID
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

function readClaudePluginConfigured(filePath: string): boolean {
  const parsed = readJson(filePath)
  if (!parsed || typeof parsed !== 'object') return false
  const enabledPlugins = (parsed as { enabledPlugins?: unknown }).enabledPlugins
  if (!enabledPlugins || typeof enabledPlugins !== 'object') return false
  for (const [id, enabled] of Object.entries(enabledPlugins as Record<string, unknown>)) {
    if (isCanonryPluginId(id)) return enabled === true
  }
  return false
}

function readCodexPluginConfigured(filePath: string): boolean {
  try {
    let currentPlugin: string | null = null
    let inPluginsTable = false
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const section = /^\s*\[plugins\.(?:"([^"]+)"|'([^']+)'|(\S+))\]\s*(?:#.*)?$/.exec(line)
      if (section) {
        const captures = section.slice(1, 4) as Array<string | undefined>
        currentPlugin = captures.find((value): value is string => value != null && value.length > 0) ?? null
        inPluginsTable = false
        continue
      }
      if (/^\s*\[plugins\]\s*(?:#.*)?$/.test(line)) {
        currentPlugin = null
        inPluginsTable = true
        continue
      }
      if (/^\s*\[/.test(line)) {
        currentPlugin = null
        inPluginsTable = false
        continue
      }
      if (currentPlugin && isCanonryPluginId(currentPlugin)) {
        const enabled = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line)
        if (enabled) return enabled[1] === 'true'
      } else if (inPluginsTable) {
        const inline = /^\s*(?:"([^"]+)"|'([^']+)'|([^=\s]+))\s*=\s*\{[^}]*\benabled\s*=\s*(true|false)\b[^}]*\}\s*(?:#.*)?$/.exec(line)
        const id = inline?.[1] ?? inline?.[2] ?? inline?.[3]
        if (inline && id && isCanonryPluginId(id)) return inline[4] === 'true'
      }
    }
    return false
  } catch {
    return false
  }
}

function verifiedPluginVersion(root: string, client: AgentPluginClient): string | null {
  const manifestDir = client === 'claude-code' ? '.claude-plugin' : '.codex-plugin'
  const manifest = readJson(path.join(root, manifestDir, 'plugin.json'))
  if (!manifest || typeof manifest !== 'object') return null
  const plugin = manifest as { name?: unknown; version?: unknown; skills?: unknown; mcpServers?: unknown }
  if (
    plugin.name !== 'canonry'
    || typeof plugin.version !== 'string'
    || !parseSemver(plugin.version)
    || plugin.skills !== './skills/'
    || plugin.mcpServers !== './.mcp.json'
  ) {
    return null
  }
  const mcp = readJson(path.join(root, '.mcp.json'))
  if (!mcp || typeof mcp !== 'object') return null
  const canonryServer = (mcp as { mcpServers?: { canonry?: { command?: unknown } } }).mcpServers?.canonry
  if (canonryServer?.command !== 'canonry-mcp') return null
  return REQUIRED_SKILLS.every((name) => fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')))
    ? plugin.version
    : null
}

function readClaudeUserInstallPaths(claudeConfigDir: string): string[] {
  const parsed = readJson(path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'))
  if (!parsed || typeof parsed !== 'object') return []
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!plugins || typeof plugins !== 'object') return []
  const installs = (plugins as Record<string, unknown>)[CANONRY_PLUGIN_ID]
  if (!Array.isArray(installs)) return []
  return installs.flatMap((install) => {
    if (!install || typeof install !== 'object') return []
    const record = install as { scope?: unknown; installPath?: unknown }
    return record.scope === 'user' && typeof record.installPath === 'string'
      ? [record.installPath]
      : []
  })
}

function listDirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

function newestVersion(versions: string[]): string | null {
  return versions.sort(compareSemver).at(-1) ?? null
}

function verifiedClaudeVersion(claudeConfigDir: string): string | null {
  return newestVersion(readClaudeUserInstallPaths(claudeConfigDir)
    .map((installPath) => verifiedPluginVersion(installPath, 'claude-code'))
    .filter((version): version is string => version !== null))
}

function verifiedCodexVersion(codexHome: string): string | null {
  // Codex caches marketplace plugins under
  // plugins/cache/<marketplace>/<plugin>/<version>. Restrict the lookup to the
  // official marketplace + plugin pair rather than searching arbitrary cache
  // trees for a manifest that happens to call itself Canonry.
  const pluginCache = path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry')
  const versionedRoots = listDirectories(pluginCache)
    .map((installPath) => ({ installPath, version: path.basename(installPath) }))
    .filter((candidate) => parseSemver(candidate.version) !== null)
    .sort((left, right) => compareSemver(left.version, right.version))
  const active = versionedRoots.at(-1)
  if (!active) return verifiedPluginVersion(pluginCache, 'codex')

  // Codex selects the highest cached marketplace version. Verify that exact
  // candidate fail-closed; never fall back to an older complete cache when the
  // active/newest entry is partial or corrupt.
  const manifestVersion = verifiedPluginVersion(active.installPath, 'codex')
  return manifestVersion === active.version ? manifestVersion : null
}

/**
 * Best-effort, user-global native plugin detection. A client is "configured"
 * when its user settings enable the exact official plugin ID and "verified"
 * only when the corresponding cached install also contains both bundled skills
 * plus its manifest and MCP definition.
 *
 * Project-local settings are deliberately excluded: a long-running Canonry
 * daemon cannot truthfully attribute one startup directory's client settings
 * to every later API caller or project.
 */
export function detectCanonryAgentPlugin(opts: DetectAgentPluginOptions = {}): AgentPluginState {
  const home = opts.home?.trim() || null
  const claudeConfigDir = opts.claudeConfigDir?.trim() || (home ? path.join(home, '.claude') : null)
  const codexHome = opts.codexHome?.trim() || (home ? path.join(home, '.codex') : null)

  const configuredClients: AgentPluginClient[] = []
  const verifiedClients: AgentPluginClient[] = []
  const verifiedClientVersions: Partial<Record<AgentPluginClient, string>> = {}

  const claudeConfigured = claudeConfigDir
    ? readClaudePluginConfigured(path.join(claudeConfigDir, 'settings.json'))
    : false
  if (claudeConfigured) {
    configuredClients.push('claude-code')
    const version = claudeConfigDir ? verifiedClaudeVersion(claudeConfigDir) : null
    if (version) {
      verifiedClients.push('claude-code')
      verifiedClientVersions['claude-code'] = version
    }
  }

  const codexConfigured = codexHome
    ? readCodexPluginConfigured(path.join(codexHome, 'config.toml'))
    : false
  if (codexConfigured) {
    configuredClients.push('codex')
    const version = codexHome ? verifiedCodexVersion(codexHome) : null
    if (version) {
      verifiedClients.push('codex')
      verifiedClientVersions.codex = version
    }
  }

  return { configuredClients, verifiedClients, verifiedClientVersions }
}
