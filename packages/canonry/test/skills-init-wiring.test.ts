import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../src/commands/init.js'

let configDir: string
let projectDir: string
let logs: string[]
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  configDir = path.join(os.tmpdir(), `canonry-init-skills-cfg-${crypto.randomUUID()}`)
  projectDir = path.join(os.tmpdir(), `canonry-init-skills-project-${crypto.randomUUID()}`)
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  fs.mkdirSync(projectDir, { recursive: true })
  logs = []
  logSpy = vi.spyOn(console, 'log').mockImplementation((value: string) => {
    logs.push(String(value))
  })
})

afterEach(() => {
  logSpy.mockRestore()
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('canonry init + skills auto-install', () => {
  it('auto-installs skills when --skills-dir points at a project-shaped directory', async () => {
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}')

    await initCommand({
      force: true,
      geminiKey: 'test-gemini-key',
      skillsDir: projectDir,
      format: 'json',
    })

    expect(fs.existsSync(path.join(projectDir, '.claude', 'skills', 'canonry-setup', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(projectDir, '.claude', 'skills', 'aero', 'SKILL.md'))).toBe(true)
    expect(fs.lstatSync(path.join(projectDir, '.codex', 'skills', 'aero')).isSymbolicLink()).toBe(true)
  })

  it('skips auto-install when --skills-dir has no project markers', async () => {
    await initCommand({
      force: true,
      geminiKey: 'test-gemini-key',
      skillsDir: projectDir,
      format: 'json',
    })

    expect(fs.existsSync(path.join(projectDir, '.claude'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, '.codex'))).toBe(false)
  })

  it('honors --skip-skills even when cwd looks like a project', async () => {
    fs.writeFileSync(path.join(projectDir, 'canonry.yaml'), 'apiVersion: canonry/v1\n')

    await initCommand({
      force: true,
      geminiKey: 'test-gemini-key',
      skillsDir: projectDir,
      skipSkills: true,
      format: 'json',
    })

    expect(fs.existsSync(path.join(projectDir, '.claude'))).toBe(false)
  })

  it('includes the skills summary in the init JSON output', async () => {
    fs.writeFileSync(path.join(projectDir, '.git'), 'gitdir: irrelevant\n')

    await initCommand({
      force: true,
      geminiKey: 'test-gemini-key',
      skillsDir: projectDir,
      format: 'json',
    })

    // The init command emits two JSON lines (config + maybe agent prompt skip);
    // the first one carries the `skills` field.
    const jsonLine = logs.find(line => line.trim().startsWith('{') && line.includes('"initialized"'))
    expect(jsonLine).toBeTruthy()
    const parsed = JSON.parse(jsonLine!) as { skills?: { results: Array<{ status: string }> } }
    expect(parsed.skills?.results.length).toBeGreaterThan(0)
  })
})
