#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages/canonry')
const manifestPath = path.join(packageDir, 'package.json')
const originalManifestText = fs.readFileSync(manifestPath, 'utf8')
const originalManifest = JSON.parse(originalManifestText)
const packageNames = ['@canonry/canonry', '@ainyc/canonry']
const dryRun = process.env.CANONRY_NPM_PUBLISH_DRY_RUN === '1'
const publishTarball = process.env.CANONRY_NPM_PUBLISH_TARBALL

if (originalManifest.name !== packageNames[0]) {
  throw new Error(`Expected packages/canonry/package.json name to be ${packageNames[0]}, got ${originalManifest.name}`)
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

function writeManifestName(name) {
  const manifest = { ...originalManifest, name }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function run(command, args, cwd = repoRoot, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal})${capture ? `: ${result.stderr}` : ''}`)
  }
  return result.stdout
}

function prepareTarballs(tempDir, names) {
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

  const tarballs = new Map([[packageNames[0], publishTarball]])
  if (names.includes(packageNames[1])) {
    fs.writeFileSync(extractedManifestPath, `${JSON.stringify({ ...manifest, name: packageNames[1] }, null, 2)}\n`)
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tempDir], extractedDir, true))
    const filename = packed?.[0]?.filename
    if (!Array.isArray(packed) || packed.length !== 1 || typeof filename !== 'string' || path.basename(filename) !== filename || !filename.endsWith('.tgz')) {
      throw new Error('npm pack returned an invalid compatibility tarball')
    }
    const compatibilityTarball = path.join(tempDir, filename)
    if (!fs.statSync(compatibilityTarball).isFile()) throw new Error('npm pack did not create a compatibility tarball')
    tarballs.set(packageNames[1], compatibilityTarball)
  }
  return tarballs
}

function publish(name, tarball) {
  const command = tarball ? 'npm' : 'pnpm'
  const args = tarball
    ? ['publish', tarball, '--ignore-scripts', '--access', 'public']
    : ['publish', 'packages/canonry', '--no-git-checks', '--access', 'public']
  if (dryRun) args.push('--dry-run')

  console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name}@${originalManifest.version}`)
  run(command, args)
}

let tempDir
try {
  const pendingNames = packageNames.filter(name => {
    if (!dryRun && packageVersionExists(name, originalManifest.version)) {
      console.log(`${name}@${originalManifest.version} already exists on npm; skipping`)
      return false
    }
    return true
  })
  let tarballs
  if (publishTarball !== undefined && pendingNames.length > 0) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-npm-publish-'))
    tarballs = prepareTarballs(tempDir, pendingNames)
  }

  for (const name of pendingNames) {
    if (!tarballs) writeManifestName(name)
    publish(name, tarballs?.get(name))
  }
} finally {
  if (publishTarball === undefined) fs.writeFileSync(manifestPath, originalManifestText)
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
}
