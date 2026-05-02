import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CodingAgents,
  SkillsClients,
  skillsClientSchema,
  type CodingAgent,
  type SkillsClient,
} from '@ainyc/canonry-contracts'
import { CliError } from '../cli-error.js'

export { CodingAgents, SkillsClients }
export type { CodingAgent, SkillsClient }

export const BUNDLED_SKILL_NAMES = ['canonry-setup', 'aero'] as const
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]

export interface BundledSkillInfo {
  name: BundledSkillName
  description: string
  bundledPath: string
}

export interface SkillsInstallOptions {
  dir?: string
  skills?: string[]
  client?: SkillsClient
  force?: boolean
}

export interface SkillsListOptions {
  format?: string
}

export interface SkillInstallResult {
  skill: BundledSkillName
  client: CodingAgent
  targetPath: string
  status: 'installed' | 'already-installed' | 'updated' | 'linked' | 'already-linked' | 'relinked'
  message: string
}

export interface SkillsInstallSummary {
  targetDir: string
  results: SkillInstallResult[]
  message: string
}

export function resolveBundledSkillsRoot(pkgDir?: string): string {
  const here = pkgDir ?? path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, '../assets/agent-workspace/skills'),
    path.join(here, '../../assets/agent-workspace/skills'),
    path.join(here, '../../../../skills'),
  ]
  for (const candidate of candidates) {
    if (BUNDLED_SKILL_NAMES.every(name => fs.existsSync(path.join(candidate, name, 'SKILL.md')))) {
      return candidate
    }
  }
  throw new CliError({
    code: 'INTERNAL_ERROR',
    message: `Bundled skills not found. Searched:\n  ${candidates.join('\n  ')}`,
    exitCode: 2,
  })
}

function parseDescription(content: string): string {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fmMatch) return ''
  const descMatch = /^description:\s*(.+?)$/m.exec(fmMatch[1])
  if (!descMatch) return ''
  return descMatch[1].replace(/^["']|["']$/g, '').trim()
}

export function getBundledSkills(pkgDir?: string): BundledSkillInfo[] {
  const root = resolveBundledSkillsRoot(pkgDir)
  return BUNDLED_SKILL_NAMES.map(name => {
    const skillDir = path.join(root, name)
    const skillFile = path.join(skillDir, 'SKILL.md')
    const content = fs.readFileSync(skillFile, 'utf-8')
    return { name, description: parseDescription(content), bundledPath: skillDir }
  })
}

function walkRelative(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkRelative(full, rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out.sort()
}

function compareDirContent(srcDir: string, destDir: string): 'match' | 'different' | 'missing' {
  if (!fs.existsSync(destDir)) return 'missing'
  if (!fs.statSync(destDir).isDirectory()) return 'different'
  const srcFiles = walkRelative(srcDir)
  const destFiles = walkRelative(destDir)
  if (srcFiles.length !== destFiles.length) return 'different'
  for (let i = 0; i < srcFiles.length; i++) {
    if (srcFiles[i] !== destFiles[i]) return 'different'
    const srcBytes = fs.readFileSync(path.join(srcDir, srcFiles[i]))
    const destBytes = fs.readFileSync(path.join(destDir, destFiles[i]))
    if (!srcBytes.equals(destBytes)) return 'different'
  }
  return 'match'
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function installClaudeSkill(skill: BundledSkillInfo, targetDir: string, force: boolean): SkillInstallResult {
  const targetPath = path.join(targetDir, '.claude', 'skills', skill.name)
  const compare = compareDirContent(skill.bundledPath, targetPath)

  if (compare === 'match') {
    return {
      skill: skill.name, client: CodingAgents.claude, targetPath,
      status: 'already-installed',
      message: `Already installed: .claude/skills/${skill.name}`,
    }
  }

  if (compare === 'different' && !force) {
    throw new CliError({
      code: 'VALIDATION_ERROR',
      message: `.claude/skills/${skill.name}/ already exists and differs from the bundled skill. Pass --force to overwrite.`,
      details: { skill: skill.name, targetPath },
      exitCode: 1,
    })
  }

  if (compare === 'different') {
    fs.rmSync(targetPath, { recursive: true, force: true })
  }

  copyDirRecursive(skill.bundledPath, targetPath)
  return {
    skill: skill.name, client: CodingAgents.claude, targetPath,
    status: compare === 'missing' ? 'installed' : 'updated',
    message: compare === 'missing'
      ? `Installed .claude/skills/${skill.name}`
      : `Updated .claude/skills/${skill.name}`,
  }
}

function installCodexSymlink(skill: BundledSkillInfo, targetDir: string, force: boolean): SkillInstallResult {
  const codexPath = path.join(targetDir, '.codex', 'skills', skill.name)
  const claudePath = path.join(targetDir, '.claude', 'skills', skill.name)
  const linkTarget = path.relative(path.dirname(codexPath), claudePath)

  fs.mkdirSync(path.dirname(codexPath), { recursive: true })

  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(codexPath)
  } catch {
    stat = undefined
  }

  if (stat?.isSymbolicLink()) {
    const existing = fs.readlinkSync(codexPath)
    if (existing === linkTarget) {
      return {
        skill: skill.name, client: CodingAgents.codex, targetPath: codexPath,
        status: 'already-linked',
        message: `Already linked: .codex/skills/${skill.name}`,
      }
    }
    if (!force) {
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: `.codex/skills/${skill.name} is a symlink pointing elsewhere (${existing}). Pass --force to relink.`,
        details: { skill: skill.name, targetPath: codexPath, existingTarget: existing },
        exitCode: 1,
      })
    }
    fs.unlinkSync(codexPath)
    fs.symlinkSync(linkTarget, codexPath)
    return {
      skill: skill.name, client: CodingAgents.codex, targetPath: codexPath,
      status: 'relinked',
      message: `Relinked .codex/skills/${skill.name} → ${linkTarget}`,
    }
  }

  if (stat) {
    if (!force) {
      throw new CliError({
        code: 'VALIDATION_ERROR',
        message: `.codex/skills/${skill.name} exists but is not a symlink. Pass --force to replace.`,
        details: { skill: skill.name, targetPath: codexPath },
        exitCode: 1,
      })
    }
    fs.rmSync(codexPath, { recursive: true, force: true })
  }

  fs.symlinkSync(linkTarget, codexPath)
  return {
    skill: skill.name, client: CodingAgents.codex, targetPath: codexPath,
    status: stat ? 'relinked' : 'linked',
    message: stat
      ? `Replaced and linked .codex/skills/${skill.name} → ${linkTarget}`
      : `Linked .codex/skills/${skill.name} → ${linkTarget}`,
  }
}

