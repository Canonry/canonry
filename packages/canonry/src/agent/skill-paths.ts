import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the on-disk directory that holds the Aero skill: SKILL.md, soul.md,
 * and the references/ subdirectory. Shared by the prompt loader and the
 * skill-doc tools.
 *
 * Search order reflects how canonry is packaged vs. run in-repo:
 *   prod : packages/canonry/dist/<flat bundle> → ../assets/agent-workspace/skills/aero/
 *   dev  : packages/canonry/src/agent/session.ts → ../../assets/agent-workspace/skills/aero/
 *   repo : packages/canonry/src/agent/session.ts → ../../../../skills/aero/
 */
export function resolveAeroSkillDir(pkgDir?: string): string {
  const here = pkgDir ?? path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, '../assets/agent-workspace/skills/aero'),
    path.join(here, '../../assets/agent-workspace/skills/aero'),
    path.join(here, '../../../../skills/aero'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate
  }
  throw new Error(`Aero skill not found. Searched:\n  ${candidates.join('\n  ')}`)
}
