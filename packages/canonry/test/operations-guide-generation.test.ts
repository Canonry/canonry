import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const moduleUrl = new URL('../../../scripts/sync-agent-operations.mjs', import.meta.url).href
interface MirroredReference { source: string; target: string; description: string }
const { renderAgentOperations, syncAgentOperations, AERO_MIRRORED_REFERENCES, renderMirroredReference, syncMirroredReferences } = await import(moduleUrl) as {
  renderAgentOperations(source: string): { generated: string; skillMarkdown: string; aeroReferenceMarkdown: string }
  syncAgentOperations(root: string, checkOnly: boolean): string[]
  AERO_MIRRORED_REFERENCES: MirroredReference[]
  renderMirroredReference(reference: MirroredReference, body: string): string
  syncMirroredReferences(root: string, checkOnly: boolean, references?: MirroredReference[]): string[]
}
const source = fs.readFileSync(path.join(root, 'docs/agent-operations/v1.md'), 'utf8')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('reproduces the checked-in runtime and native skill exactly', () => {
  const rendered = renderAgentOperations(source)
  expect(fs.readFileSync(path.join(root, 'packages/canonry/src/mcp/operations-guide.generated.ts'), 'utf8')).toBe(rendered.generated)
  expect(fs.readFileSync(path.join(root, 'skills/canonry/SKILL.md'), 'utf8')).toBe(rendered.skillMarkdown)
  expect(fs.readFileSync(path.join(root, 'skills/aero/references/agent-operations.md'), 'utf8')).toBe(rendered.aeroReferenceMarkdown)
  // Aero-only framing reaches Aero's copy and nothing external hosts read.
  expect(rendered.aeroReferenceMarkdown).toContain('**Built-in Aero:**')
  for (const external of [source, rendered.skillMarkdown, rendered.generated]) {
    expect(external).not.toContain('Built-in Aero')
  }
})

it('detects both source drift and hand-edited generated skills without changing files in check mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-guide-generation-'))
  cleanups.push(dir)
  const guidePath = path.join(dir, 'docs/agent-operations/v1.md')
  fs.mkdirSync(path.dirname(guidePath), { recursive: true })
  fs.writeFileSync(guidePath, source)
  expect(syncAgentOperations(dir, true)).toHaveLength(3)
  expect(syncAgentOperations(dir, false)).toEqual([])
  expect(syncAgentOperations(dir, true)).toEqual([])
  const skillPath = path.join(dir, 'skills/canonry/SKILL.md')
  fs.appendFileSync(skillPath, 'unauthorized generated edit\n')
  expect(syncAgentOperations(dir, true)).toHaveLength(1)
  expect(fs.readFileSync(skillPath, 'utf8')).toContain('unauthorized generated edit')
  syncAgentOperations(dir, false)
  fs.appendFileSync(guidePath, '\nCompatible clarification.\n')
  expect(syncAgentOperations(dir, true)).toHaveLength(3)
  syncAgentOperations(dir, false)
  expect(fs.readFileSync(skillPath, 'utf8')).toContain('Compatible clarification.')
  expect(syncAgentOperations(dir, true)).toEqual([])
})

it('refuses unsupported versions and initialization text too large for the shared entry point', () => {
  expect(() => renderAgentOperations(source.replace('guideVersion: v1', 'guideVersion: v2'))).toThrow('supported version')
  expect(() => renderAgentOperations(source.replace('initialize: |', `initialize: |\n  ${'x'.repeat(2048)}`))).toThrow('under 2KB')
})

it('mirrors Canonry references Aero needs into its own references folder', () => {
  expect(AERO_MIRRORED_REFERENCES.length).toBeGreaterThan(0)
  for (const reference of AERO_MIRRORED_REFERENCES) {
    const body = fs.readFileSync(path.join(root, reference.source), 'utf8')
    const mirrored = fs.readFileSync(path.join(root, reference.target), 'utf8')
    expect(mirrored).toBe(renderMirroredReference(reference, body))
    // Aero lists a doc by its frontmatter; the body is the Canonry source verbatim.
    expect(mirrored.startsWith(`---\nname: ${path.basename(reference.target, '.md')}\ndescription: `)).toBe(true)
    expect(mirrored.endsWith(body)).toBe(true)
    // Every mirrored reference is listed in the Canonry skill and in Aero's table.
    expect(fs.readFileSync(path.join(root, 'skills/canonry/SKILL.md'), 'utf8')).toContain(`(references/${path.basename(reference.source)})`)
    expect(fs.readFileSync(path.join(root, 'skills/aero/SKILL.md'), 'utf8')).toContain(`\`references/${path.basename(reference.target)}\``)
  }
})

it('detects a stale or hand-edited Aero mirror without changing files in check mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mirror-generation-'))
  cleanups.push(dir)
  const reference = { source: 'skills/canonry/references/example.md', target: 'skills/aero/references/example.md', description: 'Example doc.' }
  fs.mkdirSync(path.join(dir, 'skills/canonry/references'), { recursive: true })
  fs.writeFileSync(path.join(dir, reference.source), '# Example\n')
  expect(syncMirroredReferences(dir, true, [reference])).toHaveLength(1)
  expect(fs.existsSync(path.join(dir, reference.target))).toBe(false)
  expect(syncMirroredReferences(dir, false, [reference])).toEqual([])
  expect(syncMirroredReferences(dir, true, [reference])).toEqual([])
  fs.appendFileSync(path.join(dir, reference.target), 'hand edit\n')
  expect(syncMirroredReferences(dir, true, [reference])).toHaveLength(1)
  fs.appendFileSync(path.join(dir, reference.source), 'source change\n')
  syncMirroredReferences(dir, false, [reference])
  expect(fs.readFileSync(path.join(dir, reference.target), 'utf8')).toContain('source change')
  expect(fs.readFileSync(path.join(dir, reference.target), 'utf8')).not.toContain('hand edit')
})
