import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

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

interface PortablePluginManifest extends VersionManifest {
  $schema: string
  name: string
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

function readSkillFrontmatter(skillDir: string): Record<string, unknown> {
  const body = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
  const match = /^---\n([\s\S]*?)\n---/.exec(body)
  expect(match, `${skillDir}/SKILL.md frontmatter`).not.toBeNull()
  return parse(match![1]!) as Record<string, unknown>
}

describe('native Canonry plugin bundle', () => {
  it('keeps the portable and client manifests on the published Canonry version', () => {
    const rootPackage = readJson<VersionManifest>(path.join(repoRoot, 'package.json'))
    const canonryPackage = readJson<VersionManifest>(path.join(repoRoot, 'packages', 'canonry', 'package.json'))
    const portableManifest = readJson<PortablePluginManifest>(path.join(pluginRoot, 'plugin.json'))
    const codexManifest = readJson<PluginManifest>(path.join(pluginRoot, '.codex-plugin', 'plugin.json'))
    const claudeManifest = readJson<PluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))

    expect(rootPackage.version).toBe(canonryPackage.version)
    expect(portableManifest.version).toBe(canonryPackage.version)
    expect(codexManifest.version).toBe(canonryPackage.version)
    expect(claudeManifest.version).toBe(canonryPackage.version)
    expect(portableManifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(portableManifest.name).toBe('canonry')
    expect(Object.keys(portableManifest).sort()).toEqual([
      '$schema',
      'author',
      'description',
      'homepage',
      'keywords',
      'license',
      'name',
      'repository',
      'version',
    ])
    expect(codexManifest.name).toBe('canonry')
    expect(claudeManifest.name).toBe('canonry')
    expect(codexManifest.skills).toBe('./skills/')
    expect(claudeManifest.skills).toBe('./skills/')
    expect(codexManifest.mcpServers).toBe('./.mcp.json')
    expect(claudeManifest.mcpServers).toBe('./.mcp.json')
    const sharedFields = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
    for (const field of sharedFields) {
      const portableValue = (portableManifest as unknown as Record<string, unknown>)[field]
      expect((codexManifest as unknown as Record<string, unknown>)[field]).toEqual(portableValue)
      expect((claudeManifest as unknown as Record<string, unknown>)[field]).toEqual(portableValue)
    }
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

  it('bundles Agent Skills-compliant frontmatter', () => {
    const allowedFields = new Set([
      'name',
      'description',
      'license',
      'compatibility',
      'metadata',
      'allowed-tools',
    ])

    for (const skill of managedSkills) {
      const frontmatter = readSkillFrontmatter(path.join(pluginRoot, 'skills', skill))
      expect(frontmatter.name).toBe(skill)
      expect(skill).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      expect(skill).not.toContain('--')
      expect(skill.length).toBeLessThanOrEqual(64)
      expect(typeof frontmatter.description).toBe('string')
      expect((frontmatter.description as string).length).toBeGreaterThan(0)
      expect((frontmatter.description as string).length).toBeLessThanOrEqual(1024)
      expect(Object.keys(frontmatter).every((field) => allowedFields.has(field))).toBe(true)
      for (const field of ['license', 'allowed-tools']) {
        if (frontmatter[field] !== undefined) expect(typeof frontmatter[field]).toBe('string')
      }
      if (frontmatter.compatibility !== undefined) {
        expect(typeof frontmatter.compatibility).toBe('string')
        expect((frontmatter.compatibility as string).length).toBeLessThanOrEqual(500)
      }
      if (frontmatter.metadata !== undefined) {
        expect(frontmatter.metadata).not.toBeNull()
        expect(Array.isArray(frontmatter.metadata)).toBe(false)
        expect(typeof frontmatter.metadata).toBe('object')
        expect(Object.values(frontmatter.metadata as Record<string, unknown>)
          .every((value) => typeof value === 'string')).toBe(true)
      }
    }
  })

  it('launches only the installed canonry-mcp binary and embeds no credentials', () => {
    const portableMcp = readJson<unknown>(path.join(pluginRoot, 'mcp.json'))
    const legacyMcp = readJson<unknown>(path.join(pluginRoot, '.mcp.json'))
    expect(portableMcp).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        canonry: {
          type: 'stdio',
          command: 'canonry-mcp',
          args: [],
        },
      },
    })
    expect(legacyMcp).toEqual({
      mcpServers: {
        canonry: {
          command: 'canonry-mcp',
          args: [],
        },
      },
    })
    expect(JSON.stringify([portableMcp, legacyMcp])).not.toMatch(/cnry_[a-z0-9]+/i)
    expect(JSON.stringify([portableMcp, legacyMcp])).not.toMatch(/api[_-]?key/i)
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
    expect(pluginReadme).toContain('cnry bootstrap')
    expect(pluginReadme).toContain('Provider credentials are optional')
    expect(pluginReadme).not.toContain('cnry init --skip-skills --skip-mcp')
    expect(operatorSkill).toContain('cnry bootstrap')
    expect(operatorSkill).toContain('Use `cnry init` only as an optional interactive first-time')
    expect(operatorSkill).toMatch(/explicit approval before every mutation or quota-consuming sweep/i)
  })

