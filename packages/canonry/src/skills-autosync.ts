import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_MANIFEST_FILENAME, SkillsClients, type SkillsClient } from '@canonry/canonry-contracts'
import { BUNDLED_SKILL_NAMES, installSkills } from './commands/skills.js'
import { configExists, loadConfigRaw, saveConfigPatch } from './config.js'
import { PACKAGE_VERSION } from './package-version.js'

/**
 * Keep the skills already installed on this machine in step with the engine
 * that is actually running.
 *
 * The problem this solves: `canonry skills install` copies the bundled skill
 * trees onto disk, and nothing ever re-runs it. Upgrade the engine and the
 * agent keeps reading a playbook for the previous version — it will cite a flag
 * that no longer exists, or miss a command that now does. Unlike a stale shell
 * completion, which fails loudly and harmlessly (TAB does nothing), a stale
 * playbook fails silently and confidently: the agent asserts something wrong
 * and the cost lands as a failed run.
 *
 * Why not a package-manager hook: npm's `allowScripts` is off by default and
 * a global install cannot approve scripts at all, so a `postinstall` would fail
 * hardest for exactly the people most likely to be running an agent in a
 * hardened environment. Healing on the next invocation needs no package-manager
 * cooperation, and additionally covers hand-deleted files, a partial install,
 * and a `$HOME` shared across machines — none of which a version bump implies.
 */

/** Re-verify at most this often when the version has NOT changed. */
const DEFAULT_SYNC_INTERVAL_SECONDS = 24 * 60 * 60

export type VersionProbe =
  /** Config is absent or unreadable. We know nothing, so we must do nothing. */
  | { state: 'unknown' }
  | { state: 'unchanged' }
  | { state: 'changed'; lastSeen: string | undefined }

/**
 * Has the running build changed since the last recorded invocation?
 *
 * Split out of `detectAndTrackUpgrade` deliberately. That function opens with
 * `if (!isTelemetryEnabled()) return`, so on a telemetry-disabled install the
 * version was never recorded and an upgrade was never noticed. Tying a
 * correctness behaviour to an analytics opt-in gives the users who opt out a
 * quietly worse product. This probe is analytics-free; the telemetry path still
 * emits `cli.upgraded` on top of it.
 *
 * `unknown` is a distinct state from `changed` and the distinction is
 * load-bearing. `loadConfigRaw()` returns null for BOTH "no config" and
 * "config present but unparsable" — it does not throw — so folding null into
 * "no version recorded, therefore changed" makes a malformed config look like
 * an upgrade. That then reaches `saveConfigPatch`, whose read-modify-write
 * falls back to an EMPTY base when the file will not parse, so the merge writes
 * only the keys in the patch and the user's apiKey, database path and provider
 * credentials are gone. A file we cannot read is the one file we must not
 * write.
 */
export function peekVersionChange(): VersionProbe {
  if (!configExists()) return { state: 'unknown' }
  const raw = loadConfigRaw()
  // Config file is on disk but did not parse. Never write in this state.
  if (raw === null) return { state: 'unknown' }
  // Deliberately NOT telemetry's `lastSeenVersion`. Sharing that field made
  // this the first writer on an upgrade, and `detectAndTrackUpgrade` bails on
  // `lastSeen === VERSION`, so stamping it here permanently suppressed the
  // `cli.upgraded` event. Two subsystems, two keys.
  const lastSeen = raw.lastSkillsSyncedVersion
  if (lastSeen === PACKAGE_VERSION) return { state: 'unchanged' }
  return { state: 'changed', lastSeen }
}

function syncIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CANONRY_SKILLS_SYNC_SECS
  if (!raw) return DEFAULT_SYNC_INTERVAL_SECONDS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SYNC_INTERVAL_SECONDS
}

function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CANONRY_NO_AUTO_SKILLS_SYNC
  return raw === '1' || raw === 'true'
}

/**
 * Directories that already contain a skill tree canonry itself installed.
 *
 * Auto-sync REPAIRS; it never adopts. `installSkills` will happily create
 * `~/.claude/skills/` from nothing, so calling it unconditionally would write
 * into the home directory of someone who ran `canonry init --skip-skills` and
 * said no. Presence of the manifest canonry writes is the only honest evidence
 * that a directory is ours to refresh.
 *
 * Both scopes are checked because `canonry init` installs PROJECT-local by
 * default and only `--user` installs global. Healing just the global path would
 * miss the common case entirely.
 */
export interface OwnedInstallTarget {
  dir: string
  user: boolean
  /** Only the skills whose manifest is present. Never the full bundled set. */
  skills: string[]
  /** Codex is refreshed only where canonry already linked it. */
  client: SkillsClient
}

export function ownedInstallTargets(cwd = process.cwd(), home = os.homedir()): OwnedInstallTarget[] {
  // Resolve before comparing: `cwd` and `home` are frequently the same
  // directory, and installing it twice double-reports every preserved local
  // edit, so the notice claims two diverged files when one did.
  const seen = new Set<string>()
  const candidates = [
    { dir: path.resolve(home), user: true },
    { dir: path.resolve(cwd), user: false },
  ]

  const targets: OwnedInstallTarget[] = []
  for (const { dir, user } of candidates) {
    if (seen.has(dir)) continue
    seen.add(dir)

    // Per SKILL, not per directory. `some()` was enough to prove the directory
    // is ours, but not to decide WHAT to write into it: an operator who ran
    // `canonry skills install aero` has one manifest, and refreshing on the
    // strength of it would install `canonry` too — adopting a skill they
    // declined, which is the behaviour the manifest gate exists to prevent.
    const skills = BUNDLED_SKILL_NAMES.filter((name) =>
      fs.existsSync(path.join(dir, '.claude', 'skills', name, SKILL_MANIFEST_FILENAME)),
    )
    if (skills.length === 0) continue

    // Same argument for the client. `installSkills` defaults to every client,
    // so healing unscoped creates `.codex/skills/` for someone who installed
    // with `--client claude`. Only refresh the codex link where one already is.
    const hasCodex = skills.some((name) => {
      try {
        return fs.lstatSync(path.join(dir, '.codex', 'skills', name)).isSymbolicLink()
      } catch {
        return false
      }
    })
    targets.push({ dir, user, skills, client: hasCodex ? SkillsClients.all : SkillsClients.claude })
  }
  return targets
}

