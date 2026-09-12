import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  jobs: Record<'typecheck' | 'test_shards', { steps: { name?: string; run?: string }[] }>
}
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ci-cache-'))
  tempDirs.push(dir)
  return dir
}

function runStep(name: string, cwd: string, job: 'typecheck' | 'test_shards' = 'typecheck', env = process.env) {
  const script = workflow.jobs[job].steps.find(step => step.name === name)?.run
  if (!script) throw new Error(`Missing CI step: ${name}`)
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env, stdio: 'pipe' })
}

test('CI archives workspace incremental state without walking dependencies and restores it into a fresh checkout', () => {
  const cwd = fixture()
  const files = [
    'packages/contracts/tsconfig.tsbuildinfo',
    'packages/integration-traffic/tsconfig.scripts.tsbuildinfo',
    'apps/web/tsconfig.tsbuildinfo',
    'scripts/tsconfig.tsbuildinfo',
    'test/tsconfig.tsbuildinfo',
  ]
  const ignored = [
    'node_modules/typescript/tsconfig.tsbuildinfo',
    'packages/contracts/node_modules/example/tsconfig.tsbuildinfo',
    'packages/contracts/src/index.ts',
  ]
  for (const file of [...files, ...ignored]) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), `contents of ${file}`)
  }
  runStep('Collect TypeScript incremental state', cwd)
  const archive = '.tmp/ci/tsbuildinfo.tar'
  const entries = execFileSync('tar', ['-tf', archive], { cwd, encoding: 'utf8' }).trim().split('\n')
  expect(entries.sort()).toEqual([...files].sort())

  const restored = fixture()
  fs.mkdirSync(path.join(restored, '.tmp/ci'), { recursive: true })
  fs.copyFileSync(path.join(cwd, archive), path.join(restored, archive))
  runStep('Unpack TypeScript incremental state', restored)
  for (const file of files) {
    expect(fs.readFileSync(path.join(restored, file), 'utf8')).toBe(`contents of ${file}`)
  }
  for (const file of ignored) expect(fs.existsSync(path.join(restored, file))).toBe(false)
})

test('CI accepts a cache miss and an empty incremental state', () => {
  const cwd = fixture()
  runStep('Unpack TypeScript incremental state', cwd)
  runStep('Collect TypeScript incremental state', cwd)
  expect(execFileSync('tar', ['-tf', '.tmp/ci/tsbuildinfo.tar'], { cwd, encoding: 'utf8' })).toBe('')
  runStep('Unpack TypeScript incremental state', cwd)
})

test('test compilation context reuses source edits but invalidates changed resolution inputs', () => {
  const cwd = fixture()
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git('init', '-q')
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), content)
    git('add', '--', file)
  }
  const key = () => {
    const output = path.join(cwd, 'output')
    fs.writeFileSync(output, '')
    runStep('Fingerprint test compilation context', cwd, 'test_shards', { ...process.env, GITHUB_OUTPUT: output })
    return fs.readFileSync(output, 'utf8')
  }
  write('src/value.ts', 'export const value = 1')
  write('packages/example/tsconfig.json', '{}')
  write('packages/example/package.json', '{}')
  write('pnpm-workspace.yaml', 'packages: []')
  const initial = key()
  expect(initial).toMatch(/^value=[a-f0-9]{64}\n$/)
  write('src/value.ts', 'export const value = 2')
  expect(key()).toBe(initial)

  for (const file of ['packages/example/tsconfig.json', 'packages/example/package.json', 'pnpm-workspace.yaml']) {
    const before = key()
    write(file, 'changed configuration')
    expect(key()).not.toBe(before)
  }
  const beforeAdd = key()
  write('src/value.js', 'export const value = 3')
  expect(key()).not.toBe(beforeAdd)
  git('rm', '-f', 'src/value.js')
  expect(key()).toBe(beforeAdd)
})
