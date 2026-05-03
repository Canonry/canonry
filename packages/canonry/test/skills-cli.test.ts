import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-skills-cli-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('canonry skills list', () => {
  it('lists bundled skills in text mode', async () => {
    const result = await invokeCli(['skills', 'list'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('canonry-setup')
    expect(result.stdout).toContain('aero')
  })

  it('emits structured JSON with --format json', async () => {
    const result = await invokeCli(['skills', 'list', '--format', 'json'])
    const parsed = parseJsonOutput(result.stdout) as {
      skills: Array<{ name: string; description: string }>
    }
    expect(parsed.skills.map(s => s.name).sort()).toEqual(['aero', 'canonry-setup'])
  })
})

describe('canonry skills install', () => {
  it('installs both skills into the target directory', async () => {
    const result = await invokeCli(['skills', 'install', '--dir', tmpRoot])
    expect(result.exitCode).toBeUndefined()
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'skills', 'canonry-setup', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, '.claude', 'skills', 'aero', 'SKILL.md'))).toBe(true)
    expect(fs.lstatSync(path.join(tmpRoot, '.codex', 'skills', 'aero')).isSymbolicLink()).toBe(true)
  })

  it('honors --client claude (no codex symlinks)', async () => {
    const result = await invokeCli(['skills', 'install', '--dir', tmpRoot, '--client', 'claude'])
    expect(result.exitCode).toBeUndefined()
    expect(fs.existsSync(path.join(tmpRoot, '.codex'))).toBe(false)
  })

  it('errors with VALIDATION_ERROR for unknown skill names', async () => {
    const result = await invokeCli(['skills', 'install', 'nonexistent', '--dir', tmpRoot, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.stderr) as { error: { code: string } }
    expect(parsed.error.code).toBe('VALIDATION_ERROR')
  })

  it('emits a structured summary with --format json', async () => {
    const result = await invokeCli(['skills', 'install', '--dir', tmpRoot, '--format', 'json'])
    const parsed = parseJsonOutput(result.stdout) as {
      targetDir: string
      results: Array<{ skill: string; client: string; status: string }>
    }
    expect(parsed.targetDir).toBe(tmpRoot)
    expect(parsed.results.every(r => r.status === 'installed' || r.status === 'linked')).toBe(true)
  })
})
