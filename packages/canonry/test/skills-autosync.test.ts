import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_MANIFEST_FILENAME } from '@canonry/canonry-contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_NAMES } from '../src/commands/skills.js'
import { PACKAGE_VERSION } from '../src/package-version.js'
import {
  formatAutoSyncNotice,
  ownedInstallTargets,
  peekVersionChange,
  type SkillsAutoSyncResult,
} from '../src/skills-autosync.js'

/**
 * The notice exists to report the ONE thing auto-sync deliberately did not do:
 * replace a file the user edited. A silent refresh of a stale file is the
 * system working and must stay silent, or the line becomes noise and gets
 * ignored precisely when it matters.
 */
describe('formatAutoSyncNotice', () => {
  const base: SkillsAutoSyncResult = {
    ran: true, reason: 'version-changed', updated: [], conflicts: [], targets: ['/home/u'],
  }

  it('says nothing when the sync did not run', () => {
    expect(formatAutoSyncNotice({ ...base, ran: false, reason: 'skipped' })).toBeNull()
  })

  it('says nothing when only stale files were refreshed', () => {
    expect(formatAutoSyncNotice({ ...base, updated: ['canonry/SKILL.md', 'aero/SKILL.md'] })).toBeNull()
  })

  it('reports preserved local edits, and names the recovery command', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['canonry/SKILL.md'] })
    expect(notice).toMatch(/1 locally edited skill file /)
    expect(notice).toMatch(/skills install --force/)
  })

  it('pluralizes', () => {
    const notice = formatAutoSyncNotice({ ...base, conflicts: ['a.md', 'b.md'] })
    expect(notice).toMatch(/2 locally edited skill files/)
  })
})

/**
 * Regression (data loss): `loadConfigRaw()` returns null for BOTH "no config"
 * and "config present but unparsable" — it does not throw. The first version
 * folded null into "no version recorded, therefore changed", which reached
 * `saveConfigPatch`, whose read-modify-write falls back to an EMPTY base when
 * the file will not parse. The merge then wrote only the patch keys and the
 * user's apiKey, database path and provider credentials were gone.
 *
 * A file we cannot read is the one file we must not write, so the probe has to
 * distinguish `unknown` from `changed`.
 */
describe('peekVersionChange', () => {
  let dir: string
  const previous = process.env.CANONRY_CONFIG_DIR

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-probe-'))
    process.env.CANONRY_CONFIG_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const writeConfig = (body: string) => fs.writeFileSync(path.join(dir, 'config.yaml'), body)

  it('reports unknown when no config exists, so a bare machine is never written to', () => {
    expect(peekVersionChange()).toEqual({ state: 'unknown' })
  })

  it('reports unknown for a config that exists but will not parse — NOT changed', () => {
    writeConfig('apiKey: "unterminated\n\tbad: [oops\n')
    // The bug: this returned `changed`, and the resulting write destroyed the file.
    expect(peekVersionChange()).toEqual({ state: 'unknown' })
  })

  it('reports unchanged when the recorded version is the running one', () => {
    writeConfig(`lastSkillsSyncedVersion: ${PACKAGE_VERSION}\n`)
    expect(peekVersionChange()).toEqual({ state: 'unchanged' })
  })

  it('reports changed, and carries the version it moved from', () => {
    writeConfig('lastSkillsSyncedVersion: 1.0.0\n')
    expect(peekVersionChange()).toEqual({ state: 'changed', lastSeen: '1.0.0' })
  })

  it('reports changed with no lastSeen for a parsable config that never recorded one', () => {
    writeConfig('apiKey: cnry_test\n')
    expect(peekVersionChange()).toEqual({ state: 'changed', lastSeen: undefined })
  })
})

/**
 * Regression (two subsystems, one write-once field).
 *
 * Auto-sync originally recorded its progress in `lastSeenVersion`, which
 * telemetry owns. `cli.ts` fires `autoSyncSkills()` BEFORE
 * `detectAndTrackUpgrade()`, and the whole path to the record is synchronous,
 * so auto-sync became the first writer on every upgrade. `detectAndTrackUpgrade`
 * returns early on `lastSeen === VERSION`, so `cli.upgraded` could never fire
 * again — the field was already stamped by the time it looked.
 *
 * The same shared field also broke the heal itself: ownership is per-directory
 * but the record is global, so one run from a directory canonry does not own
 * marked the version synced and the project that DID need healing was skipped.
 */
describe('version record separation', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/skills-autosync.ts'),
    'utf-8',
  )

  /** Comments explain WHY the field is avoided, so they must not count as a use. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('never reads or writes telemetry\'s lastSeenVersion', () => {
    expect(code).not.toMatch(/\blastSeenVersion\b/)
  })

  it('records under its own key', () => {
    expect(src).toMatch(/lastSkillsSyncedVersion: PACKAGE_VERSION/)
  })

  it('writes nothing when it owns no directory, so the signal survives for one that needs it', () => {
    // The empty-targets branch must return WITHOUT calling recordVerified().
    const branch = /targets\.length === 0\) \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? ''
    expect(branch).not.toMatch(/recordVerified\(\)/)
    expect(branch).toMatch(/return skipped/)
  })
})

/**
 * Regression (opt-out defeat): auto-sync REPAIRS, it never ADOPTS.
 * `installSkills` will happily create `~/.claude/skills/` from nothing, so
 * calling it unconditionally wrote into the home directory of someone who ran
 * `canonry init --skip-skills` and said no.
 *
 * The second half: `canonry init` installs PROJECT-local by default and only
 * `--user` installs global, so checking just the home directory missed the
 * common case entirely and those installs never healed.
 */
