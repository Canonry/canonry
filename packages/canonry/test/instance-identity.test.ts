import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readGitCommit } from '../scripts/build-commit.js'
import { resolveBuildCommit, resolveInstanceIdentity } from '../src/instance-identity.js'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('readGitCommit (build-time stamp source)', () => {
  it('returns the checkout HEAD sha', () => {
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
    expect(expected).toMatch(/^[0-9a-f]{40,64}$/)
    expect(readGitCommit({ cwd: here })).toBe(expected)
  })

  it('returns undefined outside a repository instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-no-repo-'))
    try {
      // Ceiling at the temp root so git cannot discover a repository above it
      // on a machine whose tmpdir happens to sit inside a checkout.
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) }
      delete env.GIT_DIR
      expect(readGitCommit({ cwd: dir, env })).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined when no git binary is on PATH instead of throwing', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-no-git-'))
    try {
      expect(readGitCommit({ cwd: here, env: { ...process.env, PATH: emptyBin } })).toBeUndefined()
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true })
    }
  })
})

describe('resolveBuildCommit', () => {
  // Unbundled source (vitest) never carries the tsup define, so only the env
  // fallback is reachable here; the stamp's source is covered above.
  it('falls back to CANONRY_COMMIT when no build-time commit is stamped', () => {
    expect(resolveBuildCommit({ CANONRY_COMMIT: 'eed745d5c1f0a4b6e2d8c9a7b3f1e0d2c4b6a8f0' })).toBe(
      'eed745d5c1f0a4b6e2d8c9a7b3f1e0d2c4b6a8f0',
    )
  })

  it('trims whitespace and treats blank or unset as undefined', () => {
    expect(resolveBuildCommit({ CANONRY_COMMIT: '  abc1234  ' })).toBe('abc1234')
    expect(resolveBuildCommit({ CANONRY_COMMIT: '   ' })).toBeUndefined()
    expect(resolveBuildCommit({})).toBeUndefined()
  })
})

describe('resolveInstanceIdentity', () => {
  it('returns name and role when both env vars are set', () => {
    expect(
      resolveInstanceIdentity({ CANONRY_INSTANCE: 'gjelina-demo', CANONRY_INSTANCE_ROLE: 'client-demo' }),
    ).toEqual({ name: 'gjelina-demo', role: 'client-demo' })
  })

  it('omits role when CANONRY_INSTANCE_ROLE is unset or blank', () => {
    expect(resolveInstanceIdentity({ CANONRY_INSTANCE: 'agent-node' })).toEqual({ name: 'agent-node' })
    expect(resolveInstanceIdentity({ CANONRY_INSTANCE: ' agent-node ', CANONRY_INSTANCE_ROLE: ' ' })).toEqual({
      name: 'agent-node',
    })
  })

  it('is undefined when CANONRY_INSTANCE is unset or blank, even with a role', () => {
    expect(resolveInstanceIdentity({})).toBeUndefined()
    expect(resolveInstanceIdentity({ CANONRY_INSTANCE_ROLE: 'internal' })).toBeUndefined()
    expect(resolveInstanceIdentity({ CANONRY_INSTANCE: '', CANONRY_INSTANCE_ROLE: 'internal' })).toBeUndefined()
  })
})
