import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runArtifactTask } from '../scripts/artifact-cache.js'
import { assertGeneratedFilesIncluded } from '../scripts/generated-git-check.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-generated-git-'))
  dirs.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  const outputDir = path.join(cwd, 'generated')
  fs.mkdirSync(outputDir)
  fs.writeFileSync(path.join(outputDir, 'sdk.ts'), 'old')
  fs.writeFileSync(path.join(cwd, '.gitignore'), '*.ignored.ts\ncache.json\n')
  git('add', '.')
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: initial output')
  return { cwd, outputDir, git }
}

test('cached generation cannot hide output omitted from the index or HEAD', async () => {
  const f = fixture()
  const options = {
    inputHash: 'new API', outputDir: f.outputDir, cacheFile: path.join(f.cwd, 'cache.json'),
    generate: async (dir: string) => { fs.writeFileSync(path.join(dir, 'sdk.ts'), 'new') },
  }
  await runArtifactTask(options)
  expect((await runArtifactTask({ ...options, check: true })).cached).toBe(true)
  const state = [f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).toThrow('Git index')
  expect([f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]).toEqual(state)
  f.git('add', 'generated')
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).not.toThrow()
  expect(() => assertGeneratedFilesIncluded(f.outputDir, true)).toThrow('HEAD')
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: include output')
  expect(() => assertGeneratedFilesIncluded(f.outputDir, true)).not.toThrow()
})

test('new, deleted, ignored, and partially staged generated files cannot pass unnoticed', () => {
  const f = fixture()
  const added = path.join(f.outputDir, 'new [file]\nname.ts')
  fs.writeFileSync(added, 'new')
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).toThrow('new [file]\nname.ts')
  f.git('add', 'generated')
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).not.toThrow()
  fs.writeFileSync(added, 'unstaged update')
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).toThrow('Git index')
  f.git('add', 'generated')
  fs.unlinkSync(path.join(f.outputDir, 'sdk.ts'))
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).toThrow('sdk.ts')
  f.git('add', 'generated')
  fs.writeFileSync(path.join(f.outputDir, 'extra.ignored.ts'), 'ignored')
  expect(() => assertGeneratedFilesIncluded(f.outputDir)).toThrow('extra.ignored.ts')
})
