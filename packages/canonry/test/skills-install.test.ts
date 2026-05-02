import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliError } from '../src/cli-error.js'
import {
  BUNDLED_SKILL_NAMES,
  emitInstallSummary,
  getBundledSkills,
  installSkills,
  listSkills,
  parseSkillsClient,
  resolveBundledSkillsRoot,
} from '../src/commands/skills.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skills-install-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('resolveBundledSkillsRoot', () => {
  it('finds the skills root containing both bundled skills', () => {
    const root = resolveBundledSkillsRoot()
    for (const name of BUNDLED_SKILL_NAMES) {
      expect(fs.existsSync(path.join(root, name, 'SKILL.md'))).toBe(true)
    }
  })
})

describe('getBundledSkills', () => {
  it('returns metadata for both bundled skills', () => {
    const skills = getBundledSkills()
    expect(skills.map(s => s.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(0)
      expect(fs.existsSync(skill.bundledPath)).toBe(true)
    }
  })
})

describe('installSkills (claude only)', () => {
  it('installs both skills as directory trees with no codex symlinks', async () => {
    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })

    expect(summary.targetDir).toBe(tmpRoot)
    expect(summary.results).toHaveLength(BUNDLED_SKILL_NAMES.length)
    for (const r of summary.results) {
      expect(r.client).toBe('claude')
      expect(r.status).toBe('installed')
      expect(fs.existsSync(path.join(r.targetPath, 'SKILL.md'))).toBe(true)
    }
    expect(fs.existsSync(path.join(tmpRoot, '.codex'))).toBe(false)
  })

  it('copies the references/ subdirectory along with SKILL.md', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })

    const refDir = path.join(tmpRoot, '.claude', 'skills', 'canonry-setup', 'references')
    expect(fs.existsSync(refDir)).toBe(true)
    const refs = fs.readdirSync(refDir).filter(f => f.endsWith('.md'))
    expect(refs.length).toBeGreaterThan(0)
  })

  it('is idempotent — second install reports already-installed', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const second = await installSkills({ dir: tmpRoot, client: 'claude' })

    for (const r of second.results) {
      expect(r.status).toBe('already-installed')
    }
  })

  it('refuses to overwrite a divergent local edit without --force', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })

    const skillFile = path.join(tmpRoot, '.claude', 'skills', 'aero', 'SKILL.md')
    fs.writeFileSync(skillFile, 'tampered content', 'utf-8')

    await expect(installSkills({ dir: tmpRoot, client: 'claude' })).rejects.toThrow(CliError)
  })

  it('overwrites divergent content when --force is set', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })

    const skillFile = path.join(tmpRoot, '.claude', 'skills', 'aero', 'SKILL.md')
    fs.writeFileSync(skillFile, 'tampered content', 'utf-8')

    const summary = await installSkills({ dir: tmpRoot, client: 'claude', force: true })
    const aeroResult = summary.results.find(r => r.skill === 'aero')
    expect(aeroResult?.status).toBe('updated')
    expect(fs.readFileSync(skillFile, 'utf-8')).not.toBe('tampered content')
  })
})

describe('installSkills (codex)', () => {
  it('creates relative symlinks pointing at the .claude tree', async () => {
    const summary = await installSkills({ dir: tmpRoot, client: 'all' })

    const codexResults = summary.results.filter(r => r.client === 'codex')
    expect(codexResults).toHaveLength(BUNDLED_SKILL_NAMES.length)

    for (const r of codexResults) {
      expect(r.status).toBe('linked')
      const stat = fs.lstatSync(r.targetPath)
      expect(stat.isSymbolicLink()).toBe(true)
      const target = fs.readlinkSync(r.targetPath)
      expect(target).toBe(`../../.claude/skills/${r.skill}`)
      const claudePath = path.resolve(path.dirname(r.targetPath), target)
      expect(fs.existsSync(path.join(claudePath, 'SKILL.md'))).toBe(true)
    }
  })

  it('reports already-linked on second run', async () => {
    await installSkills({ dir: tmpRoot, client: 'all' })
    const second = await installSkills({ dir: tmpRoot, client: 'all' })

    for (const r of second.results.filter(r => r.client === 'codex')) {
      expect(r.status).toBe('already-linked')
    }
  })

  it('refuses to overwrite a non-symlink at the codex path without --force', async () => {
    await installSkills({ dir: tmpRoot, client: 'all' })

    const codexPath = path.join(tmpRoot, '.codex', 'skills', 'aero')
    fs.unlinkSync(codexPath)
    fs.mkdirSync(codexPath, { recursive: true })
    fs.writeFileSync(path.join(codexPath, 'unrelated.md'), 'hi', 'utf-8')

    await expect(installSkills({ dir: tmpRoot, client: 'all' })).rejects.toThrow(CliError)
  })
})

describe('installSkills — selective skills', () => {
  it('installs only named skills when positional args are supplied', async () => {
    const summary = await installSkills({ dir: tmpRoot, skills: ['aero'], client: 'claude' })

    expect(summary.results).toHaveLength(1)
    expect(summary.results[0]!.skill).toBe('aero')
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'skills', 'canonry-setup'))).toBe(false)
  })

  it('rejects unknown skill names with VALIDATION_ERROR', async () => {
    await expect(
      installSkills({ dir: tmpRoot, skills: ['nonexistent'], client: 'claude' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('listSkills', () => {
  it('emits one bullet per bundled skill in text mode', () => {
    const logs: string[] = []
    const orig = console.log
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
    try {
      listSkills()
    } finally {
      console.log = orig
    }
    const joined = logs.join('\n')
    for (const name of BUNDLED_SKILL_NAMES) {
      expect(joined).toContain(name)
    }
  })

  it('emits a structured JSON object in --format json mode', () => {
    const logs: string[] = []
    const orig = console.log
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
    try {
      listSkills({ format: 'json' })
    } finally {
      console.log = orig
    }
    const parsed = JSON.parse(logs.join('\n')) as {
      skills: Array<{ name: string; description: string; claudePath: string; codexPath: string }>
    }
    expect(parsed.skills.map(s => s.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
    for (const skill of parsed.skills) {
      expect(skill.claudePath).toBe(`.claude/skills/${skill.name}`)
      expect(skill.codexPath).toBe(`.codex/skills/${skill.name}`)
    }
  })
})

describe('emitInstallSummary', () => {
  it('serializes the summary as JSON in --format json', async () => {
    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })

    const logs: string[] = []
    const orig = console.log
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
    try {
      emitInstallSummary(summary, 'json')
    } finally {
      console.log = orig
    }
    const parsed = JSON.parse(logs.join('\n'))
    expect(parsed).toMatchObject({ targetDir: summary.targetDir, message: summary.message })
    expect(Array.isArray((parsed as { results: unknown[] }).results)).toBe(true)
  })
})

describe('parseSkillsClient', () => {
  it('defaults to all when undefined', () => {
    expect(parseSkillsClient(undefined)).toBe('all')
  })

  it('accepts claude, codex, all', () => {
    expect(parseSkillsClient('claude')).toBe('claude')
    expect(parseSkillsClient('codex')).toBe('codex')
    expect(parseSkillsClient('all')).toBe('all')
  })

  it('rejects anything else with VALIDATION_ERROR', () => {
    expect(() => parseSkillsClient('cursor')).toThrow(CliError)
  })
})
