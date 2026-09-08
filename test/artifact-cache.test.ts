import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { fingerprint, runArtifactTask, snapshotDirectory } from '../scripts/artifact-cache.js'
import { copyWebAssets } from '../scripts/web-assets.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-artifact-test-'))
  tempDirs.push(dir)
  const outputDir = path.join(dir, 'dist')
  const cacheFile = path.join(dir, 'cache.json')
  const write = (root: string, file: string, content: string) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return { dir, outputDir, cacheFile, write }
}

test('fingerprints detect content, file additions/deletions, missing inputs, and environment changes', () => {
  const f = fixture()
  const source = path.join(f.dir, 'src')
  const inputs = [source, path.join(f.dir, '.env')]
  f.write(source, 'one.ts', 'one')
  const initial = fingerprint(inputs, { VITE_MODE: 'a' })
  const stat = fs.statSync(path.join(source, 'one.ts'))
  f.write(source, 'one.ts', 'two')
  fs.utimesSync(path.join(source, 'one.ts'), stat.atime, stat.mtime)
  expect(fingerprint(inputs, { VITE_MODE: 'a' })).not.toBe(initial)
  f.write(source, 'one.ts', 'one')
  expect(fingerprint(inputs, { VITE_MODE: 'a' })).toBe(initial)
  f.write(source, 'two.ts', 'two')
  expect(fingerprint(inputs, { VITE_MODE: 'a' })).not.toBe(initial)
  fs.unlinkSync(path.join(source, 'two.ts'))
  expect(fingerprint(inputs, { VITE_MODE: 'a' })).toBe(initial)
  expect(fingerprint(inputs, { VITE_MODE: 'b' })).not.toBe(initial)
  f.write(f.dir, '.env', 'VITE_FLAG=1')
  expect(fingerprint(inputs, { VITE_MODE: 'a' })).not.toBe(initial)
})

test('check mode preserves output bytes and mtimes, then skips unchanged generation', async () => {
  const f = fixture()
  f.write(f.outputDir, 'sdk.ts', 'export const value = 1\n')
  fs.utimesSync(path.join(f.outputDir, 'sdk.ts'), 1000, 1000)
  const before = fs.statSync(path.join(f.outputDir, 'sdk.ts')).mtimeMs
  const generate = vi.fn(async (dir: string) => { f.write(dir, 'sdk.ts', 'export const value = 1\n') })
  const options = { ...f, inputHash: 'inputs', check: true, generate }
  expect((await runArtifactTask(options)).cached).toBe(false)
  expect((await runArtifactTask(options)).cached).toBe(true)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(fs.statSync(path.join(f.outputDir, 'sdk.ts')).mtimeMs).toBe(before)
  expect(snapshotDirectory(f.outputDir)).toEqual({ 'sdk.ts': expect.any(String) })
})

test('check mode detects edited, extra, and missing output despite a successful cache entry', async () => {
  const f = fixture()
  const generate = vi.fn(async (dir: string) => { f.write(dir, 'sdk.ts', 'expected') })
  const options = { ...f, inputHash: 'inputs', generate }
  await runArtifactTask(options)
  f.write(f.outputDir, 'sdk.ts', 'manual edit')
  f.write(f.outputDir, 'extra.ts', 'extra')
  const before = snapshotDirectory(f.outputDir)
  await expect(runArtifactTask({ ...options, check: true })).rejects.toThrow('Generated output differs')
  expect(snapshotDirectory(f.outputDir)).toEqual(before)
  fs.unlinkSync(path.join(f.outputDir, 'sdk.ts'))
  await expect(runArtifactTask({ ...options, check: true })).rejects.toThrow('sdk.ts')
  expect(fs.existsSync(path.join(f.outputDir, 'sdk.ts'))).toBe(false)
  expect(generate).toHaveBeenCalledTimes(3)
})

