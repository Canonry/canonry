import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../scripts/lint-changed.mjs', import.meta.url))
const hook = fs.readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8')
const repoConfig = fileURLToPath(new URL('../.oxlintrc.json', import.meta.url))
const repoRules = fileURLToPath(new URL('../eslint-rules', import.meta.url))
const tempDirs: string[] = []
// The full-lint fallback launches pnpm and a type-aware oxlint run. Allow CPU
// contention on CI runners without imposing a hook performance assertion.
const fullLintTimeout = 20_000

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const noDebugger = (severity: string) => JSON.stringify({ categories: { correctness: 'off' }, rules: { 'no-debugger': severity } })

interface FixtureOptions {
  files?: Record<string, string>
  /** Link the workspace's custom rules in, for the real repository config. */
  linkRepoRules?: boolean
}

function fixture(config = noDebugger('error'), { files = {}, linkRepoRules = false }: FixtureOptions = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-lint-'))
  tempDirs.push(cwd)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), content)
  }
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Hook Test')
  git('config', 'user.email', 'hook@example.com')
  write('.oxlintrc.json', config)
  write('tracked.js', 'export const value = 1\n')
  write('deleted.js', 'debugger\n')
  write('README.md', 'fixture\n')
  write('.gitignore', `.tmp/\nhooks/\nscripts/\nnode_modules\n${linkRepoRules ? 'eslint-rules\n' : ''}`)
  write('package.json', JSON.stringify({ type: 'module', scripts: { lint: 'oxlint --type-aware .' } }))
  for (const [file, content] of Object.entries(files)) write(file, content)
  git('add', '.')
  git('commit', '--no-verify', '-m', 'test: fixture')
  write('hooks/pre-commit', `#!/bin/sh\n${hook}`)
  fs.chmodSync(path.join(cwd, 'hooks/pre-commit'), 0o755)
  fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.symlinkSync(script, path.join(cwd, 'scripts/lint-changed.mjs'))
  fs.symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(cwd, 'node_modules'))
  if (linkRepoRules) fs.symlinkSync(repoRules, path.join(cwd, 'eslint-rules'))
  git('config', 'core.hooksPath', path.join(cwd, 'hooks'))
  const lint = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' })
  const commit = (...args: string[]) => spawnSync('git', ['commit', '-m', 'test: changed files', ...args], { cwd, env, encoding: 'utf8' })
  return { cwd, env, git, write, lint, commit }
}

test('documentation commits skip the linter and ignore unrelated broken working files', () => {
  // A config oxlint cannot parse: the commit only succeeds if the linter never starts.
  const f = fixture('{ "rules": { not json')
  f.write('README.md', 'changed docs\n')
  f.write('tracked.js', 'debugger\n')
  f.git('add', 'README.md')
  const result = f.commit()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout + result.stderr).not.toContain('lint: checking')
  expect(fs.readFileSync(path.join(f.cwd, 'tracked.js'), 'utf8')).toBe('debugger\n')
})

test('a clean staged blob commits even when the working content has a lint error', () => {
  const f = fixture()
  const staged = 'export const value = 2\n'
  f.write('tracked.js', staged)
  f.git('add', 'tracked.js')
  f.write('tracked.js', 'debugger\n')
  const result = f.commit()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(f.git('show', 'HEAD:tracked.js')).toBe(staged.trim())
  expect(fs.readFileSync(path.join(f.cwd, 'tracked.js'), 'utf8')).toBe('debugger\n')
})

test('a staged lint error blocks a commit even when the working content is clean, without changing either', () => {
  const f = fixture()
  f.write('tracked.js', 'debugger\n')
  f.git('add', 'tracked.js')
  f.write('tracked.js', 'export const value = 2\n')
  const before = [f.git('rev-parse', 'HEAD'), f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]
  const result = f.commit()
  expect(result.status).not.toBe(0)
  expect(result.stdout + result.stderr).toContain('no-debugger')
  expect([f.git('rev-parse', 'HEAD'), f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]).toEqual(before)
})

test('staged lint handles renames and unusual paths while skipping deletions and symlinks', () => {
  const f = fixture()
  const renamed = 'renamed [file]\nname.js'
  f.git('mv', 'tracked.js', renamed)
  f.git('rm', 'deleted.js')
  fs.symlinkSync('/file-that-must-not-be-read', path.join(f.cwd, 'link.js'))
  f.git('add', 'link.js')
  const result = f.lint('--staged')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('passed (1 files,')
  f.write(renamed, 'debugger\n')
  f.git('add', renamed)
  expect(f.lint('--staged').status).toBe(1)
})

