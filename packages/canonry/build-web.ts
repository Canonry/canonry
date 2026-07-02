#!/usr/bin/env node

/**
 * Builds the web SPA (apps/web) and copies the output to packages/canonry/assets/.
 * This allows `canonry serve` to serve the dashboard as static files.
 *
 * Run from the repo root: pnpm --filter @canonry/canonry run build:web
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

// Preserve agent-workspace/ across SPA rebuild
const agentWorkspaceDir = path.join(assetsDir, 'agent-workspace')
const agentWorkspaceTmp = path.join(dirname, '.agent-workspace-tmp')
const hadAgentWorkspace = fs.existsSync(agentWorkspaceDir)
if (hadAgentWorkspace) {
  fs.cpSync(agentWorkspaceDir, agentWorkspaceTmp, { recursive: true })
}

// Remove old assets and copy fresh build
if (fs.existsSync(assetsDir)) {
  fs.rmSync(assetsDir, { recursive: true })
}

fs.cpSync(webDistDir, assetsDir, { recursive: true })

// Restore agent-workspace/
if (hadAgentWorkspace) {
  fs.cpSync(agentWorkspaceTmp, agentWorkspaceDir, { recursive: true })
  fs.rmSync(agentWorkspaceTmp, { recursive: true })
}

// Verify that all asset references in index.html resolve to existing files.
// Prevents white-screen outages from HTML referencing stale hashed filenames.
const indexPath = path.join(assetsDir, 'index.html')
const html = fs.readFileSync(indexPath, 'utf-8')
const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(m => m[1])
const missing = refs.filter(ref => !fs.existsSync(path.join(assetsDir, ref)))
if (missing.length > 0) {
  console.error('Error: index.html references assets that do not exist:')
  for (const ref of missing) console.error(`  - ${ref}`)
  console.error('The web build output and asset copy are out of sync. Rebuild from clean state.')
  process.exit(1)
}

console.log(`SPA assets copied to ${assetsDir} (${refs.length} references verified)`) 
