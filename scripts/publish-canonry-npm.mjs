#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages/canonry')
const manifestPath = path.join(packageDir, 'package.json')
const originalManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const packageName = '@canonry/canonry'
const dryRun = process.env.CANONRY_NPM_PUBLISH_DRY_RUN === '1'
const publishTarball = process.env.CANONRY_NPM_PUBLISH_TARBALL

if (originalManifest.name !== packageName) {
  throw new Error(`Expected packages/canonry/package.json name to be ${packageName}, got ${originalManifest.name}`)
}

if (typeof originalManifest.version !== 'string' || originalManifest.version.length === 0) {
  throw new Error('packages/canonry/package.json is missing a version')
}

function packageVersionExists(name, version) {
  const spec = `${name}@${version}`
  const result = spawnSync('npm', ['view', spec, 'version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) throw result.error
  if (result.status === 0 && result.stdout.trim() === version) {
    return true
  }

  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0 && (output.includes('E404') || output.includes('404 Not Found'))) {
    return false
  }

  throw new Error(`Unable to check ${spec} on npm:\n${output.trim()}`)
}

function run(command, args, cwd = repoRoot, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    // BSD tar otherwise adds AppleDouble metadata files when repacking on macOS.
    env: command === 'tar' ? { ...process.env, COPYFILE_DISABLE: '1' } : process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal})${capture ? `: ${result.stderr}` : ''}`)
  }
  return result.stdout
}

function validateTarball(tempDir) {
  if (!path.isAbsolute(publishTarball) || !publishTarball.endsWith('.tgz') || !fs.statSync(publishTarball).isFile()) {
    throw new Error('CANONRY_NPM_PUBLISH_TARBALL must be an absolute path to a .tgz file')
  }
  const entries = run('tar', ['-tzf', publishTarball], repoRoot, true).trimEnd().split('\n')
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) {
    throw new Error('Publish tarball must contain only package/ entries')
  }
  const details = run('tar', ['-tvzf', publishTarball], repoRoot, true).trimEnd().split('\n')
  if (details.some(entry => !['-', 'd'].includes(entry[0]))) {
    throw new Error('Publish tarball must contain only regular files and directories')
  }
  run('tar', ['-xzf', publishTarball, '-C', tempDir])
  const extractedDir = path.join(tempDir, 'package')
  const extractedManifestPath = path.join(extractedDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(extractedManifestPath, 'utf8'))
  if (manifest.name !== originalManifest.name || manifest.version !== originalManifest.version) {
    throw new Error(`Publish tarball must contain ${originalManifest.name}@${originalManifest.version}; got ${manifest.name}@${manifest.version}`)
  }
}

function publish(tarball) {
  const command = tarball ? 'npm' : 'pnpm'
  const args = tarball
    ? ['publish', tarball, '--ignore-scripts', '--access', 'public']
    : ['publish', 'packages/canonry', '--no-git-checks', '--access', 'public']
  if (dryRun) args.push('--dry-run')

  console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${packageName}@${originalManifest.version}`)
  run(command, args)
}

let tempDir
try {
  if (!dryRun && packageVersionExists(packageName, originalManifest.version)) {
    console.log(`${packageName}@${originalManifest.version} already exists on npm; skipping`)
  } else {
    if (publishTarball !== undefined) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-npm-publish-'))
      validateTarball(tempDir)
    }
    publish(publishTarball)
  }
} finally {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
}