function buildSummaryMessage(results: SkillInstallResult[]): string {
  const counts: Record<string, number> = {}
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
  const parts = Object.entries(counts).map(([status, n]) => `${n} ${status}`)
  return `Skills install summary: ${parts.join(', ')}.`
}

export async function installSkills(opts: SkillsInstallOptions = {}): Promise<SkillsInstallSummary> {
  const targetDir = path.resolve(opts.dir ?? process.cwd())
  const client: SkillsClient = opts.client ?? SkillsClients.all
  const force = opts.force ?? false

  const allSkills = getBundledSkills()
  const requestedNames = opts.skills && opts.skills.length > 0 ? opts.skills : allSkills.map(s => s.name)

  const knownNames = new Set<string>(allSkills.map(s => s.name))
  const unknown = requestedNames.filter(n => !knownNames.has(n))
  if (unknown.length > 0) {
    throw new CliError({
      code: 'VALIDATION_ERROR',
      message: `Unknown skill(s): ${unknown.join(', ')}. Available: ${[...knownNames].join(', ')}`,
      details: { unknownSkills: unknown, availableSkills: [...knownNames] },
      exitCode: 1,
    })
  }

  const skillsToInstall = allSkills.filter(s => requestedNames.includes(s.name))

  fs.mkdirSync(targetDir, { recursive: true })

  const results: SkillInstallResult[] = []
  for (const skill of skillsToInstall) {
    results.push(installClaudeSkill(skill, targetDir, force))
    if (client !== SkillsClients.claude) {
      results.push(installCodexSymlink(skill, targetDir, force))
    }
  }

  return {
    targetDir,
    results,
    message: buildSummaryMessage(results),
  }
}

export async function listSkills(opts: SkillsListOptions = {}): Promise<void> {
  const skills = getBundledSkills()

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      skills: skills.map(s => ({
        name: s.name,
        description: s.description,
        claudePath: `.claude/skills/${s.name}`,
        codexPath: `.codex/skills/${s.name}`,
      })),
    }, null, 2))
    return
  }

  console.log('Bundled canonry skills:\n')
  for (const skill of skills) {
    console.log(`  ${skill.name}`)
    if (skill.description) console.log(`    ${skill.description}`)
    console.log(`    Claude: .claude/skills/${skill.name}/`)
    console.log(`    Codex:  .codex/skills/${skill.name} (symlink → ../../.claude/skills/${skill.name})`)
    console.log()
  }
}

export function emitInstallSummary(summary: SkillsInstallSummary, format?: string): void {
  if (format === 'json') {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  for (const r of summary.results) console.log(r.message)
  console.log(`\nTarget: ${summary.targetDir}`)
  console.log(summary.message)
}

export function parseSkillsClient(value: string | undefined): SkillsClient {
  if (!value) return SkillsClients.all
  const parsed = skillsClientSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const allowed = skillsClientSchema.options
  throw new CliError({
    code: 'VALIDATION_ERROR',
    message: `Invalid --client value "${value}". Must be one of: ${allowed.join(', ')}`,
    details: { flag: 'client', value, allowed },
    exitCode: 1,
  })
}