export interface SkillsAutoSyncResult {
  ran: boolean
  reason: 'version-changed' | 'interval-elapsed' | 'skipped'
  /** Relative paths refreshed because they were stale against the new bundle. */
  updated: string[]
  /** Relative paths left alone because they carry local edits. */
  conflicts: string[]
  /** Directories actually repaired. Empty when canonry owns no install here. */
  targets: string[]
}

/**
 * Refresh only the files that are STALE against the bundled copy.
 *
 * Four properties, all load-bearing:
 *
 * 1. It never writes when the config did not parse. See `peekVersionChange`.
 * 2. It never installs where canonry has not installed before, proven by the
 *    manifest rather than assumed. See `ownedInstallTargets`.
 * 3. It never overwrites a local edit. `installSkills` classifies each file as
 *    missing / unchanged / stale / edited and, without `--force`, replaces only
 *    the first two. We deliberately do not pass `force`.
 * 4. It is silent on success. A heal that had nothing to say says nothing.
 */
export async function autoSyncSkills(env: NodeJS.ProcessEnv = process.env): Promise<SkillsAutoSyncResult> {
  const skipped: SkillsAutoSyncResult = { ran: false, reason: 'skipped', updated: [], conflicts: [], targets: [] }
  if (isDisabled(env)) return skipped

  const probe = peekVersionChange()
  if (probe.state === 'unknown') return skipped

  let reason: SkillsAutoSyncResult['reason']
  if (probe.state === 'changed') {
    reason = 'version-changed'
  } else {
    // A version bump is not the only way a copy goes wrong, so also re-verify
    // on a timer. The comparison is bundled-file hash vs installed-file hash,
    // entirely local, so it costs no network.
    const intervalSeconds = syncIntervalSeconds(env)
    if (intervalSeconds === 0) return skipped
    const raw = loadConfigRaw()
    if (raw === null) return skipped
    const last = raw.lastSkillsVerifiedAt ? Date.parse(raw.lastSkillsVerifiedAt) : 0
    const elapsed = (Date.now() - (Number.isFinite(last) ? last : 0)) / 1000
    if (elapsed < intervalSeconds) return skipped
    reason = 'interval-elapsed'
  }

  const targets = ownedInstallTargets()
  if (targets.length === 0) {
    // Record NOTHING here. Ownership is per-directory but this record is
    // global, so stamping it from a directory canonry does not own consumed the
    // upgrade signal for the directory that does: one `cnry` run from /tmp (or
    // an MCP host launched anywhere) marked the version synced, and the next
    // run from the project root saw `unchanged` and skipped the heal the whole
    // feature exists to perform. Re-probing costs two `existsSync` calls.
    return skipped
  }

  const updated: string[] = []
  const conflicts: string[] = []

  for (const target of targets) {
    // Per skill, not per target. `installCodexSymlink` throws without `--force`
    // when `.codex/skills/<name>` exists but is not the symlink it expects, and
    // `installSkills` installs skills in one loop — so one broken codex entry
    // aborted the whole call and the SECOND skill was never reconciled at all.
    for (const skill of target.skills) {
      try {
        const summary = await installSkills({
          ...(target.user ? { user: true } : { dir: target.dir }),
          skills: [skill],
          client: target.client,
        })
        for (const result of summary.results) {
          for (const p of result.updated ?? []) updated.push(p)
          for (const p of result.conflicts ?? []) conflicts.push(p)
        }
      } catch {
        // Never let a skills refresh break the command the user actually ran.
      }
    }
  }

  recordVerified()
  return { ran: true, reason, updated, conflicts, targets: targets.map((t) => t.dir) }
}

function recordVerified(): void {
  try {
    // `lastSkillsSyncedVersion`, never telemetry's `lastSeenVersion`. See
    // `peekVersionChange`: writing that field here made this the first writer
    // on an upgrade and permanently suppressed `cli.upgraded`.
    saveConfigPatch({
      lastSkillsSyncedVersion: PACKAGE_VERSION,
      lastSkillsVerifiedAt: new Date().toISOString(),
    })
  } catch {
    // A failed write just means we re-check next time. Not worth surfacing.
  }
}

/**
 * The one line worth printing, or null.
 *
 * Only local edits are worth a word: those are the files we deliberately did
 * NOT refresh, so the user is now running an engine whose playbook they have
 * diverged from. A silent stale-file refresh is the system working.
 */
export function formatAutoSyncNotice(result: SkillsAutoSyncResult): string | null {
  if (!result.ran || result.conflicts.length === 0) return null
  const count = result.conflicts.length
  return `canonry: ${count} locally edited skill file${count === 1 ? '' : 's'} kept as-is `
    + `(engine is now v${PACKAGE_VERSION}). Run "canonry skills install --force" to take the new version.`
}
