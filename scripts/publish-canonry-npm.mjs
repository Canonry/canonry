#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(repoRoot, 'packages/canonry')
const manifestPath = path.join(packageDir, 'package.json')
const originalManifestText = fs.readFileSync(manifestPath, 'utf8')
const originalManifest = JSON.parse(originalManifestText)
const packageNames = ['@canonry/canonry', '@ainyc/canonry']
const dryRun = process.env.CANONRY_NPM_PUBLISH_DRY_RUN === '1'

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

  if (result.status === 0 && result.stdout.trim() === version) {
    return true
  }

  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0 && (output.includes('E404') || output.includes('404 Not Found'))) {
    return false
  }

  if (result.error) throw result.error
  throw new Error(`Unable to check ${spec} on npm:\n${output.trim()}`)
}

function writeManifestName(name) {
  const manifest = { ...originalManifest, name }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function publishCurrentManifest(name) {
  const args = ['publish', 'packages/canonry', '--no-git-checks', '--access', 'public']
  if (dryRun) args.push('--dry-run')

  console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name}@${originalManifest.version}`)
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

try {
  for (const name of packageNames) {
    if (!dryRun && packageVersionExists(name, originalManifest.version)) {
      console.log(`${name}@${originalManifest.version} already exists on npm; skipping`)
      continue
    }

    writeManifestName(name)
    publishCurrentManifest(name)
  }
} finally {
  fs.writeFileSync(manifestPath, originalManifestText)
}
