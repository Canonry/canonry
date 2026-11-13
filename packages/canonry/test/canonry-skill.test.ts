import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS } from '@canonry/canonry-integration-traffic'
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

  it('keeps Agent Readiness guidance score-first and uses overview only for crawl metadata', () => {
    const canonrySkillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const canonryReferencePath = fileURLToPath(new URL('../../../skills/canonry/references/canonry-cli.md', import.meta.url))
    const aeroReferencePath = fileURLToPath(new URL('../../../skills/aero/references/orchestration.md', import.meta.url))
    const canonrySkill = fs.readFileSync(canonrySkillPath, 'utf-8')
    const canonryReference = fs.readFileSync(canonryReferencePath, 'utf-8')
    const aeroReference = fs.readFileSync(aeroReferencePath, 'utf-8')

    expect(canonrySkill).toContain('[CLI commands and JSON return shapes](references/canonry-cli.md)')
    expect(canonrySkill).toContain('[Server-side traffic setup and diagnosis](references/server-side-traffic.md)')
    expect(canonryReference).toContain('begin with `cnry agent-readiness score <project> --format json`')
    expect(canonryReference).toContain('only to add crawl metadata')
    expect(aeroReference).toContain('then `cnry agent-readiness score <project> --format json` for the Agent Readiness score')
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
    expect(trafficReference).toContain('CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS')
  })

  it('keeps the WordPress page-cache bypass lists in step with the traffic classifier', () => {
    const trafficReferencePath = fileURLToPath(new URL('../../../skills/canonry/references/server-side-traffic.md', import.meta.url))
    const trafficReference = fs.readFileSync(trafficReferencePath, 'utf-8')
    const fence = '```'
    const codeBlockAfter = (label: string, lang: string): string[] => {
      const start = trafficReference.indexOf(label)
      expect(start, label).toBeGreaterThanOrEqual(0)
      // The block must open right after the label's paragraph, so a missing block can't borrow a later one.
      const block = new RegExp(`^(?:(?!\\n\\n)[\\s\\S])*\\n\\n${fence}${lang}\\n([\\s\\S]*?)\\n${fence}`).exec(trafficReference.slice(start))
      expect(block, label).not.toBeNull()
      return block![1]!.split('\n')
    }
    // A cache plugin bypasses every user agent that contains one of its entries.
    const bypasses = (token: string, entry: string) => token.toLowerCase().includes(entry.toLowerCase())
    // Classic search crawlers stay cached on purpose; the reference says why.
    const cachedSearchCrawlers = ['Googlebot', 'bingbot/', 'DuckDuckBot', 'YandexBot/', 'Baiduspider']
    const aiAgents = DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS.filter((token) => !cachedSearchCrawlers.includes(token))
    const entries = codeBlockAfter('**Which user-agents to exclude from the cache**', 'text')

    expect(aiAgents.filter((token) => !entries.some((entry) => bypasses(token, entry)))).toEqual([])
    expect(entries.filter((entry) => !aiAgents.some((token) => bypasses(token, entry)))).toEqual([])
    expect(cachedSearchCrawlers.filter((token) => entries.some((entry) => bypasses(token, entry)))).toEqual([])
    // WP Rocket's .htaccess rule matches only from the start of the user agent.
    expect(codeBlockAfter('**WP Rocket list:**', 'text')).toEqual(entries.map((entry) => `(.*)${entry}`))
    const wpSuperCachePattern = /preg_match\( '\/([^']+)\/i'/.exec(codeBlockAfter('**WP Super Cache snippet**', 'php').join('\n'))
    expect(wpSuperCachePattern?.[1]?.split('|')).toEqual(entries)
  })
})
