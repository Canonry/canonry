import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../scripts/lint-changed.mjs', import.meta.url))
const hook = fs.readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8')
const repoConfig = fileURLToPath(new URL('../eslint.config.js', import.meta.url))
const tempDirs: string[] = []
// Cache scenarios launch several real Git/ESLint processes. Allow CPU
// contention on CI runners without imposing a hook performance assertion.
const cacheScenarioTimeout = 20_000

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(config = "export default [{ files: ['**/*.js'], rules: { 'no-debugger': 'error' } }]\n") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-lint-'))
  tempDirs.push(cwd)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    CANONRY_LINT_CACHE_DIR: path.join(cwd, '.tmp', 'cache'),
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), content)
  }
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Hook Test')
  git('config', 'user.email', 'hook@example.com')
  write('eslint.config.mjs', config)
  write('tracked.js', 'export const value = 1\n')
  write('deleted.js', 'debugger\n')
  write('README.md', 'fixture\n')
  write('.gitignore', '.tmp/\nhooks/\nscripts/\n')
  git('add', '.')
  git('commit', '--no-verify', '-m', 'test: fixture')
  write('hooks/pre-commit', `#!/bin/sh\n${hook}`)
  fs.chmodSync(path.join(cwd, 'hooks/pre-commit'), 0o755)
  fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.symlinkSync(script, path.join(cwd, 'scripts/lint-changed.mjs'))
  git('config', 'core.hooksPath', path.join(cwd, 'hooks'))
  const lint = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' })
  const commit = (...args: string[]) => spawnSync('git', ['commit', '-m', 'test: changed files', ...args], { cwd, env, encoding: 'utf8' })
  return { cwd, env, git, write, lint, commit }
}