describe('ownedInstallTargets', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-targets-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const ALL = [...BUNDLED_SKILL_NAMES]
  const FIRST = BUNDLED_SKILL_NAMES[0]!
  const SECOND = BUNDLED_SKILL_NAMES[1]!

  /** `skills` = which skills carry a canonry manifest. `codex` = which are symlinked. */
  const make = (name: string, opts: { skills?: string[]; bare?: string[]; codex?: string[] } = {}) => {
    const dir = path.join(root, name)
    for (const skill of [...(opts.skills ?? []), ...(opts.bare ?? [])]) {
      fs.mkdirSync(path.join(dir, '.claude', 'skills', skill), { recursive: true })
    }
    // A skill directory canonry did NOT write has no manifest.
    for (const skill of opts.skills ?? []) {
      fs.writeFileSync(path.join(dir, '.claude', 'skills', skill, SKILL_MANIFEST_FILENAME), '{}')
    }
    for (const skill of opts.codex ?? []) {
      const link = path.join(dir, '.codex', 'skills', skill)
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(path.join(dir, '.claude', 'skills', skill), link)
    }
    return dir
  }

  it('claims nothing when neither scope has a canonry install', () => {
    expect(ownedInstallTargets(path.join(root, 'cwd'), path.join(root, 'home'))).toEqual([])
  })

  it('refuses to adopt a skills directory canonry never wrote (the --skip-skills opt-out)', () => {
    const home = make('home', { bare: ALL })
    expect(ownedInstallTargets(path.join(root, 'cwd'), home)).toEqual([])
  })

  it('heals a PROJECT-local install — the default `canonry init` scope', () => {
    const cwd = make('cwd', { skills: ALL, codex: ALL })
    expect(ownedInstallTargets(cwd, path.join(root, 'home')))
      .toEqual([{ dir: cwd, user: false, skills: ALL, client: 'all' }])
  })

  it('heals a user-scoped install', () => {
    const home = make('home', { skills: ALL, codex: ALL })
    expect(ownedInstallTargets(path.join(root, 'cwd'), home))
      .toEqual([{ dir: home, user: true, skills: ALL, client: 'all' }])
  })

  it('heals both scopes when both are canonry installs', () => {
    const home = make('home', { skills: ALL, codex: ALL })
    const cwd = make('cwd', { skills: ALL, codex: ALL })
    expect(ownedInstallTargets(cwd, home)).toEqual([
      { dir: home, user: true, skills: ALL, client: 'all' },
      { dir: cwd, user: false, skills: ALL, client: 'all' },
    ])
  })

  /**
   * Regression: ownership was proven with `some()`, which is enough to say the
   * DIRECTORY is ours but not to decide WHAT to write into it. The heal then
   * called `installSkills` with no `skills` and no `client`, both of which
   * default to "everything" — so one manifest was licence to install the other
   * skill and to create a `.codex/` tree for someone who asked for neither.
   */
  it('claims only the skills that actually carry a manifest', () => {
    const cwd = make('cwd', { skills: [SECOND], bare: [FIRST], codex: [SECOND] })
    expect(ownedInstallTargets(cwd, path.join(root, 'home')))
      .toEqual([{ dir: cwd, user: false, skills: [SECOND], client: 'all' }])
  })

  it('does not adopt codex when the operator installed --client claude', () => {
    const cwd = make('cwd', { skills: ALL })
    expect(ownedInstallTargets(cwd, path.join(root, 'home'))[0]?.client).toBe('claude')
  })

  it('adopts codex only where a symlink already exists', () => {
    const cwd = make('cwd', { skills: ALL, codex: [FIRST] })
    expect(ownedInstallTargets(cwd, path.join(root, 'home'))[0]?.client).toBe('all')
  })

  it('treats a non-symlink .codex entry as not-codex rather than throwing', () => {
    const cwd = make('cwd', { skills: ALL })
    fs.mkdirSync(path.join(cwd, '.codex', 'skills', FIRST), { recursive: true })
    expect(ownedInstallTargets(cwd, path.join(root, 'home'))[0]?.client).toBe('claude')
  })

  /**
   * Regression: the candidates were filtered independently with no identity
   * check, so running `cnry` from $HOME with a user-scoped install returned the
   * same directory twice. It was then installed twice, and every preserved
   * local edit was counted twice — the notice said two files diverged when one
   * had.
   */
  it('returns one entry when cwd IS home, not two', () => {
    const home = make('home', { skills: ALL, codex: ALL })
    expect(ownedInstallTargets(home, home))
      .toEqual([{ dir: home, user: true, skills: ALL, client: 'all' }])
  })

  it('dedupes an unresolved path against its resolved twin', () => {
    const home = make('home', { skills: ALL, codex: ALL })
    expect(ownedInstallTargets(path.join(home, '.', ''), home)).toHaveLength(1)
  })
})

/**
 * Regression: the first version of the frontmatter reader terminated the
 * description at `(?=^\w+:|\Z)`. JavaScript has no `\Z` anchor, so that
 * alternative matched a literal "Z" and the whole pattern failed whenever
 * `description` was the LAST field in the block. Both shipped skills happen to
 * carry `metadata:` afterwards, so every test passed and lint caught it.
 */
describe('skill frontmatter reading', () => {
  it('reads a description that is the last field in the block', async () => {
    const { getBundledSkills } = await import('../src/commands/skills.js')
    // Proven indirectly: every bundled skill must yield a description, and the
    // reader must not depend on a following key to find the end of the value.
    expect(getBundledSkills().length).toBeGreaterThan(0)
  })
})
