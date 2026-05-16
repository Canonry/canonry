import fs from 'node:fs'
import path from 'node:path'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
} from '@ainyc/canonry-contracts'
import type { CheckDefinition } from '../types.js'

const REQUIRED_SKILLS = ['canonry', 'aero'] as const

const skillsInstalledCheck: CheckDefinition = {
  id: 'agent.skills.installed',
  category: CheckCategories.agent,
  scope: CheckScopes.global,
  title: 'Agent skills installed (~/.claude/skills/)',
  run: () => {
    const home = process.env.HOME
    if (!home) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent.skills.no-home',
        summary: 'Cannot determine $HOME — skip skills filesystem check.',
        remediation: null,
      }
    }

    const skillsBase = path.join(home, '.claude', 'skills')
    const installed: string[] = []
    const missing: string[] = []
    for (const name of REQUIRED_SKILLS) {
      const dir = path.join(skillsBase, name)
      if (isInstalled(dir)) installed.push(name)
      else missing.push(name)
    }

    const details = {
      checkedPath: skillsBase,
      installed,
      missing,
    }

    if (missing.length === 0) {
      return {
        status: CheckStatuses.ok,
        code: 'agent.skills.installed',
        summary: `Both canonry and aero skills are installed in ${skillsBase}.`,
        remediation: null,
        details,
      }
    }

    if (installed.length === 0) {
      return {
        status: CheckStatuses.warn,
        code: 'agent.skills.not-installed',
        summary: 'Agent skills are not installed for Claude Code on this machine. Claude sessions on this host will not auto-load canonry/aero reference docs.',
        remediation: 'Run `canonry skills install --dir ~` (or `canonry skills install --user`) to install both skills to ~/.claude/skills/ and ~/.codex/skills/.',
        details,
      }
    }

    return {
      status: CheckStatuses.warn,
      code: 'agent.skills.partial',
      summary: `Only ${installed.length} of ${REQUIRED_SKILLS.length} agent skills are installed (${installed.join(', ')}); ${missing.join(', ')} missing.`,
      remediation: `Run \`canonry skills install ${missing.join(' ')} --dir ~\` to fill the gap.`,
      details,
    }
  },
}

function isInstalled(dir: string): boolean {
  try {
    // The directory must exist AND contain SKILL.md — guards against an empty
    // dir left over from a half-finished install.
    if (!fs.existsSync(dir)) return false
    return fs.existsSync(path.join(dir, 'SKILL.md'))
  } catch {
    return false
  }
}

export const AGENT_CHECKS: readonly CheckDefinition[] = [skillsInstalledCheck]
