import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CodingAgents,
  SkillsClients,
  SKILL_MANIFEST_FILENAME,
  classifySkillFile,
  coerceSkillManifest,
  skillsClientSchema,
  type BundledSkillSnapshot,
  type CodingAgent,
  type AgentPluginState,
  type SkillManifest,
  type SkillsClient,
} from '@ainyc/canonry-contracts'
import { CliError, isMachineFormat } from '../cli-error.js'
import { PACKAGE_VERSION } from '../package-version.js'

export { CodingAgents, SkillsClients }
export type { CodingAgent, SkillsClient }

export const BUNDLED_SKILL_NAMES = ['canonry', 'aero'] as const
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]

export interface BundledSkillInfo {
  name: BundledSkillName
  description: string
  bundledPath: string
}

export interface SkillsInstallOptions {
  dir?: string
  /**
   * Shortcut for `dir: os.homedir()`. Installs into `~/.claude/skills/` so
   * Claude Code (or Codex) sessions on this machine auto-load the bundled
   * canonry/aero reference docs regardless of which project they open.
   * Mutually exclusive with `dir`. When both are passed, `--user` wins and
   * a warning is surfaced through the summary.
   */
  user?: boolean
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
  /**
   * Per-file reconciliation detail for `.claude` directory installs. Present
   * only on claude results (codex symlink results omit them). An agent can
   * treat a non-empty `conflicts` as "local edits were preserved; re-run with
   * `--force` to overwrite them".
   */
  added?: string[]
  /** Relative paths written — net-new files plus upstream-updated (stale) files plus forced overwrites. */
  updated?: string[]
  /** Relative paths left untouched because they already matched the bundle. */
  unchanged?: string[]
  /** Relative paths skipped because they are local edits diverging from the bundle (no `--force`). */
  conflicts?: string[]
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
  const descMatch = /^description:\s*(\S.*)$/m.exec(fmMatch[1])
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

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function readSkillManifest(skillDir: string): SkillManifest | null {
  try {
    return coerceSkillManifest(JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_MANIFEST_FILENAME), 'utf-8')))
  } catch {
    // Missing or malformed manifest — treat as a legacy install with no record.
    return null
  }
}

