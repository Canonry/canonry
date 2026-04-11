/**
 * Build-time script: copy agent workspace assets from repo-root skills/
 * into packages/canonry/assets/agent-workspace/skills/ so they ship in
 * the published npm package.
 *
 * Follows DenchClaw's syncManagedSkills() pattern — idempotent (rm + copy).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(pkgRoot, '../..')
const targetDir = path.join(pkgRoot, 'assets', 'agent-workspace', 'skills')

const MANAGED_SKILLS = ['aero', 'canonry-setup']

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

for (const skill of MANAGED_SKILLS) {
  const src = path.join(repoRoot, 'skills', skill)
  const dest = path.join(targetDir, skill)

  if (!fs.existsSync(src)) {
    console.warn(`⚠ skills/${skill}/ not found at ${src}, skipping`)
    continue
  }

  // Idempotent: rm + copy (DenchClaw pattern)
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
  }

  copyDirRecursive(src, dest)
  console.log(`✓ skills/${skill}/ → assets/agent-workspace/skills/${skill}/`)
}