test('generation updates changed files, removes stale files, and preserves identical output', async () => {
  const f = fixture()
  f.write(f.outputDir, 'same.ts', 'same')
  f.write(f.outputDir, 'changed.ts', 'old')
  f.write(f.outputDir, 'stale.ts', 'stale')
  fs.utimesSync(path.join(f.outputDir, 'same.ts'), 1000, 1000)
  const generate = async (dir: string) => {
    f.write(dir, 'same.ts', 'same')
    f.write(dir, 'changed.ts', 'new')
  }
  const result = await runArtifactTask({ ...f, inputHash: 'inputs', generate })
  expect(result.changedFiles).toEqual(['changed.ts', 'stale.ts'])
  expect(fs.statSync(path.join(f.outputDir, 'same.ts')).mtimeMs).toBe(1_000_000)
  expect(fs.readFileSync(path.join(f.outputDir, 'changed.ts'), 'utf8')).toBe('new')
  expect(fs.existsSync(path.join(f.outputDir, 'stale.ts'))).toBe(false)
})

test('check mode detects output changed while the generator runs', async () => {
  const f = fixture()
  f.write(f.outputDir, 'sdk.ts', 'expected')
  await expect(runArtifactTask({
    ...f,
    inputHash: 'inputs',
    check: true,
    generate: async (dir) => {
      f.write(dir, 'sdk.ts', 'expected')
      f.write(f.outputDir, 'sdk.ts', 'concurrent edit')
    },
  })).rejects.toThrow('sdk.ts')
  expect(fs.readFileSync(path.join(f.outputDir, 'sdk.ts'), 'utf8')).toBe('concurrent edit')
})

test('build cache invalidates on new inputs, corrupt state, missing artifacts, and explicit force', async () => {
  const f = fixture()
  const generate = vi.fn(async (dir: string) => { f.write(dir, 'index.html', 'built') })
  const options = { ...f, inputHash: 'one', generate }
  await runArtifactTask(options)
  await runArtifactTask(options)
  expect(generate).toHaveBeenCalledTimes(1)
  await runArtifactTask({ ...options, inputHash: 'two' })
  fs.writeFileSync(f.cacheFile, 'invalid json')
  await runArtifactTask(options)
  fs.unlinkSync(path.join(f.outputDir, 'index.html'))
  await runArtifactTask(options)
  await runArtifactTask({ ...options, force: true })
  expect(generate).toHaveBeenCalledTimes(5)
})

test('generator failure preserves existing output and removes temporary files', async () => {
  const f = fixture()
  f.write(f.outputDir, 'index.html', 'working build')
  let temporaryOutput = ''
  await expect(runArtifactTask({
    ...f,
    inputHash: 'inputs',
    generate: async (dir) => {
      temporaryOutput = dir
      f.write(dir, 'partial.js', 'incomplete')
      throw new Error('build failed')
    },
  })).rejects.toThrow('build failed')
  expect(fs.readFileSync(path.join(f.outputDir, 'index.html'), 'utf8')).toBe('working build')
  expect(fs.existsSync(path.dirname(temporaryOutput))).toBe(false)
  expect(fs.existsSync(f.cacheFile)).toBe(false)
})

test('SPA copies retain agent assets, remove old chunks, and leave matching files untouched', () => {
  const f = fixture()
  const source = path.join(f.dir, 'web-dist')
  f.write(source, 'index.html', '<script src="./assets/new.js"></script>')
  f.write(source, 'assets/new.js', 'new')
  f.write(f.outputDir, 'assets/old.js', 'old')
  f.write(f.outputDir, 'agent-workspace/skills/canonry/SKILL.md', 'operator skill')
  expect(copyWebAssets(source, f.outputDir)).toBe(1)
  const html = path.join(f.outputDir, 'index.html')
  fs.utimesSync(html, 1000, 1000)
  copyWebAssets(source, f.outputDir)
  expect(fs.statSync(html).mtimeMs).toBe(1_000_000)
  expect(fs.existsSync(path.join(f.outputDir, 'assets/old.js'))).toBe(false)
  expect(fs.readFileSync(path.join(f.outputDir, 'agent-workspace/skills/canonry/SKILL.md'), 'utf8')).toBe('operator skill')
  f.write(source, 'index.html', '<script src="./assets/missing.js"></script>')
  const before = snapshotDirectory(f.outputDir)
  expect(() => copyWebAssets(source, f.outputDir)).toThrow('missing assets')
  expect(snapshotDirectory(f.outputDir)).toEqual(before)
})
