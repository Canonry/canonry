#!/usr/bin/env node

/** Build or reuse the SPA, then copy changed assets into the publishable package. */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyWebAssets } from '../../scripts/web-assets.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dirname, '../..')
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--force')) throw new Error('Usage: build-web.ts [--force]')

execFileSync('pnpm', ['--filter', '@ainyc/canonry-web', 'build', ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
})

const count = copyWebAssets(path.join(repoRoot, 'apps/web/dist'), path.join(dirname, 'assets'))
console.log(`SPA assets ready (${count} references checked)`)
