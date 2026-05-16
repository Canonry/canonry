import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENT_CHECKS } from '../src/doctor/checks/agent.js'
import type { DoctorContext } from '../src/doctor/types.js'

const skillsCheck = AGENT_CHECKS.find(c => c.id === 'agent.skills.installed')!

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