test('git commit --only uses its alternate index and leaves unrelated staged errors alone', () => {
  const f = fixture()
  f.write('other.js', 'debugger\n')
  f.git('add', 'other.js')
  f.write('tracked.js', 'export const value = 2\n')
  const result = f.commit('--only', 'tracked.js')
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(f.git('diff', '--cached', '--name-only')).toBe('other.js')
  expect(f.git('show', ':other.js')).toBe('debugger')
})

test('changed-file lint covers untracked and working content', () => {
  const f = fixture()
  f.write('tracked.js', 'export const value = 2\n')
  f.write('untracked [file].js', 'export const value = 3\n')
  const first = f.lint()
  expect(first.status, first.stderr).toBe(0)
  expect(first.stdout).toContain('passed (2 files,')
  f.write('untracked [file].js', 'debugger\n')
  const result = f.lint()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('no-debugger')
  expect(f.git('diff', '--cached', '--name-only')).toBe('')
})

test('fast lint keeps repository guards and syntax rules without requiring a TypeScript project', () => {
  const f = fixture(fs.readFileSync(repoConfig, 'utf8'), { linkRepoRules: true })
  const file = 'apps/web/src/example.ts'
  // The full lint command flags floating promises. Fast lint needs no tsconfig.
  f.write(file, 'Promise.resolve(1)\n')
  f.git('add', file)
  const valid = f.lint('--staged')
  expect(valid.status, valid.stdout + valid.stderr).toBe(0)
  f.write(file, "export const request = () => fetch('https://example.com')\n")
  f.git('add', file)
  const guarded = f.lint('--staged')
  expect(guarded.status).toBe(1)
  expect(guarded.stdout).toContain('canonry-guards(no-raw-http-web)')
})

test('ignored generated files do not block fast lint', () => {
  const f = fixture(fs.readFileSync(repoConfig, 'utf8'), { linkRepoRules: true })
  f.write('packages/api-client-generated/src/generated/example.ts', 'this is invalid syntax !\n')
  f.git('add', 'packages/api-client-generated/src/generated/example.ts')
  const result = f.lint('--staged')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('passed (0 files,')
})

test.each([false, true])('config ratchets inspect unchanged files with staged=%s', (staged) => {
  const f = fixture(noDebugger('off'))
  f.write('.oxlintrc.json', noDebugger('error'))
  f.git('add', '.oxlintrc.json')
  const result = f.lint(...(staged ? ['--staged'] : []))
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('full repository type-aware lint')
  expect(result.stdout).toContain('deleted.js')
  expect(result.stdout).toContain('no-debugger')
}, fullLintTimeout)

test('a custom rule edit checks unchanged files', () => {
  const plugin = (create: string) => `export default { meta: { name: 'local' }, rules: { custom: { create${create} } } }\n`
  const config = JSON.stringify({ categories: { correctness: 'off' }, jsPlugins: ['./eslint-rules/custom.mjs'], rules: { 'local/custom': 'error' } })
  const f = fixture(config, { files: { 'eslint-rules/custom.mjs': plugin('() { return {} }') } })
  f.write('eslint-rules/custom.mjs', plugin("(context) { return { Program(node) { context.report({ node, message: 'Updated guard' }) } } }"))
  f.git('add', 'eslint-rules')
  const result = f.lint('--staged')
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('tracked.js')
  expect(result.stdout).toContain('Updated guard')
}, fullLintTimeout)

test('the full fallback enables type-aware rules', () => {
  const config = (severity: string) => JSON.stringify({ categories: { correctness: 'off' }, plugins: ['typescript'], rules: { 'typescript/no-floating-promises': severity } })
  const f = fixture(config('off'), {
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['*.ts'] }),
      'unchanged.ts': 'Promise.resolve(1)\n',
    },
  })
  f.write('.oxlintrc.json', config('error'))
  f.git('add', '.oxlintrc.json')
  const result = f.lint('--staged')
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('unchanged.ts')
  expect(result.stdout).toContain('no-floating-promises')
}, fullLintTimeout)

test('partially staged config or source cannot produce a false green in full lint', () => {
  const f = fixture(noDebugger('off'))
  f.write('.oxlintrc.json', noDebugger('error'))
  f.git('add', '.oxlintrc.json')
  f.write('.oxlintrc.json', noDebugger('off'))
  expect(f.lint('--staged').stderr).toContain('match the Git index')
  f.git('restore', '.oxlintrc.json')
  f.write('deleted.js', 'export const fixed = true\n')
  const before = [f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]
  expect(f.lint('--staged').status).toBe(1)
  expect([f.git('diff', '--binary'), f.git('diff', '--cached', '--binary')]).toEqual(before)
}, fullLintTimeout)

test('warnings are reported without failing the check', () => {
  const f = fixture(noDebugger('warn'))
  f.write('tracked.js', 'debugger\n')
  const result = f.lint()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('no-debugger')
  expect(result.stdout).toContain('passed (1 files,')
})