test('documentation commits skip ESLint and ignore unrelated broken working files', () => {
  const f = fixture("throw new Error('ESLint must not load for documentation')\n")
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

test('changed-file lint covers untracked and working content and invalidates cached results by content', () => {
  const f = fixture()
  f.write('tracked.js', 'export const value = 2\n')
  f.write('untracked [file].js', 'export const value = 3\n')
  const first = f.lint()
  expect(first.status, first.stderr).toBe(0)
  expect(first.stdout).toContain('passed (2 files,')
  const file = path.join(f.cwd, 'untracked [file].js')
  const before = fs.statSync(file)
  f.write('untracked [file].js', 'debugger\n')
  fs.utimesSync(file, before.atime, before.mtime)
  const result = f.lint()
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('no-debugger')
  expect(f.git('diff', '--cached', '--name-only')).toBe('')
})

test('fast lint keeps repository guards and syntax rules without requiring a TypeScript project', () => {
  const f = fixture(`export { default } from ${JSON.stringify(pathToFileURL(repoConfig).href)}\n`)
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
  expect(guarded.stdout).toContain('canonry-guards/no-raw-http-web')
})

test('ignored generated files do not block fast lint', () => {
  const f = fixture(`export { default } from ${JSON.stringify(pathToFileURL(repoConfig).href)}\n`)
  f.write('packages/api-client-generated/src/generated/example.ts', 'this is invalid syntax !\n')
  f.git('add', 'packages/api-client-generated/src/generated/example.ts')
  const result = f.lint('--staged')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('passed (0 files,')
})

test('worktrees share clean content across staged and working checks, with concurrent writers', async () => {
  const f = fixture("export default [{ files: ['**/*.js'], languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } }, rules: { 'no-debugger': 'error' } }]\n")
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-lint-worktree-'))
  tempDirs.push(parent)
  const other = path.join(parent, 'checkout')
  f.git('worktree', 'add', '--detach', other, 'HEAD')
  for (const cwd of [f.cwd, other]) {
    fs.writeFileSync(path.join(cwd, 'tracked.js'), 'export const value = 2\n')
    fs.writeFileSync(path.join(cwd, 'other.js'), 'export const other = 3\n')
  }
  const exec = promisify(execFile)
  // Both processes can publish identical entries at the same time.
  await Promise.all([f.cwd, other].map(cwd => exec(process.execPath, [script], { cwd, env: f.env })))
  for (const cwd of [f.cwd, other]) {
    const warm = await exec(process.execPath, [script], { cwd, env: f.env })
    expect(warm.stdout).toContain('2 cached')
  }
  execFileSync('git', ['add', 'tracked.js'], { cwd: other, env: f.env })
  fs.writeFileSync(path.join(other, 'tracked.js'), 'debugger\n')
  const staged = await exec(process.execPath, [script, '--staged'], { cwd: other, env: f.env })
  expect(staged.stdout).toContain('1 cached')
  const changed = spawnSync(process.execPath, [script], { cwd: other, env: f.env, encoding: 'utf8' })
  expect(changed.status).toBe(1)
  expect(changed.stdout).toContain('no-debugger')
  // A different path cannot inherit a clean result from the same source text.
  f.write('different.js', 'export const value = 2\n')
  expect(f.lint().stdout).toContain('3 files, 2 cached')
}, cacheScenarioTimeout)

test('configuration, lockfile, and local rule edits invalidate clean results', () => {
  const f = fixture("import rule from './eslint-rules/custom.mjs'\nexport default [{ files: ['**/*.js'], plugins: { local: { rules: { custom: rule } } }, rules: { 'local/custom': 'error' } }]\n")
  f.write('eslint-rules/custom.mjs', 'export default { create() { return {} } }\n')
  f.write('tracked.js', 'export const value = 2\n')
  f.git('add', 'tracked.js')
  expect(f.lint('--staged').stdout).toContain('0 cached')
  expect(f.lint('--staged').stdout).toContain('1 cached')
  f.write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  expect(f.lint('--staged').stdout).toContain('0 cached')
  expect(f.lint('--staged').stdout).toContain('1 cached')
  fs.appendFileSync(path.join(f.cwd, 'eslint.config.mjs'), '// config revision\n')
  expect(f.lint('--staged').stdout).toContain('0 cached')
  expect(f.lint('--staged').stdout).toContain('1 cached')
  // Plugin serialization is unchanged, but its implementation is different.
  f.write('eslint-rules/custom.mjs', "export default { create(context) { return { Program(node) { context.report({ node, message: 'Updated guard' }) } } } }\n")
  const updated = f.lint('--staged')
  expect(updated.status).toBe(1)
  expect(updated.stdout).toContain('Updated guard')
}, cacheScenarioTimeout)

test('effective configuration changes invalidate results without a config file edit', () => {
  const f = fixture("export default [{ files: ['**/*.js'], rules: { 'no-debugger': process.env.LINT_TEST_STRICT === '1' ? 'error' : 'off' } }]\n")
  f.write('tracked.js', 'debugger\n')
  f.git('add', 'tracked.js')
  expect(f.lint('--staged').status).toBe(0)
  expect(f.lint('--staged').stdout).toContain('1 cached')
  const strict = spawnSync(process.execPath, [script, '--staged'], {
    cwd: f.cwd, env: { ...f.env, LINT_TEST_STRICT: '1' }, encoding: 'utf8',
  })
  expect(strict.status).toBe(1)
  expect(strict.stdout).toContain('no-debugger')
})

test('cache bypass, corrupt entries, and unavailable storage still run the linter', () => {
  const f = fixture()
  f.write('tracked.js', 'export const value = 2\n')
  expect(f.lint().status).toBe(0)
  expect(f.lint().stdout).toContain('1 cached')
  expect(f.lint('--no-cache').stdout).toContain('0 cached')
  expect(f.lint().stdout).toContain('1 cached')
  for (const file of fs.readdirSync(f.env.CANONRY_LINT_CACHE_DIR, { recursive: true, withFileTypes: true })) {
    if (file.isFile()) fs.writeFileSync(path.join(file.parentPath, file.name), 'partial cache entry')
  }
  expect(f.lint().stdout).toContain('0 cached')
  expect(f.lint().stdout).toContain('1 cached')
  const env = { ...f.env, CANONRY_LINT_CACHE_DIR: path.join(f.cwd, 'README.md') }
  expect(spawnSync(process.execPath, [script], { cwd: f.cwd, env }).status).toBe(0)
  f.write('tracked.js', 'debugger\n')
  const broken = spawnSync(process.execPath, [script], { cwd: f.cwd, env, encoding: 'utf8' })
  expect(broken.status).toBe(1)
  expect(broken.stdout).toContain('no-debugger')
}, cacheScenarioTimeout)

test('cached runs retain warning diagnostics', () => {
  const f = fixture("export default [{ files: ['**/*.js'], rules: { 'no-debugger': 'warn' } }]\n")
  f.write('tracked.js', 'debugger\n')
  for (let i = 0; i < 2; i++) {
    const result = f.lint()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no-debugger')
    expect(result.stdout).toContain('0 cached')
  }
})
