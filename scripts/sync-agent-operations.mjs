import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Aero-only framing for the generated `agent-operations` skill doc. It lives in
// the generator rather than the canonical guide because the guide also becomes
// the external hosts' SKILL.md and MCP resource, where Aero internals are noise.
const AERO_PREFACE = [
  '> **Built-in Aero:** your available `canonry_*` tools are already loaded, and',
  '> you read this guide through `read_skill_doc` (slug `agent-operations`). Your',
  '> catalog does not include `canonry_help` or `canonry_load_toolkit`; the',
  '> connection and navigation steps below are for external MCP hosts. Your',
  "> project-scoped tools use the current session's project. Dashboard selections",
  '> are not passed to chat: resolve the requested Property, market, filters, or',
  '> page before making a scoped claim. The `portfolio-analysis` and `site-health`',
  '> skill docs cover those investigations for Simple and Advanced portfolios.',
  '',
  '',
].join('\n')

export function renderAgentOperations(source) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error('Operations guide must have YAML frontmatter')
  const data = parse(match[1])
  if (data.guideVersion !== 'v1' || !data.operationsGuideUrl?.startsWith('https://')) {
    throw new Error('Operations guide requires a supported version and public HTTPS URL')
  }
  if (Buffer.byteLength(data.initialize, 'utf8') >= 2048) throw new Error('Initialization guidance must stay under 2KB')
  const markdown = match[2].trim() + '\n'
  const { skill, nativeReferences, ...runtime } = data
  const generated = '// Generated from docs/agent-operations/v1.md by pnpm guide:sync. Do not edit.\n'
    + `export const OPERATIONS_GUIDE = ${JSON.stringify({ ...runtime, markdown }, null, 2)} as const\n`
  const native = nativeReferences.map(([file, label]) => `- [${label}](${file})`).join('\n')
  const skillMarkdown = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`
    + '<!-- Generated from docs/agent-operations/v1.md by pnpm guide:sync. Do not edit. -->\n\n'
    + markdown + '\n## Optional host-native references\n\nRead only references relevant to the requested task. They are not required for MCP operation.\n\n'
    + native + '\n'
  const aeroReferenceMarkdown = '---\nname: agent-operations\n'
    + 'description: Shared Canonry vocabulary, evidence scope, comparison rules, and authority boundaries. Read when interpreting unfamiliar data or checking an operation.\n---\n\n'
    + '<!-- Generated from docs/agent-operations/v1.md by pnpm guide:sync. Do not edit. -->\n\n'
    + AERO_PREFACE
    + markdown
  return { generated, skillMarkdown, aeroReferenceMarkdown }
}

export function syncAgentOperations(root = repoRoot, checkOnly = false) {
  const source = fs.readFileSync(path.join(root, 'docs/agent-operations/v1.md'), 'utf8')
  const { generated, skillMarkdown, aeroReferenceMarkdown } = renderAgentOperations(source)
  const outputs = [
    ['packages/canonry/src/mcp/operations-guide.generated.ts', generated],
    ['skills/canonry/SKILL.md', skillMarkdown],
    ['skills/aero/references/agent-operations.md', aeroReferenceMarkdown],
  ]
  const failures = []
  for (const [relative, expected] of outputs) {
    const target = path.join(root, relative)
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
    if (actual === expected) continue
    if (checkOnly) failures.push(`${relative} differs from the Operations Guide; run pnpm guide:sync`)
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, expected)
    }
  }
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = syncAgentOperations(repoRoot, process.argv.includes('--check'))
  if (failures.length) {
    process.stderr.write(failures.join('\n') + '\n')
    process.exitCode = 1
  }
}
