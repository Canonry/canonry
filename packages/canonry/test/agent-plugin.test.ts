import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectCanonryAgentPlugin } from '../src/agent-plugin.js'

let homeDir: string

function write(relativePath: string, content: string, base = homeDir): string {
  const filePath = path.join(base, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

function seedPluginRoot(root: string, client: 'claude-code' | 'codex', version = '1.0.0'): void {
  const manifestDir = client === 'claude-code' ? '.claude-plugin' : '.codex-plugin'
  write(path.join(manifestDir, 'plugin.json'), JSON.stringify({
    name: 'canonry',
    version,
    skills: './skills/',
    mcpServers: './.mcp.json',
  }), root)
  write('.mcp.json', JSON.stringify({ mcpServers: { canonry: { command: 'canonry-mcp' } } }), root)
  write('skills/canonry/SKILL.md', '# canonry', root)
  write('skills/aero/SKILL.md', '# aero', root)
}

function seedClaudeInstall(claudeConfigDir = path.join(homeDir, '.claude')): void {
  const installPath = path.join(claudeConfigDir, 'plugins', 'cache', 'canonry', 'canonry', '1.0.0')
  seedPluginRoot(installPath, 'claude-code')
  write('plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: {
      'canonry@canonry': [{ scope: 'user', installPath, version: '1.0.0' }],
    },
  }), claudeConfigDir)
}

function seedCodexInstall(codexHome = path.join(homeDir, '.codex')): void {
  seedPluginRoot(path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', '1.0.0'), 'codex')
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-plugin-home-'))
})

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true })
})

describe('detectCanonryAgentPlugin', () => {
  it('separately reports configured and verified user-global clients', () => {
    write('.claude/settings.json', JSON.stringify({
      enabledPlugins: { 'canonry@canonry': true, 'other@marketplace': true },
      apiKey: 'must-not-leak',
    }))
    write('.codex/config.toml', '[plugins."canonry@canonry"]\nenabled = true\n')
    seedClaudeInstall()
    seedCodexInstall()

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['claude-code', 'codex'],
      verifiedClients: ['claude-code', 'codex'],
      verifiedClientVersions: { 'claude-code': '1.0.0', codex: '1.0.0' },
    })
  })

  it('does not treat settings entries as verified installs without cached assets', () => {
    write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'canonry@canonry': true } }))
    write('.codex/config.toml', '[plugins."canonry@canonry"]\nenabled = true\n')

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['claude-code', 'codex'],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })

  it('requires a user-scoped Claude install record with a complete plugin bundle', () => {
    const claudeDir = path.join(homeDir, '.claude')
    const installPath = path.join(claudeDir, 'plugins', 'cache', 'canonry', 'canonry', '1.0.0')
    write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'canonry@canonry': true } }))
    seedPluginRoot(installPath, 'claude-code')
    fs.rmSync(path.join(installPath, 'skills', 'aero', 'SKILL.md'))
    write('plugins/installed_plugins.json', JSON.stringify({
      plugins: { 'canonry@canonry': [{ scope: 'project', installPath }] },
    }), claudeDir)

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['claude-code'],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })

  it('supports the inline Codex plugins table', () => {
    write('.codex/config.toml', '[plugins]\n"canonry@canonry" = { enabled = true }\n')
    seedCodexInstall()
    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['codex'],
      verifiedClients: ['codex'],
      verifiedClientVersions: { codex: '1.0.0' },
    })
  })

  it('reports the newest complete Codex cache version', () => {
    const codexHome = path.join(homeDir, '.codex')
    write('.codex/config.toml', '[plugins."canonry@canonry"]\nenabled = true\n')
    seedPluginRoot(path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', '1.9.0'), 'codex', '1.9.0')
    seedPluginRoot(path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', '1.10.0'), 'codex', '1.10.0')

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['codex'],
      verifiedClients: ['codex'],
      verifiedClientVersions: { codex: '1.10.0' },
    })
  })

  it('does not verify a cache whose manifest version is not semver', () => {
    const codexHome = path.join(homeDir, '.codex')
    write('.codex/config.toml', '[plugins."canonry@canonry"]\nenabled = true\n')
    seedPluginRoot(path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', 'latest'), 'codex', 'latest')

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['codex'],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })

  it('does not fall back to an older complete Codex cache when the newest cache is incomplete', () => {
    const codexHome = path.join(homeDir, '.codex')
    write('.codex/config.toml', '[plugins."canonry@canonry"]\nenabled = true\n')
    seedPluginRoot(path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', '4.129.0'), 'codex', '4.129.0')
    const newestRoot = path.join(codexHome, 'plugins', 'cache', 'canonry', 'canonry', '9.0.0')
    seedPluginRoot(newestRoot, 'codex', '9.0.0')
    fs.rmSync(path.join(newestRoot, 'skills', 'aero', 'SKILL.md'))

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: ['codex'],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })

  it('reads client-specific user configuration roots', () => {
    const claudeConfigDir = path.join(homeDir, 'custom-claude')
    const codexHome = path.join(homeDir, 'custom-codex')
    write('settings.json', JSON.stringify({ enabledPlugins: { 'canonry@canonry': true } }), claudeConfigDir)
    write('config.toml', '[plugins."canonry@canonry"]\nenabled = true\n', codexHome)
    seedClaudeInstall(claudeConfigDir)
    seedCodexInstall(codexHome)

    expect(detectCanonryAgentPlugin({ home: homeDir, claudeConfigDir, codexHome })).toEqual({
      configuredClients: ['claude-code', 'codex'],
      verifiedClients: ['claude-code', 'codex'],
      verifiedClientVersions: { 'claude-code': '1.0.0', codex: '1.0.0' },
    })
  })

  it('matches only the official plugin identity', () => {
    write('.claude/settings.json', JSON.stringify({
      enabledPlugins: { 'canonry@evil': true, canonry: true },
    }))
    write('.codex/config.toml', '[plugins."canonry@evil"]\nenabled = true\n[plugins.canonry]\nenabled = true\n')
    seedClaudeInstall()
    seedCodexInstall()

    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: [],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })

  it('ignores missing, malformed, disabled, and unrelated settings', () => {
    write('.claude/settings.json', '{not-json')
    write('.codex/config.toml', '[plugins."unrelated@tools"]\nenabled = true\n[plugins."canonry@canonry"]\nenabled = false\n')
    expect(detectCanonryAgentPlugin({ home: homeDir })).toEqual({
      configuredClients: [],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
    expect(detectCanonryAgentPlugin()).toEqual({
      configuredClients: [],
      verifiedClients: [],
      verifiedClientVersions: {},
    })
  })
})
