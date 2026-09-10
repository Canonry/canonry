import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface CanonrySkillFrontmatter {
  description?: unknown
}

describe('canonry skill metadata', () => {
  it('keeps connected MCP usable without a local runtime or installed skill', () => {
    const skillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const body = fs.readFileSync(skillPath, 'utf-8')
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(body)
    expect(frontmatterMatch).not.toBeNull()
    const frontmatter = parse(frontmatterMatch![1]!) as CanonrySkillFrontmatter
    expect(frontmatter.description).toContain('Use this optional host-native skill')
    expect(body).toContain('MCP is the universal entry')
    expect(body).toContain('Do not install a plugin, local runtime, or skill merely to use connected MCP.')
    expect(frontmatter.description).toContain('without installing a local runtime or skill')
  })

  it('keeps agent site-readiness guidance score-first and uses overview only for crawl metadata', () => {
    const canonrySkillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const canonryReferencePath = fileURLToPath(new URL('../../../skills/canonry/references/canonry-cli.md', import.meta.url))
    const aeroReferencePath = fileURLToPath(new URL('../../../skills/aero/references/orchestration.md', import.meta.url))
    const canonrySkill = fs.readFileSync(canonrySkillPath, 'utf-8')
    const canonryReference = fs.readFileSync(canonryReferencePath, 'utf-8')
    const aeroReference = fs.readFileSync(aeroReferencePath, 'utf-8')

    expect(canonrySkill).toContain('[CLI commands and JSON return shapes](references/canonry-cli.md)')
    expect(canonrySkill).toContain('[Server-side traffic setup and diagnosis](references/server-side-traffic.md)')
    expect(canonryReference).toContain('begin with `cnry technical-aeo score <project> --format json`')
    expect(canonryReference).toContain('only to add crawl metadata')
    expect(aeroReference).toContain('then `cnry technical-aeo score <project> --format json` for site readiness')
    expect(aeroReference).toContain('only to add crawl metadata')
  })

  it('keeps Cloudflare Queue pull discoverable from the shipped skills and command reference', () => {
    const canonrySkillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const aeroSkillPath = fileURLToPath(new URL('../../../skills/aero/SKILL.md', import.meta.url))
    const canonryReferencePath = fileURLToPath(new URL('../../../skills/canonry/references/canonry-cli.md', import.meta.url))
    const trafficReferencePath = fileURLToPath(new URL('../../../skills/canonry/references/server-side-traffic.md', import.meta.url))
    const canonrySkill = fs.readFileSync(canonrySkillPath, 'utf-8')
    const aeroSkill = fs.readFileSync(aeroSkillPath, 'utf-8')
    const canonryReference = fs.readFileSync(canonryReferencePath, 'utf-8')
    const trafficReference = fs.readFileSync(trafficReferencePath, 'utf-8')

    expect(canonrySkill).toContain('[Server-side traffic setup and diagnosis](references/server-side-traffic.md)')
    expect(aeroSkill).toContain('traffic.source.queue-backlog')
    expect(canonryReference).toContain('## Server-Side Traffic')
    expect(canonryReference).toContain('--delivery-mode queue-pull')
    expect(canonryReference).toContain('cnry traffic activate')
    expect(trafficReference).toContain('wrangler queues info')
    expect(trafficReference).toContain('wrangler queues consumer http list')
    expect(trafficReference).toContain('wrangler queues consumer http remove')
    expect(trafficReference).toContain('Workers Free, where retention is fixed at one')
    expect(trafficReference).toContain('wrangler queues delete')
    expect(trafficReference).toMatch(/1,000\s+messages per tick/)
  })
})
