import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const pluginRoot = path.join(repoRoot, 'plugins', 'canonry')
const managedSkills = ['aero', 'canonry']

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

interface VersionManifest {
  version: string
}

interface PluginManifest extends VersionManifest {
  name: string
  skills: string
  mcpServers: string
}

interface CodexMarketplace {
  plugins: Array<{ name: string; source: { path: string } }>
}

interface ClaudeMarketplace {
  plugins: Array<{ name: string; source: string }>
}

function walkFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(absolute, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

describe('native Canonry plugin bundle', () => {
  it('keeps both client manifests on the published Canonry version', () => {
    const rootPackage = readJson<VersionManifest>(path.join(repoRoot, 'package.json'))
    const canonryPackage = readJson<VersionManifest>(path.join(repoRoot, 'packages', 'canonry', 'package.json'))
    const codexManifest = readJson<PluginManifest>(path.join(pluginRoot, '.codex-plugin', 'plugin.json'))
    const claudeManifest = readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))

    expect(rootPackage.version).toBe(canonryPackage.version)
    expect(codexManifest.version).toBe(canonryPackage.version)
    expect(claudeManifest.version).toBe(canonryPackage.version)
    expect(codexManifest.name).toBe('canonry')
    expect(claudeManifest.name).toBe('canonry')
    expect(codexManifest.skills).toBe('./skills/')
    expect(claudeManifest.skills).toBe('./skills/')
    expect(codexManifest.mcpServers).toBe('./.mcp.json')
    expect(claudeManifest.mcpServers).toBe('./.mcp.json')
  })

  it('contains exact generated mirrors of the canonical skill trees', () => {
    const bundledNames = fs.readdirSync(path.join(pluginRoot, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(bundledNames).toEqual(managedSkills)

    for (const skill of managedSkills) {
      const source = path.join(repoRoot, 'skills', skill)
      const bundled = path.join(pluginRoot, 'skills', skill)
      const sourceFiles = walkFiles(source)
      expect(walkFiles(bundled)).toEqual(sourceFiles)
      for (const relative of sourceFiles) {
        expect(sha256(path.join(bundled, relative)), `${skill}/${relative}`).toBe(sha256(path.join(source, relative)))
      }
    }
  })

  it('launches only the installed canonry-mcp binary and embeds no credentials', () => {
    const mcp = readJson<unknown>(path.join(pluginRoot, '.mcp.json'))
    expect(mcp).toEqual({
      mcpServers: {
        canonry: {
          command: 'canonry-mcp',
          args: [],
        },
      },
    })
    expect(JSON.stringify(mcp)).not.toMatch(/cnry_[a-z0-9]+/i)
    expect(JSON.stringify(mcp)).not.toMatch(/api[_-]?key/i)
  })

  it('publishes matching repository marketplaces for both clients', () => {
    const codexMarketplace = readJson<CodexMarketplace>(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'))
    const claudeMarketplace = readJson<ClaudeMarketplace>(path.join(repoRoot, '.claude-plugin', 'marketplace.json'))
    expect(codexMarketplace.plugins).toHaveLength(1)
    expect(codexMarketplace.plugins[0].name).toBe('canonry')
    expect(codexMarketplace.plugins[0].source.path).toBe('./plugins/canonry')
    expect(claudeMarketplace.plugins).toHaveLength(1)
    expect(claudeMarketplace.plugins[0].name).toBe('canonry')
    expect(claudeMarketplace.plugins[0].source).toBe('./plugins/canonry')
  })

  it('documents native initialization and operator approval boundaries', () => {
    const pluginReadme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8')
    const operatorSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'canonry', 'SKILL.md'), 'utf8')
    expect(pluginReadme).toContain('cnry init --skip-skills --skip-mcp')
    expect(operatorSkill).toContain('cnry init --skip-skills --skip-mcp')
    expect(operatorSkill).toMatch(/explicit approval before every mutation or quota-consuming sweep/i)
  })

  it('requires a version advancement for plugin changes only when a base ref is supplied', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-plugin-version-'))
    const scriptPath = path.join(scratch, 'scripts', 'sync-canonry-plugin.mjs')
    const versionedFiles = [
      'package.json',
      'packages/canonry/package.json',
      'plugins/canonry/.codex-plugin/plugin.json',
      'plugins/canonry/.claude-plugin/plugin.json',
    ]

    try {
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'sync-canonry-plugin.mjs'), scriptPath)

      for (const relativePath of versionedFiles) {
        writeJson(path.join(scratch, relativePath), { version: '1.0.0' })
      }
      for (const skill of managedSkills) {
        const content = `${skill} skill\n`
        const relativePath = path.join('skills', skill, 'SKILL.md')
        fs.mkdirSync(path.join(scratch, path.dirname(relativePath)), { recursive: true })
        fs.writeFileSync(path.join(scratch, relativePath), content)
        fs.mkdirSync(path.join(scratch, 'plugins', 'canonry', path.dirname(relativePath)), { recursive: true })
        fs.writeFileSync(path.join(scratch, 'plugins', 'canonry', relativePath), content)
      }

      execFileSync('git', ['init', '--quiet'], { cwd: scratch })
      execFileSync('git', ['config', 'user.email', 'plugin-test@canonry.invalid'], { cwd: scratch })
      execFileSync('git', ['config', 'user.name', 'Canonry plugin test'], { cwd: scratch })
      execFileSync('git', ['add', '.'], { cwd: scratch })
      execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: scratch })
      const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim()

      const changedSkill = 'updated canonry skill\n'
      fs.writeFileSync(path.join(scratch, 'skills', 'canonry', 'SKILL.md'), changedSkill)
      fs.writeFileSync(path.join(scratch, 'plugins', 'canonry', 'skills', 'canonry', 'SKILL.md'), changedSkill)

      const localCheck = spawnSync(process.execPath, [scriptPath, '--check'], { cwd: scratch, encoding: 'utf8' })
      expect(localCheck.status).toBe(0)

      const historyCheck = spawnSync(process.execPath, [scriptPath, '--check', '--base-ref', baseRef], {
        cwd: scratch,
        encoding: 'utf8',
      })
      expect(historyCheck.status).toBe(1)
      expect(historyCheck.stderr).toContain('version must advance beyond 1.0.0')

      for (const relativePath of versionedFiles) {
        writeJson(path.join(scratch, relativePath), { version: '1.0.1' })
      }
      const advancedCheck = spawnSync(process.execPath, [scriptPath, '--check', '--base-ref', baseRef], {
        cwd: scratch,
        encoding: 'utf8',
      })
      expect(advancedCheck.status).toBe(0)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
})
