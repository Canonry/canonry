import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { readSkillResource } from '../../val-kit/src/mcp/resources.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const moduleUrl = new URL('../../../scripts/sync-agent-operations.mjs', import.meta.url).href
const { renderAgentOperations, syncAgentOperations } = await import(moduleUrl) as {
  renderAgentOperations(source: string): { generated: string; skillMarkdown: string }
  syncAgentOperations(root: string, checkOnly: boolean): string[]
}
const source = fs.readFileSync(path.join(root, 'docs/agent-operations/v1.md'), 'utf8')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('reproduces the checked-in runtime and native skill exactly', () => {
  const rendered = renderAgentOperations(source)
  expect(fs.readFileSync(path.join(root, 'packages/canonry/src/mcp/operations-guide.generated.ts'), 'utf8')).toBe(rendered.generated)
  expect(fs.readFileSync(path.join(root, 'skills/canonry/SKILL.md'), 'utf8')).toBe(rendered.skillMarkdown)
  expect(readSkillResource('canonry-skill://canonry/SKILL.md')?.text).toBe(rendered.skillMarkdown)
})

it('detects both source drift and hand-edited generated skills without changing files in check mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-guide-generation-'))
  cleanups.push(dir)
  const guidePath = path.join(dir, 'docs/agent-operations/v1.md')
  fs.mkdirSync(path.dirname(guidePath), { recursive: true })
  fs.writeFileSync(guidePath, source)
  expect(syncAgentOperations(dir, true)).toHaveLength(2)
  expect(syncAgentOperations(dir, false)).toEqual([])
  expect(syncAgentOperations(dir, true)).toEqual([])
  const skillPath = path.join(dir, 'skills/canonry/SKILL.md')
  fs.appendFileSync(skillPath, 'unauthorized generated edit\n')
  expect(syncAgentOperations(dir, true)).toHaveLength(1)
  expect(fs.readFileSync(skillPath, 'utf8')).toContain('unauthorized generated edit')
  syncAgentOperations(dir, false)
  fs.appendFileSync(guidePath, '\nCompatible clarification.\n')
  expect(syncAgentOperations(dir, true)).toHaveLength(2)
  syncAgentOperations(dir, false)
  expect(fs.readFileSync(skillPath, 'utf8')).toContain('Compatible clarification.')
  expect(syncAgentOperations(dir, true)).toEqual([])
})

it('refuses unsupported versions and initialization text too large for the shared entry point', () => {
  expect(() => renderAgentOperations(source.replace('guideVersion: v1', 'guideVersion: v2'))).toThrow('supported version')
  expect(() => renderAgentOperations(source.replace('initialize: |', `initialize: |\n  ${'x'.repeat(2048)}`))).toThrow('under 2KB')
})
