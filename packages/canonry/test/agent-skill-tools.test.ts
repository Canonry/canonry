import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { buildSkillDocTools, scanSkillDocs } from '../src/agent/skill-tools.js'

async function exec<T>(tool: AgentTool, params: unknown): Promise<T> {
  const raw = await tool.execute('test-call', params as never)
  return raw.details as T
}

describe('scanSkillDocs (bundled)', () => {
  it('returns every reference in skills/aero/references with a description pulled from frontmatter', () => {
    const docs = scanSkillDocs()
    const slugs = docs.map((d) => d.slug)
    expect(slugs).toEqual(
      expect.arrayContaining([
        'orchestration',
        'memory-patterns',
        'regression-playbook',
        'reporting',
        'wordpress-elementor-mcp',
      ]),
    )
    for (const doc of docs) {
      expect(doc.description.length).toBeGreaterThan(10)
      expect(doc.description).not.toBe('(no description)')
      expect(doc.bytes).toBeGreaterThan(0)
    }
  })
})

describe('scanSkillDocs (synthetic)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-skill-'))
    // Minimum valid skill layout: SKILL.md (so resolve can find it) + refs.
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# stub\n')
    fs.mkdirSync(path.join(tmp, 'references'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('parses description from YAML-ish frontmatter', () => {
    fs.writeFileSync(
      path.join(tmp, 'references', 'foo.md'),
      '---\nname: foo\ndescription: A foo doc.\n---\n\n# Foo\n',
    )
    const docs = scanSkillDocs(tmp)
    expect(docs).toEqual([{ slug: 'foo', description: 'A foo doc.', bytes: expect.any(Number) }])
  })

  it('falls back to stub description when frontmatter is missing or malformed', () => {
    fs.writeFileSync(path.join(tmp, 'references', 'bare.md'), '# Bare\n\nNo frontmatter.\n')
    fs.writeFileSync(
      path.join(tmp, 'references', 'unclosed.md'),
      '---\nname: unclosed\ndescription: never closes\n# Body\n',
    )
    const docs = scanSkillDocs(tmp)
    expect(docs.find((d) => d.slug === 'bare')?.description).toBe('(no description)')
    expect(docs.find((d) => d.slug === 'unclosed')?.description).toBe('(no description)')
  })

  it('strips surrounding quotes from quoted descriptions', () => {
    fs.writeFileSync(
      path.join(tmp, 'references', 'quoted.md'),
      '---\ndescription: "Quoted desc."\n---\n\n# q\n',
    )
    const docs = scanSkillDocs(tmp)
    expect(docs.find((d) => d.slug === 'quoted')?.description).toBe('Quoted desc.')
  })

  it('sorts docs alphabetically by slug', () => {
    fs.writeFileSync(path.join(tmp, 'references', 'zeta.md'), '---\ndescription: z\n---\n')
    fs.writeFileSync(path.join(tmp, 'references', 'alpha.md'), '---\ndescription: a\n---\n')
    const slugs = scanSkillDocs(tmp).map((d) => d.slug)
    expect(slugs).toEqual(['alpha', 'zeta'])
  })

  it('ignores non-markdown files', () => {
    fs.writeFileSync(path.join(tmp, 'references', 'note.txt'), 'ignored')
    fs.writeFileSync(path.join(tmp, 'references', 'real.md'), '---\ndescription: real\n---\n')
    const slugs = scanSkillDocs(tmp).map((d) => d.slug)
    expect(slugs).toEqual(['real'])
  })
})

describe('skill-doc tools', () => {
  const tools = buildSkillDocTools()
  const listTool = tools.find((t) => t.name === 'list_skill_docs')!
  const readTool = tools.find((t) => t.name === 'read_skill_doc')!

  it('list_skill_docs returns the bundled doc manifest', async () => {
    const result = await exec<{ docs: Array<{ slug: string }> }>(listTool, {})
    const slugs = result.docs.map((d) => d.slug)
    expect(slugs).toContain('regression-playbook')
  })

  it('read_skill_doc returns content for a valid slug', async () => {
    const result = await exec<{ slug: string; content: string; truncated: boolean }>(
      readTool,
      { slug: 'regression-playbook' },
    )
    expect(result.slug).toBe('regression-playbook')
    expect(result.content).toContain('Regression Playbook')
    expect(result.truncated).toBe(false)
  })

  it('read_skill_doc returns an error envelope with valid slugs when slug is unknown', async () => {
    const result = await exec<{ error: string; availableSlugs: string[] }>(readTool, {
      slug: 'does-not-exist',
    })
    expect(result.error).toMatch(/does-not-exist/)
    expect(result.availableSlugs).toContain('regression-playbook')
  })
})
