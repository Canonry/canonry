import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_MANIFEST_FILENAME, type SkillManifest } from '@ainyc/canonry-contracts'
import { CliError } from '../src/cli-error.js'
import { PACKAGE_VERSION } from '../src/package-version.js'
import {
  BUNDLED_SKILL_NAMES,
  emitInstallSummary,
  getBundledSkills,
  getBundledSkillSnapshots,
  getMissingUserSkillsNudge,
  installSkills,
  listSkills,
  parseSkillsClient,
  resolveBundledSkillsRoot,
} from '../src/commands/skills.js'

function sha256(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex')
}

function readManifest(skillDir: string): SkillManifest {
  return JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_MANIFEST_FILENAME), 'utf-8')) as SkillManifest
}

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

    const refDir = path.join(tmpRoot, '.claude', 'skills', 'canonry', 'references')
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

  it('preserves a divergent local edit and reports a conflict without --force', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })

    const skillFile = path.join(tmpRoot, '.claude', 'skills', 'aero', 'SKILL.md')
    fs.writeFileSync(skillFile, 'tampered content', 'utf-8')

    // Additive install no longer throws on a local edit — it keeps the edit and
    // surfaces it as a conflict so an agent/operator can decide to --force.
    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })
    const aero = summary.results.find(r => r.skill === 'aero')!
    expect(aero.conflicts).toContain('SKILL.md')
    expect(aero.status).toBe('already-installed')
    expect(aero.message).toMatch(/--force/)
    expect(fs.readFileSync(skillFile, 'utf-8')).toBe('tampered content')
    expect(summary.message).toMatch(/--force/)
  })

  it('overwrites divergent content when --force is set', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })

    const skillFile = path.join(tmpRoot, '.claude', 'skills', 'aero', 'SKILL.md')
    fs.writeFileSync(skillFile, 'tampered content', 'utf-8')

    const summary = await installSkills({ dir: tmpRoot, client: 'claude', force: true })
    const aeroResult = summary.results.find(r => r.skill === 'aero')
    expect(aeroResult?.status).toBe('updated')
    expect(aeroResult?.updated).toContain('SKILL.md')
    expect(aeroResult?.conflicts).toEqual([])
    expect(fs.readFileSync(skillFile, 'utf-8')).not.toBe('tampered content')
  })

  it('additively re-adds a net-new bundled file without --force', async () => {
    // Simulates an existing install that predates a newly shipped reference:
    // delete a file post-install, then reinstall — the gap is filled, untouched.
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const canonryDir = path.join(tmpRoot, '.claude', 'skills', 'canonry')
    const refs = fs.readdirSync(path.join(canonryDir, 'references')).filter(f => f.endsWith('.md'))
    expect(refs.length).toBeGreaterThan(0)
    const droppedRel = path.join('references', refs[0]!)
    fs.rmSync(path.join(canonryDir, droppedRel))

    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })
    const canonry = summary.results.find(r => r.skill === 'canonry')!
    expect(canonry.status).toBe('updated')
    expect(canonry.added).toContain(droppedRel)
    expect(canonry.conflicts).toEqual([])
    expect(fs.existsSync(path.join(canonryDir, droppedRel))).toBe(true)
  })

  it('adds a missing file AND preserves an unrelated local edit in the same run (acceptance)', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const canonryDir = path.join(tmpRoot, '.claude', 'skills', 'canonry')
    const refs = fs.readdirSync(path.join(canonryDir, 'references')).filter(f => f.endsWith('.md'))
    const droppedRel = path.join('references', refs[0]!)
    fs.rmSync(path.join(canonryDir, droppedRel))
    const skillFile = path.join(canonryDir, 'SKILL.md')
    fs.writeFileSync(skillFile, 'my local notes', 'utf-8')

    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })
    const canonry = summary.results.find(r => r.skill === 'canonry')!
    // Net-new reference filled in...
    expect(canonry.added).toContain(droppedRel)
    expect(fs.existsSync(path.join(canonryDir, droppedRel))).toBe(true)
    // ...while the unrelated local edit is left exactly as the operator left it.
    expect(canonry.conflicts).toContain('SKILL.md')
    expect(fs.readFileSync(skillFile, 'utf-8')).toBe('my local notes')
    expect(canonry.status).toBe('updated')
  })

  it('refreshes an upstream-updated file the operator never touched (stale), no --force', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const aeroDir = path.join(tmpRoot, '.claude', 'skills', 'aero')
    const skillFile = path.join(aeroDir, 'SKILL.md')
    const bundledContent = fs.readFileSync(skillFile, 'utf-8')

    // Simulate "the bundle shipped a newer SKILL.md since this install": rewrite
    // the on-disk file AND its manifest entry to the same older hash, so it
    // matches the manifest (canonry-written) but diverges from the bundle.
    const olderContent = `${bundledContent}\n<!-- older shipped revision -->\n`
    fs.writeFileSync(skillFile, olderContent, 'utf-8')
    const manifest = readManifest(aeroDir)
    manifest.files['SKILL.md'] = sha256(olderContent)
    fs.writeFileSync(path.join(aeroDir, SKILL_MANIFEST_FILENAME), JSON.stringify(manifest), 'utf-8')

    const summary = await installSkills({ dir: tmpRoot, client: 'claude' })
    const aero = summary.results.find(r => r.skill === 'aero')!
    expect(aero.status).toBe('updated')
    expect(aero.updated).toContain('SKILL.md')
    expect(aero.conflicts).toEqual([])
    // Restored to the bundled content (not the older revision).
    expect(fs.readFileSync(skillFile, 'utf-8')).toBe(bundledContent)
  })

  it('writes a manifest (version + per-file hashes) into the installed tree', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const canonryDir = path.join(tmpRoot, '.claude', 'skills', 'canonry')
    const manifest = readManifest(canonryDir)

    expect(manifest.skill).toBe('canonry')
    expect(manifest.version.length).toBeGreaterThan(0)
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0)
    // The recorded hash matches the actual installed file content.
    expect(manifest.files['SKILL.md']).toBe(sha256(fs.readFileSync(path.join(canonryDir, 'SKILL.md'), 'utf-8')))
    // The manifest is metadata, not tracked content — its presence does not
    // count as drift, so a second install is still a clean no-op.
    const second = await installSkills({ dir: tmpRoot, client: 'claude' })
    for (const r of second.results) expect(r.status).toBe('already-installed')
  })
})