function writeSkillManifest(skillDir: string, manifest: SkillManifest): void {
  fs.writeFileSync(path.join(skillDir, SKILL_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

interface ReconcileResult {
  /** Net-new files copied into the install. */
  added: string[]
  /** Files written over: upstream-updated (stale) files plus forced overwrites of local edits. */
  updated: string[]
  /** Files already byte-identical to the bundle. */
  unchanged: string[]
  /** Local edits left untouched because `--force` was not passed. */
  conflicts: string[]
  /** Relative path → bundled sha256, captured during the walk for manifest assembly. */
  bundledHashes: Map<string, string>
}

/**
 * Reconcile a bundled skill tree into an installed one, file by file. This is
 * additive: a missing file is always copied (an unambiguous addition), an
 * upstream-updated file the operator never touched is refreshed, and a genuine
 * local edit is preserved unless `force` is set. Files present in the install
 * but absent from the bundle are left in place — reconciliation never deletes.
 */
function reconcileSkillTree(
  srcDir: string,
  destDir: string,
  manifest: SkillManifest | null,
  force: boolean,
): ReconcileResult {
  const result: ReconcileResult = { added: [], updated: [], unchanged: [], conflicts: [], bundledHashes: new Map() }
  for (const rel of walkRelative(srcDir)) {
    const srcPath = path.join(srcDir, rel)
    const destPath = path.join(destDir, rel)
    const bundledHash = sha256File(srcPath)
    result.bundledHashes.set(rel, bundledHash)
    const installedHash = fs.existsSync(destPath) ? sha256File(destPath) : undefined
    const state = classifySkillFile({ bundledHash, installedHash, manifestHash: manifest?.files[rel] })
    switch (state) {
      case 'missing':
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(srcPath, destPath)
        result.added.push(rel)
        break
      case 'unchanged':
        result.unchanged.push(rel)
        break
      case 'stale':
        fs.copyFileSync(srcPath, destPath)
        result.updated.push(rel)
        break
      case 'edited':
        if (force) {
          fs.copyFileSync(srcPath, destPath)
          result.updated.push(rel)
        } else {
          result.conflicts.push(rel)
        }
        break
    }
  }
  return result
}

/**
 * Build the manifest to record what canonry now considers canonical for the
 * tree. Reconciled files (added / refreshed / unchanged) record the bundle
 * hash; preserved local edits keep the prior manifest entry so that a later
 * revert to canonry's content is recognized as refreshable, not as an edit.
 */
function buildManifest(
  skillName: BundledSkillName,
  recon: ReconcileResult,
  prior: SkillManifest | null,
): SkillManifest {
  const conflicts = new Set(recon.conflicts)
  const files: Record<string, string> = {}
  for (const [rel, bundledHash] of recon.bundledHashes) {
    files[rel] = conflicts.has(rel) ? (prior?.files[rel] ?? bundledHash) : bundledHash
  }
  return { skill: skillName, version: PACKAGE_VERSION, files }
}

function describeChanges(recon: ReconcileResult): string {
  const parts: string[] = []
  if (recon.added.length > 0) parts.push(`${recon.added.length} added`)
  if (recon.updated.length > 0) parts.push(`${recon.updated.length} refreshed`)
  return parts.length > 0 ? parts.join(', ') : 'no changes'
}

function buildClaudeMessage(
  name: string,
  status: SkillInstallResult['status'],
  recon: ReconcileResult,
): string {
  const rel = `.claude/skills/${name}`
  let message = status === 'installed'
    ? `Installed ${rel}`
    : status === 'updated'
      ? `Updated ${rel} (${describeChanges(recon)})`
      : `Already installed: ${rel}`
  if (recon.conflicts.length > 0) {
    message += ` — ${recon.conflicts.length} file(s) differ from the bundle (local edits kept; pass --force to overwrite)`
  }
  return message
}

function installClaudeSkill(skill: BundledSkillInfo, targetDir: string, force: boolean): SkillInstallResult {
  const targetPath = path.join(targetDir, '.claude', 'skills', skill.name)
  // SKILL.md presence (not bare dir existence) marks a real prior install, so a
  // half-finished/empty dir is treated as a fresh install rather than an update.
  const existedBefore = fs.existsSync(path.join(targetPath, 'SKILL.md'))
  const priorManifest = readSkillManifest(targetPath)

  fs.mkdirSync(targetPath, { recursive: true })
  const recon = reconcileSkillTree(skill.bundledPath, targetPath, priorManifest, force)
  writeSkillManifest(targetPath, buildManifest(skill.name, recon, priorManifest))

  const changed = recon.added.length + recon.updated.length
  const status: SkillInstallResult['status'] = !existedBefore
    ? 'installed'
    : changed > 0
      ? 'updated'
      : 'already-installed'

  return {
    skill: skill.name,
    client: CodingAgents.claude,
    targetPath,
    status,
    message: buildClaudeMessage(skill.name, status, recon),
    added: recon.added,
    updated: recon.updated,
    unchanged: recon.unchanged,
    conflicts: recon.conflicts,
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
  let message = `Skills install summary: ${parts.join(', ')}.`
  const totalConflicts = results.reduce((sum, r) => sum + (r.conflicts?.length ?? 0), 0)
  if (totalConflicts > 0) {
    message += ` ${totalConflicts} file(s) differ from the bundle and were kept — pass --force to overwrite local edits.`
  }
  return message
}

/**
 * Snapshot every bundled skill (version + per-file sha256) for the
 * `agent.skills.current` doctor check. The check lives in `api-routes`, which
 * cannot resolve canonry's bundled assets, so the running server computes this
 * and injects it into the doctor context.
 */
export function getBundledSkillSnapshots(pkgDir?: string): BundledSkillSnapshot[] {
  return getBundledSkills(pkgDir).map(skill => {
    const files: Record<string, string> = {}
    for (const rel of walkRelative(skill.bundledPath)) {
      files[rel] = sha256File(path.join(skill.bundledPath, rel))
    }
    return { name: skill.name, version: PACKAGE_VERSION, files }
  })
}

export async function installSkills(opts: SkillsInstallOptions = {}): Promise<SkillsInstallSummary> {
  const targetDir = opts.user
    ? os.homedir()
    : path.resolve(opts.dir ?? process.cwd())
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

  if (isMachineFormat(opts.format)) {
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
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  for (const r of summary.results) console.log(r.message)
  console.log(`\nTarget: ${summary.targetDir}`)
  console.log(summary.message)
}

export interface UserSkillsNudge {
  /** One-line message safe to print to stderr at `canonry serve` boot. */
  message: string
  /** Skills missing from `~/.claude/skills/`. */
  missing: BundledSkillName[]
  /** Skills already installed there. */
  installed: BundledSkillName[]
}

/**
 * Mirrors the `agent.skills.installed` doctor check but returns a nudge
 * payload instead of a check result. Returns null when:
 *   - both skills are installed (nothing to nudge about), or
 *   - $HOME is not set (cannot tell — silent rather than wrong).
 *
 * Caller is expected to print the message to stderr; this helper does no I/O.
 */
export function getMissingUserSkillsNudge(
  home: string | null | undefined,
  agentPlugin?: AgentPluginState,
): UserSkillsNudge | null {
  if (!home) return null
  const skillsBase = path.join(home, '.claude', 'skills')
  const installed: BundledSkillName[] = []
  const missing: BundledSkillName[] = []
  for (const name of BUNDLED_SKILL_NAMES) {
    const skillFile = path.join(skillsBase, name, 'SKILL.md')
    if (existsSafe(skillFile)) installed.push(name)
    else missing.push(name)
  }

  if (agentPlugin && agentPlugin.configuredClients.length > 0) {
    const unverifiedClients = agentPlugin.configuredClients
      .filter((client) => !agentPlugin.verifiedClients.includes(client))
    const mismatchedClients = agentPlugin.verifiedClients
      .filter((client) => agentPlugin.verifiedClientVersions?.[client] !== PACKAGE_VERSION)
    if (unverifiedClients.length === 0 && mismatchedClients.length === 0) return null
    const displayClients = (clients: AgentPluginState['configuredClients']) => clients
      .map((client) => client === 'claude-code' ? 'Claude Code' : 'Codex')
      .join(' + ')
    const problems: string[] = []
    if (unverifiedClients.length > 0) {
      problems.push(`The Canonry plugin is enabled for ${displayClients(unverifiedClients)}, but its cached manifest and skill assets could not be verified.`)
    }
    if (mismatchedClients.length > 0) {
      const versions = mismatchedClients
        .map((client) => `${client === 'claude-code' ? 'Claude Code' : 'Codex'} v${agentPlugin.verifiedClientVersions?.[client] ?? 'unknown'}`)
        .join(', ')
      problems.push(`${versions} ${mismatchedClients.length === 1 ? 'does' : 'do'} not match the running Canonry v${PACKAGE_VERSION}.`)
    }
    return {
      message: `Tip: ${problems.join(' ')} Update or reinstall \`canonry@canonry\` with the affected client plugin manager.`,
      missing,
      installed,
    }
  }

  if (missing.length === 0) return null

  const fix = missing.length === BUNDLED_SKILL_NAMES.length
    ? 'canonry skills install --user'
    : `canonry skills install ${missing.join(' ')} --user`
  return {
    message: `Tip: ${missing.join(' + ')} skill${missing.length === 1 ? '' : 's'} not installed in ~/.claude/skills/. Run \`${fix}\` so Claude/Codex sessions on this host auto-load the canonry reference docs.`,
    missing,
    installed,
  }
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
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
