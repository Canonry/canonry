import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test.each([0, 1])('push reaches the remote only when verification succeeds (exit %i)', (verifyExit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-push-'))
  tempDirs.push(dir)
  const repo = path.join(dir, 'repo')
  const remote = path.join(dir, 'remote.git')
  const bin = path.join(dir, 'bin')
  const hooks = path.join(dir, 'hooks')
  for (const folder of [repo, bin, hooks]) fs.mkdirSync(folder)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(['init', '--initial-branch=main'])
  git(['init', '--bare', remote])
  git(['config', 'core.hooksPath', hooks])
  git(['-c', 'user.name=Hook Test', '-c', 'user.email=hook@example.com', 'commit', '--allow-empty', '-m', 'fixture'])
  const hook = fs.readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8')
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\n${hook}`, { mode: 0o755 })
  // Substitute only the expensive verifier; exercise a real Git push and hook.
  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh
pwd > gate-cwd
printf '%s\\n' "$*" >> gate-args
git init --quiet nested-repo || exit 90
git -C nested-repo -c user.name=Test -c user.email=test@example.com commit --quiet --allow-empty -m fixture || exit 91
echo 'verification output'
exit ${verifyExit}
`, { mode: 0o755 })

  const before = git(['rev-parse', 'HEAD'])
  const pushed = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
    cwd: repo,
    env: { ...env, GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo },
    encoding: 'utf8',
  })
  expect(fs.readFileSync(path.join(repo, 'gate-args'), 'utf8').trim()).toBe('verify')
  expect(fs.realpathSync(fs.readFileSync(path.join(repo, 'gate-cwd'), 'utf8').trim())).toBe(fs.realpathSync(repo))
  const remoteHead = git(['for-each-ref', '--format=%(objectname)', 'refs/heads/main'], remote)
  expect(pushed.status).toBe(verifyExit)
  expect(remoteHead).toBe(verifyExit === 0 ? git(['rev-parse', 'HEAD']) : '')
  expect(git(['rev-parse', 'HEAD'])).toBe(before)
  expect(fs.realpathSync(git(['rev-parse', '--show-toplevel'], path.join(repo, 'nested-repo')))).toBe(fs.realpathSync(path.join(repo, 'nested-repo')))
  const logs = fs.readdirSync(dir).filter((name) => name.startsWith('canonry-prepush-verify.'))
  expect(logs).toHaveLength(verifyExit === 0 ? 0 : 1)
  if (verifyExit !== 0) {
    expect(pushed.stderr).toContain('pnpm verify FAILED')
    expect(pushed.stderr).toContain('verification output')
    expect(fs.readFileSync(path.join(dir, logs[0]), 'utf8')).toContain('verification output')
  }
})
