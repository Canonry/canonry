import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../scripts/pre-push.mjs', import.meta.url))
const hook = fs.readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-push-test-'))
  dirs.push(cwd)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    PATH: `${path.join(cwd, '.tmp/bin')}${path.delimiter}${process.env.PATH}`,
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), value)
  }
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  write('.gitignore', '.tmp/\n')
  write('packages/api-routes/src/openapi.ts', 'old API')
  write('packages/api-client-generated/src/generated/sdk.ts', 'old SDK')
  write('README.md', 'docs')
  write('scripts/pre-push.mjs', fs.readFileSync(script, 'utf8'))
  write('.husky/pre-push', hook)
  git('add', '.')
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: fixture')
  const log = path.join(cwd, '.tmp/calls')
  write('.tmp/bin/pnpm', '#!/bin/sh\nprintf "%s\\n" "$*" >> .tmp/calls\n[ "$1" != "$FAIL_GATE" ]\n')
  fs.chmodSync(path.join(cwd, '.tmp/bin/pnpm'), 0o755)
  const update = (sha = git('rev-parse', 'HEAD')) => `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`
  const run = (input = update(), extraEnv = {}) => spawnSync('sh', ['.husky/pre-push'], { cwd, env: { ...env, ...extraEnv }, input, encoding: 'utf8' })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  return { cwd, git, write, update, run, calls }
}

test('push runs only the three drift gates and permits unrelated documentation WIP', () => {
  const f = fixture()
  f.write('README.md', 'unstaged docs')
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect(f.calls()).toEqual(['gen:check --committed', 'plugin:check', 'val:skills:check'])
  expect(f.git('diff', '--name-only')).toBe('README.md')
})

test.each(['gen:check', 'plugin:check', 'val:skills:check'])('a failed %s blocks the push and stops subsequent checks', (gate) => {
  const f = fixture()
  expect(f.run(undefined, { FAIL_GATE: gate }).status).toBe(1)
  expect(f.calls().at(-1)?.split(' ')[0]).toBe(gate)
})

test.each([false, true])('SDK fixes omitted from the pushed commit fail even when staged=%s', (staged) => {
  const f = fixture()
  f.write('packages/api-client-generated/src/generated/sdk.ts', 'regenerated SDK')
  if (staged) f.git('add', 'packages')
  const result = f.run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('differ from pushed commit')
  expect(f.calls()).toEqual([])
})

test('working API edits cannot mask a bad commit, and other pushed refs are checked', () => {
  const f = fixture()
  const original = f.git('rev-parse', 'HEAD')
  f.write('packages/api-routes/src/openapi.ts', 'new API')
  f.git('add', 'packages')
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: new API')
  f.write('packages/api-routes/src/openapi.ts', 'old API')
  expect(f.run().status).toBe(1)
  f.git('restore', 'packages')
  expect(f.run(f.update() + f.update(original)).status).toBe(1)
  expect(f.calls()).toEqual([])
})

test('deletion-only pushes skip gates and untracked inputs cannot hide in checks', () => {
  const f = fixture()
  expect(f.run(f.update('0'.repeat(40))).status).toBe(0)
  expect(f.calls()).toEqual([])
  f.write('skills/new/SKILL.md', 'uncommitted skill')
  expect(f.run().status).toBe(1)
  expect(f.calls()).toEqual([])
})
