import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { resolveAeroSkillDir } from './skill-paths.js'

const MAX_DOC_CHARS = 20_000

function textResult<T>(details: T): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  }
}

export interface SkillDocEntry {
  slug: string
  description: string
  bytes: number
}

/**
 * Parse `description:` out of a YAML-ish frontmatter block. Intentionally
 * minimal — we don't pull in a YAML dependency for a single field. Missing
 * or malformed frontmatter falls back to a stub description so the doc is
 * still discoverable.
 */
function parseDescription(body: string): string {
  if (!body.startsWith('---')) return '(no description)'
  const end = body.indexOf('\n---', 3)
  if (end === -1) return '(no description)'
  const block = body.slice(3, end)
  for (const line of block.split('\n')) {
    const match = line.match(/^description:\s*(.+)$/)
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  }
  return '(no description)'
}

export function scanSkillDocs(skillDir?: string): SkillDocEntry[] {
  const refsDir = path.join(skillDir ?? resolveAeroSkillDir(), 'references')
  if (!fs.existsSync(refsDir)) return []
  const entries: SkillDocEntry[] = []
  for (const file of fs.readdirSync(refsDir)) {
    if (!file.endsWith('.md')) continue
    const filePath = path.join(refsDir, file)
    const body = fs.readFileSync(filePath, 'utf-8')
    entries.push({
      slug: file.replace(/\.md$/, ''),
      description: parseDescription(body),
      bytes: Buffer.byteLength(body, 'utf-8'),
    })
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug))
  return entries
}

const ListSchema = Type.Object({})

function buildListSkillDocsTool(): AgentTool<typeof ListSchema> {
  return {
    name: 'list_skill_docs',
    label: 'List skill docs',
    description:
      'List reference playbooks bundled with the Aero skill. Each entry has a slug, a short description of when to use it, and byte size. Call this before read_skill_doc to pick the right doc.',
    parameters: ListSchema,
    execute: async () => {
      return textResult({ docs: scanSkillDocs() })
    },
  }
}

const ReadSchema = Type.Object({
  slug: Type.String({
    description:
      'Doc slug (no extension, no path). Must match a slug from list_skill_docs — unknown slugs return an error listing valid options.',
  }),
})

function buildReadSkillDocTool(): AgentTool<typeof ReadSchema> {
  return {
    name: 'read_skill_doc',
    label: 'Read skill doc',
    description:
      'Load the full content of a reference playbook by slug. Use when a task matches one of the docs returned by list_skill_docs — e.g. "regression-playbook" when investigating lost citations.',
    parameters: ReadSchema,
    execute: async (_toolCallId, params) => {
      const skillDir = resolveAeroSkillDir()
      const docs = scanSkillDocs(skillDir)
      const match = docs.find((d) => d.slug === params.slug)
      if (!match) {
        return textResult({
          error: `Unknown slug "${params.slug}".`,
          availableSlugs: docs.map((d) => d.slug),
        })
      }
      const filePath = path.join(skillDir, 'references', `${match.slug}.md`)
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.length > MAX_DOC_CHARS) {
        return textResult({
          slug: match.slug,
          content: content.slice(0, MAX_DOC_CHARS),
          truncated: true,
          totalBytes: match.bytes,
        })
      }
      return textResult({ slug: match.slug, content, truncated: false })
    },
  }
}

/** Skill-doc tools — reading Aero's own bundled reference playbooks. */
export function buildSkillDocTools(): AgentTool[] {
  return [
    buildListSkillDocsTool() as unknown as AgentTool,
    buildReadSkillDocTool() as unknown as AgentTool,
  ]
}
