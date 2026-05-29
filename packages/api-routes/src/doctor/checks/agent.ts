import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  SKILL_MANIFEST_FILENAME,
  classifySkillFile,
  coerceSkillManifest,
  type SkillManifest,
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

interface SkillDriftDetail {
  name: string
  installed: boolean
  /** Version recorded in the installed manifest, or null when there is none (legacy install). */
  installedVersion: string | null
  /** Bundled files not present in the install — net-new references awaiting an additive install. */
  missing: string[]
  /** Files the bundle updated that the operator never touched — safe to refresh. */
  stale: string[]
  /** Files diverging from both bundle and manifest — local edits, left alone. */
  edited: string[]
  /** True when an additive `canonry skills install` would add or refresh something. */
  behind: boolean
}

const skillsCurrentCheck: CheckDefinition = {
  id: 'agent.skills.current',
  category: CheckCategories.agent,
  scope: CheckScopes.global,
  title: 'Agent skills up to date (~/.claude/skills/)',
  run: (ctx) => {
    const bundled = ctx.bundledSkills
    if (!bundled || bundled.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent.skills.bundle-unavailable',
        summary: 'Bundled skill snapshot is not available in this deployment — cannot assess skill drift.',
        remediation: null,
      }
    }

    const home = process.env.HOME
    if (!home) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent.skills.no-home',
        summary: 'Cannot determine $HOME — skip skills staleness check.',
        remediation: null,
      }
    }

    const skillsBase = path.join(home, '.claude', 'skills')
    const bundledVersion = bundled[0]!.version
    const skills: SkillDriftDetail[] = bundled.map((snap) => {
      const skillDir = path.join(skillsBase, snap.name)
      if (!isInstalled(skillDir)) {
        return { name: snap.name, installed: false, installedVersion: null, missing: [], stale: [], edited: [], behind: false }
      }
      const manifest = readInstalledManifest(skillDir)
      const missing: string[] = []
      const stale: string[] = []
      const edited: string[] = []
      for (const [rel, bundledHash] of Object.entries(snap.files)) {
        const installedHash = hashInstalledFile(path.join(skillDir, rel))
        const state = classifySkillFile({ bundledHash, installedHash, manifestHash: manifest?.files[rel] })
        if (state === 'missing') missing.push(rel)
        else if (state === 'stale') stale.push(rel)
        else if (state === 'edited') edited.push(rel)
      }
      return {
        name: snap.name,
        installed: true,
        installedVersion: manifest?.version ?? null,
        missing,
        stale,
        edited,
        behind: missing.length > 0 || stale.length > 0,
      }
    })

    const details = { checkedPath: skillsBase, bundledVersion, skills }
    const installedSkills = skills.filter((s) => s.installed)

    if (installedSkills.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'agent.skills.none-installed',
        summary: 'No agent skills are installed under ~/.claude/skills/ — see agent.skills.installed.',
        remediation: null,
        details,
      }
    }

    const behind = installedSkills.filter((s) => s.behind)
    if (behind.length === 0) {
      return {
        status: CheckStatuses.ok,
        code: 'agent.skills.current',
        summary: `Installed agent skills are up to date with the bundled version (v${bundledVersion}).`,
        remediation: null,
        details,
      }
    }

    const newFiles = behind.reduce((n, s) => n + s.missing.length, 0)
    const updatedFiles = behind.reduce((n, s) => n + s.stale.length, 0)
    return {
      status: CheckStatuses.warn,
      code: 'agent.skills.behind',
      summary: `${behind.map((s) => s.name).join(', ')} ${behind.length === 1 ? 'is' : 'are'} behind the bundled skill version (v${bundledVersion}): ${newFiles} new file(s), ${updatedFiles} updated file(s) not yet installed.`,
      remediation: 'Run `canonry skills install --user` to additively refresh — new and upstream-updated files are copied; your local edits are preserved.',
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

/** sha256 hex of a file, or undefined when it is absent/unreadable (treated as missing). */
function hashInstalledFile(filePath: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return undefined
  }
}

function readInstalledManifest(skillDir: string): SkillManifest | null {
  try {
    return coerceSkillManifest(JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_MANIFEST_FILENAME), 'utf-8')))
  } catch {
    // Missing or malformed manifest — treat as a legacy install with no record.
    return null
  }
}

export const AGENT_CHECKS: readonly CheckDefinition[] = [skillsInstalledCheck, skillsCurrentCheck]
