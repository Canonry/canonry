#!/usr/bin/env node

/**
 * Builds the web SPA (apps/web) and copies the output to packages/canonry/assets/.
 * This allows `canonry serve` to serve the dashboard as static files.
 *
 * Run from the repo root: pnpm --filter @ainyc/canonry run build:web
 * Or directly: tsx packages/canonry/build-web.ts
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dirname, '../..')
const webDistDir = path.join(repoRoot, 'apps/web/dist')
const assetsDir = path.join(dirname, 'assets')

console.log('Building web SPA...')
execSync('pnpm --filter @ainyc/canonry-web build', {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (!fs.existsSync(webDistDir)) {
  console.error('Error: apps/web/dist not found after build.')
  process.exit(1)
}

// Remove old assets and copy fresh build
if (fs.existsSync(assetsDir)) {
  fs.rmSync(assetsDir, { recursive: true })
}

fs.cpSync(webDistDir, assetsDir, { recursive: true })

console.log(`SPA assets copied to ${assetsDir}`)
