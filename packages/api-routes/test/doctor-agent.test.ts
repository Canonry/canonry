import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_MANIFEST_FILENAME, type BundledSkillSnapshot, type SkillManifest } from '@ainyc/canonry-contracts'
import { AGENT_CHECKS } from '../src/doctor/checks/agent.js'
import type { DoctorContext } from '../src/doctor/types.js'

const skillsCheck = AGENT_CHECKS.find(c => c.id === 'agent.skills.installed')!
const currentCheck = AGENT_CHECKS.find(c => c.id === 'agent.skills.current')!

function sha256(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex')
}

const emptyCtx: DoctorContext = {
  db: {} as DoctorContext['db'],
  project: null,
}

describe('agent.skills.installed', () => {
  let tmpHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-doctor-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns ok when both canonry and aero skills are installed under ~/.claude/skills/', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills', 'canonry'), { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills', 'aero'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, '.claude', 'skills', 'canonry', 'SKILL.md'), '# canonry')
    fs.writeFileSync(path.join(tmpHome, '.claude', 'skills', 'aero', 'SKILL.md'), '# aero')

    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.installed')
    expect(result.remediation).toBeNull()
  })

  it('returns ok when a native plugin supplies the skills', async () => {
    const result = await skillsCheck.run({
      ...emptyCtx,
      getAgentPluginState: () => ({
        configuredClients: ['claude-code'],
        verifiedClients: ['claude-code'],
      }),
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.plugin-installed')
    expect(result.summary).toContain('Claude Code')
  })

  it('reports a verified Codex-only install without implying Claude Code coverage', async () => {
    const result = await skillsCheck.run({
      ...emptyCtx,
      getAgentPluginState: () => ({
        configuredClients: ['codex'],
        verifiedClients: ['codex'],
      }),
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.plugin-installed')
    expect(result.summary).toContain('Codex')
    expect(result.summary).not.toContain('Claude Code')
    expect(result.details).toMatchObject({
      configuredClients: ['codex'],
      verifiedClients: ['codex'],
    })
  })

  it('warns when one configured client is unverified even if another client is verified', async () => {
    const result = await skillsCheck.run({
      ...emptyCtx,
      getAgentPluginState: () => ({
        configuredClients: ['claude-code', 'codex'],
        verifiedClients: ['claude-code'],
      }),
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.plugin-unverified')
    expect(result.remediation).toMatch(/reinstall/i)
  })

  it('reads plugin state at check time instead of freezing daemon-start state', async () => {
    let verified = false
    const ctx: DoctorContext = {
      ...emptyCtx,
      getAgentPluginState: () => ({
        configuredClients: ['claude-code'],
        verifiedClients: verified ? ['claude-code'] : [],
      }),
    }

    expect((await skillsCheck.run(ctx)).code).toBe('agent.skills.plugin-unverified')
    verified = true
    expect((await skillsCheck.run(ctx)).code).toBe('agent.skills.plugin-installed')
  })

  it('returns warn when neither skill is installed', async () => {
    // ~/.claude/skills/ does not exist
    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.not-installed')
    expect(result.remediation).toMatch(/canonry skills install/i)
    expect(result.details).toBeDefined()
    expect(result.details!.missing).toEqual(['canonry', 'aero'])
  })

  it('returns warn when only one of the two skills is installed', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills', 'canonry'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, '.claude', 'skills', 'canonry', 'SKILL.md'), '# canonry')
    // aero is missing

    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.partial')
    expect(result.details!.missing).toEqual(['aero'])
    expect(result.details!.installed).toEqual(['canonry'])
  })

  it('considers a directory without SKILL.md as not-installed (half-installed guard)', async () => {
    // Mkdir but no SKILL.md → should NOT count as installed.
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills', 'canonry'), { recursive: true })
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills', 'aero'), { recursive: true })

    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.not-installed')
  })

  it('returns skipped when HOME cannot be resolved', async () => {
    delete process.env.HOME
    // Restore so afterEach can find the original
    process.env.HOME = ''
    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent.skills.no-home')
  })

  it('checks under HOME from process.env, not cwd', async () => {
    // Set HOME to a non-existent path. The check should reflect that path.
    const fakeHome = path.join(tmpHome, 'nowhere')
    process.env.HOME = fakeHome
    const result = await skillsCheck.run(emptyCtx)
    expect(result.status).toBe('warn')
    expect(result.details!.checkedPath).toBe(path.join(fakeHome, '.claude', 'skills'))
  })
})

interface SkillDriftDetailShape {
  name: string
  installed: boolean
  installedVersion: string | null
  missing: string[]
  stale: string[]
  edited: string[]
  behind: boolean
}
interface CurrentDetailsShape {
  checkedPath: string
  bundledVersion: string
  skills: SkillDriftDetailShape[]
}

describe('agent.skills.current', () => {
  let tmpHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-current-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  function ctxWith(bundledSkills?: BundledSkillSnapshot[]): DoctorContext {
    return { db: {} as DoctorContext['db'], project: null, bundledSkills }
  }

  function seedFile(name: string, rel: string, content: string): void {
    const p = path.join(tmpHome, '.claude', 'skills', name, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf-8')
  }

  function seedManifest(name: string, manifest: SkillManifest): void {
    const dir = path.join(tmpHome, '.claude', 'skills', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SKILL_MANIFEST_FILENAME), JSON.stringify(manifest), 'utf-8')
  }

  function detailsOf(result: { details?: Record<string, unknown> }): CurrentDetailsShape {
    return result.details as unknown as CurrentDetailsShape
  }

  it('skips when no bundled snapshot is injected', async () => {
    const result = await currentCheck.run(ctxWith(undefined))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent.skills.bundle-unavailable')
  })

  it('skips plugin freshness when the running bundle version is unavailable', async () => {
    const result = await currentCheck.run({
      ...ctxWith(undefined),
      getAgentPluginState: () => ({
        configuredClients: ['claude-code'],
        verifiedClients: ['claude-code'],
      }),
    })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent.skills.bundle-unavailable')
    expect(result.summary).toContain('Claude Code')
  })

  it('reports a matching Codex-only plugin as current without implying Claude Code coverage', async () => {
    const result = await currentCheck.run({
      ...ctxWith([{ name: 'canonry', version: '9.9.9', files: {} }]),
      getAgentPluginState: () => ({
        configuredClients: ['codex'],
        verifiedClients: ['codex'],
        verifiedClientVersions: { codex: '9.9.9' },
      }),
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.plugin-current')
    expect(result.summary).toContain('Codex')
    expect(result.summary).not.toContain('Claude Code')
  })

  it('warns when a verified plugin cache version does not match the running bundle', async () => {
    const result = await currentCheck.run({
      ...ctxWith([{ name: 'canonry', version: '9.9.9', files: {} }]),
      getAgentPluginState: () => ({
        configuredClients: ['claude-code'],
        verifiedClients: ['claude-code'],
        verifiedClientVersions: { 'claude-code': '9.9.8' },
      }),
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.plugin-version-mismatch')
    expect(result.summary).toContain('Claude Code v9.9.8')
    expect(result.summary).toContain('Canonry v9.9.9')
  })

  it('warns for only the stale client when another verified client is current', async () => {
    const result = await currentCheck.run({
      ...ctxWith([{ name: 'canonry', version: '9.9.9', files: {} }]),
      getAgentPluginState: () => ({
        configuredClients: ['claude-code', 'codex'],
        verifiedClients: ['claude-code', 'codex'],
        verifiedClientVersions: { 'claude-code': '9.9.9', codex: '9.9.8' },
      }),
    })
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.plugin-version-mismatch')
    expect(result.summary).toContain('Codex v9.9.8')
    expect(result.summary).not.toContain('Claude Code')
  })

  it('skips when HOME cannot be resolved', async () => {
    process.env.HOME = ''
    const result = await currentCheck.run(ctxWith([{ name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('S') } }]))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent.skills.no-home')
  })

  it('skips when the bundled skills are not installed at all', async () => {
    const result = await currentCheck.run(ctxWith([{ name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('S') } }]))
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('agent.skills.none-installed')
  })

  it('returns ok when the installed tree matches the bundled snapshot', async () => {
    seedFile('canonry', 'SKILL.md', 'S')
    seedFile('canonry', 'references/a.md', 'A')
    const result = await currentCheck.run(ctxWith([
      { name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('S'), 'references/a.md': sha256('A') } },
    ]))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('agent.skills.current')
    expect(result.summary).toContain('9.9.9')
  })

  it('warns when a newly shipped bundled file is missing from the install', async () => {
    seedFile('canonry', 'SKILL.md', 'S')
    const result = await currentCheck.run(ctxWith([
      { name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('S'), 'references/new.md': sha256('N') } },
    ]))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.behind')
    expect(result.remediation).toMatch(/canonry skills install/i)
    const canonry = detailsOf(result).skills.find(s => s.name === 'canonry')!
    expect(canonry.missing).toEqual(['references/new.md'])
    expect(canonry.behind).toBe(true)
  })

  it('warns when an upstream-updated file is stale (matches manifest, not bundle)', async () => {
    seedFile('canonry', 'SKILL.md', 'OLD')
    seedManifest('canonry', { skill: 'canonry', version: '9.9.8', files: { 'SKILL.md': sha256('OLD') } })
    const result = await currentCheck.run(ctxWith([
      { name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('NEW') } },
    ]))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('agent.skills.behind')
    const canonry = detailsOf(result).skills.find(s => s.name === 'canonry')!
    expect(canonry.stale).toEqual(['SKILL.md'])
    expect(canonry.installedVersion).toBe('9.9.8')
  })

  it('treats a local edit as diverged, not behind (stays ok)', async () => {
    seedFile('canonry', 'SKILL.md', 'MINE')
    seedManifest('canonry', { skill: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('ORIG') } })
    const result = await currentCheck.run(ctxWith([
      { name: 'canonry', version: '9.9.9', files: { 'SKILL.md': sha256('BUNDLE') } },
    ]))
    expect(result.status).toBe('ok')
    const canonry = detailsOf(result).skills.find(s => s.name === 'canonry')!
    expect(canonry.edited).toEqual(['SKILL.md'])
    expect(canonry.missing).toEqual([])
    expect(canonry.stale).toEqual([])
    expect(canonry.behind).toBe(false)
  })
})