  it('requires a version advancement for plugin changes only when a base ref is supplied', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-plugin-version-'))
    const scriptPath = path.join(scratch, 'scripts', 'sync-canonry-plugin.mjs')
    const versionedFiles = [
      'package.json',
      'packages/canonry/package.json',
      'plugins/canonry/plugin.json',
      'plugins/canonry/.codex-plugin/plugin.json',
      'plugins/canonry/.claude-plugin/plugin.json',
    ]

    try {
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.copyFileSync(path.join(repoRoot, 'scripts', 'sync-canonry-plugin.mjs'), scriptPath)

      const sharedPluginMetadata = {
        name: 'canonry',
        version: '1.0.0',
        description: 'Canonry test plugin',
        author: { name: 'Canonry' },
        homepage: 'https://canonry.ai',
        repository: 'https://github.com/Canonry/canonry',
        license: 'FSL-1.1-ALv2',
        keywords: ['aeo'],
      }
      for (const relativePath of versionedFiles) {
        const value = relativePath === 'package.json' || relativePath === 'packages/canonry/package.json'
          ? { version: '1.0.0' }
          : relativePath === 'plugins/canonry/plugin.json'
            ? {
                $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
                ...sharedPluginMetadata,
              }
            : sharedPluginMetadata
        writeJson(path.join(scratch, relativePath), value)
      }
      writeJson(path.join(scratch, 'plugins/canonry/mcp.json'), {
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          canonry: { type: 'stdio', command: 'canonry-mcp', args: [] },
        },
      })
      writeJson(path.join(scratch, 'plugins/canonry/.mcp.json'), {
        mcpServers: {
          canonry: { command: 'canonry-mcp', args: [] },
        },
      })
      for (const skill of managedSkills) {
        const content = `${skill} skill\n`
        const relativePath = path.join('skills', skill, 'SKILL.md')
        fs.mkdirSync(path.join(scratch, path.dirname(relativePath)), { recursive: true })
        fs.writeFileSync(path.join(scratch, relativePath), content)
        fs.mkdirSync(path.join(scratch, 'plugins', 'canonry', path.dirname(relativePath)), { recursive: true })
        fs.writeFileSync(path.join(scratch, 'plugins', 'canonry', relativePath), content)
      }
      for (const file of [
        'packages/api-routes/src/visibility-attribution.ts',
        'packages/canonry/src/gsc-sitemap-submission.ts',
        'docs/GUARDS.md',
        'docs/DOC_UPDATE.md',
      ]) {
        const full = path.join(scratch, file)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, `// ${path.basename(file)}\n`)
      }
      fs.mkdirSync(path.join(scratch, 'docs'), { recursive: true })
      fs.writeFileSync(
        path.join(scratch, 'docs', 'CODEMAP.md'),
        '# CODEMAP\nvisibility-attribution\ngsc-sitemap-submission\nGUARDS.md\nDOC_UPDATE.md\nfind apps packages -type f -name\n',
      )

      execFileSync('git', ['init', '--quiet'], { cwd: scratch })
      execFileSync('git', ['config', 'user.email', 'plugin-test@canonry.invalid'], { cwd: scratch })
      execFileSync('git', ['config', 'user.name', 'Canonry plugin test'], { cwd: scratch })
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: scratch })
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
        const manifestPath = path.join(scratch, relativePath)
        writeJson(manifestPath, { ...readJson<Record<string, unknown>>(manifestPath), version: '1.0.1' })
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