describe('getBundledSkillSnapshots', () => {
  it('returns version + per-file sha256 hashes for every bundled skill', () => {
    const snapshots = getBundledSkillSnapshots()
    expect(snapshots.map(s => s.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
    for (const snap of snapshots) {
      expect(snap.version.length).toBeGreaterThan(0)
      expect(Object.keys(snap.files).length).toBeGreaterThan(0)
      expect(snap.files['SKILL.md']).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('matches the hashes written into a fresh install', async () => {
    await installSkills({ dir: tmpRoot, client: 'claude' })
    const snapshots = getBundledSkillSnapshots()
    const aeroSnap = snapshots.find(s => s.name === 'aero')!
    const aeroManifest = readManifest(path.join(tmpRoot, '.claude', 'skills', 'aero'))
    expect(aeroManifest.files).toEqual(aeroSnap.files)
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
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'skills', 'canonry'))).toBe(false)
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

describe('installSkills --user shortcut', () => {
  // Sandbox $HOME so the test doesn't write into the real user-level Claude
  // config. afterEach restores.
  let savedHome: string | undefined
  let userHome: string

  beforeEach(() => {
    savedHome = process.env.HOME
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skills-user-'))
    process.env.HOME = userHome
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    fs.rmSync(userHome, { recursive: true, force: true })
  })

  it('installs into os.homedir() when user: true is passed', async () => {
    const summary = await installSkills({ user: true, client: 'claude' })
    expect(summary.targetDir).toBe(os.homedir())
    for (const name of BUNDLED_SKILL_NAMES) {
      expect(fs.existsSync(path.join(summary.targetDir, '.claude', 'skills', name, 'SKILL.md'))).toBe(true)
    }
  })

  it('user: true overrides dir', async () => {
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skills-decoy-'))
    try {
      const summary = await installSkills({ user: true, dir: decoy, client: 'claude' })
      expect(summary.targetDir).toBe(os.homedir())
      // Nothing written to the decoy dir.
      for (const name of BUNDLED_SKILL_NAMES) {
        expect(fs.existsSync(path.join(decoy, '.claude', 'skills', name))).toBe(false)
      }
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true })
    }
  })
})

describe('getMissingUserSkillsNudge', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skills-nudge-'))
  })

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  function seedSkill(name: string): void {
    const dir = path.join(homeDir, '.claude', 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n', 'utf-8')
  }

  it('returns null when both bundled skills are installed', () => {
    for (const name of BUNDLED_SKILL_NAMES) seedSkill(name)
    expect(getMissingUserSkillsNudge(homeDir)).toBeNull()
  })

  it('returns a nudge listing every missing skill when none are installed', () => {
    const nudge = getMissingUserSkillsNudge(homeDir)
    expect(nudge).not.toBeNull()
    expect(nudge!.missing.sort()).toEqual([...BUNDLED_SKILL_NAMES].sort())
    expect(nudge!.installed).toEqual([])
    expect(nudge!.message).toContain('canonry skills install --user')
    expect(nudge!.message).toContain('~/.claude/skills/')
  })

  it('returns a tailored nudge that names only the missing skill when one is installed', () => {
    seedSkill('canonry')
    const nudge = getMissingUserSkillsNudge(homeDir)
    expect(nudge).not.toBeNull()
    expect(nudge!.installed).toEqual(['canonry'])
    expect(nudge!.missing).toEqual(['aero'])
    expect(nudge!.message).toContain('canonry skills install aero --user')
  })

  it('returns null when $HOME is undefined (can\'t safely tell)', () => {
    expect(getMissingUserSkillsNudge(undefined)).toBeNull()
  })

  it('returns null when a native Canonry plugin supplies the skills', () => {
    expect(getMissingUserSkillsNudge(homeDir, {
      configuredClients: ['claude-code'],
      verifiedClients: ['claude-code'],
      verifiedClientVersions: { 'claude-code': PACKAGE_VERSION },
    })).toBeNull()
  })

  it('suppresses legacy delivery nudges for a separately verified Codex-only plugin', () => {
    expect(getMissingUserSkillsNudge(homeDir, {
      configuredClients: ['codex'],
      verifiedClients: ['codex'],
      verifiedClientVersions: { codex: PACKAGE_VERSION },
    })).toBeNull()
  })

  it('surfaces any configured client whose plugin cache is unverified', () => {
    const nudge = getMissingUserSkillsNudge(homeDir, {
      configuredClients: ['claude-code', 'codex'],
      verifiedClients: ['claude-code'],
      verifiedClientVersions: { 'claude-code': PACKAGE_VERSION },
    })
    expect(nudge).not.toBeNull()
    expect(nudge!.message).toMatch(/cached manifest and skill assets could not be verified/i)
    expect(nudge!.message).toContain('canonry@canonry')
    expect(nudge!.message).toContain('Codex')
    expect(nudge!.message).not.toContain('Claude Code')
  })

  it('warns when a verified plugin cache version is stale', () => {
    const nudge = getMissingUserSkillsNudge(homeDir, {
      configuredClients: ['claude-code', 'codex'],
      verifiedClients: ['claude-code', 'codex'],
      verifiedClientVersions: { 'claude-code': PACKAGE_VERSION, codex: '0.0.1' },
    })
    expect(nudge).not.toBeNull()
    expect(nudge!.message).toContain('Codex v0.0.1')
    expect(nudge!.message).toContain(`Canonry v${PACKAGE_VERSION}`)
    expect(nudge!.message).not.toContain('Claude Code')
  })
})
