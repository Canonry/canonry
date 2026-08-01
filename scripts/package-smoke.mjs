#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages', 'canonry')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-package-smoke-'))
const packDir = path.join(tempRoot, 'pack')
const scratchDir = path.join(tempRoot, 'scratch')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'an unknown status'}`)
  }
}

try {
  fs.mkdirSync(packDir)
  fs.mkdirSync(scratchDir)

  run(pnpm, ['--filter', '@canonry/canonry', 'build'], repoRoot)
  run(pnpm, ['pack', '--pack-destination', packDir], packageDir)

  const tarballs = fs.readdirSync(packDir).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed tarball, found ${tarballs.length}: ${tarballs.join(', ')}`)
  }

  const tarball = path.join(packDir, tarballs[0])
  run(npm, ['init', '--yes'], scratchDir)
  run(npm, ['install', tarball], scratchDir)

  const bin = path.join(
    scratchDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'canonry.cmd' : 'canonry',
  )
  run(bin, ['--version'], scratchDir)
} finally {
  fs.rmSync(tempRoot, { force: true, recursive: true })
}
