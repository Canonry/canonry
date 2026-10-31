import fs from 'node:fs'
import path from 'node:path'
import { resolveAeroSkillDir } from '../agent/skill-paths.js'
import { CliError } from '../cli-error.js'
import { OPERATIONS_GUIDE } from './operations-guide.generated.js'

/**
 * Canonry's analyst playbooks for MCP hosts: the Aero skill and its
 * references, the files built-in Aero reads with `read_skill_doc`. They ship in
 * the package beside Aero, so a hosted connection gets them with no plugin,
 * skill, or CLI installed. SKILL.md is served as `aero`; each reference keeps
 * its file name.
 */
export const PLAYBOOK_SLUG = /^[a-z0-9-]{1,64}$/

const SKILL_SLUG = 'aero'
// Aero's copy of the guide opens with a preface for the built-in agent, which
// says its catalog has no canonry_help. MCP hosts get the public guide instead.
const GUIDE_SLUG = 'agent-operations'

/** Playbooks this install can serve; empty when the package has no Aero skill. */
export function availablePlaybooks(): string[] {
  const dir = aeroSkillDir()
  if (!dir) return []
  const references = path.join(dir, 'references')
  const slugs = fs.existsSync(references)
    ? fs.readdirSync(references)
      .filter(file => file.endsWith('.md'))
      .map(file => file.slice(0, -'.md'.length))
      .filter(slug => PLAYBOOK_SLUG.test(slug) && slug !== SKILL_SLUG)
      .sort()
    : []
  return [SKILL_SLUG, ...slugs]
}

export function readPlaybook(slug: string) {
  const playbooks = availablePlaybooks()
  const dir = aeroSkillDir()
  if (!dir || !playbooks.includes(slug)) {
    throw new CliError({
      code: 'NOT_FOUND',
      message: `No playbook "${slug}". Use a slug from availablePlaybooks.`,
      details: { availablePlaybooks: playbooks },
    })
  }
  const file = slug === SKILL_SLUG ? 'SKILL.md' : path.join('references', `${slug}.md`)
  const content = slug === GUIDE_SLUG ? OPERATIONS_GUIDE.markdown : fs.readFileSync(path.join(dir, file), 'utf8')
  return { playbook: slug, note: OPERATIONS_GUIDE.playbookNote, content, availablePlaybooks: playbooks }
}

function aeroSkillDir(): string | null {
  try {
    return resolveAeroSkillDir()
  } catch {
    return null
  }
}
