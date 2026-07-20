import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

/**
 * Structural invariants for `MIGRATION_VERSIONS`.
 *
 * The migrator skips anything at or below the recorded `MAX(version)`
 * (`getAppliedVersion`), so a duplicate or out-of-order version does not error — it
 * silently never runs on an upgrading install while looking fine on a fresh one. That
 * failure mode is invisible to a shape-only test, which is why these assertions exist
 * rather than a "the list equals itself" comparison.
 *
 * AGENTS.md → "Database Schema Changes" rule 5 states the rule these enforce:
 * "duplicate or out-of-order `version` values break the skip-already-applied logic".
 */

/**
 * Version numbers deliberately absent from the list, each with the reason it is
 * reserved. Anything else missing is a mistake, and an entry here that has stopped
 * being a gap is stale — both fail.
 */
const JUSTIFIED_GAPS: ReadonlyArray<{ versions: number[]; reason: string }> = [
  // Empty on purpose. The list is contiguous today: 99-103 (the ads-operator
  // migrations) were reserved here while they were still only on main, and this
  // branch's migrations were renumbered to 104/105 so they land ABOVE them.
  // Merging main brought 99-103 into MIGRATION_VERSIONS, so the reservation is
  // no longer a gap and the stale-entry check below correctly demanded it go.
  // Add an entry back only when a version is genuinely reserved-but-absent.
]

/** Every problem with a candidate version list, as human-readable strings. */
function findVersionProblems(
  versions: ReadonlyArray<{ version: number; name: string }>,
  justifiedGaps: ReadonlyArray<{ versions: number[]; reason: string }> = JUSTIFIED_GAPS,
): string[] {
  const problems: string[] = []

  const seenVersions = new Map<number, string>()
  const seenNames = new Map<string, number>()
  for (const mv of versions) {
    const dupeOf = seenVersions.get(mv.version)
    if (dupeOf !== undefined) {
      problems.push(`duplicate version ${mv.version}: "${dupeOf}" and "${mv.name}"`)
    }
    seenVersions.set(mv.version, mv.name)

    const nameDupeOf = seenNames.get(mv.name)
    if (nameDupeOf !== undefined) {
      problems.push(`duplicate name "${mv.name}": versions ${nameDupeOf} and ${mv.version}`)
    }
    seenNames.set(mv.name, mv.version)
  }

  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1]
    const cur = versions[i]
    if (cur.version <= prev.version) {
      problems.push(
        `out-of-order: "${cur.name}" (v${cur.version}) is declared after ` +
          `"${prev.name}" (v${prev.version}); versions must strictly increase in list order`,
      )
    }
  }

  const reserved = new Set(justifiedGaps.flatMap((g) => g.versions))
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1].version
    const cur = versions[i].version
    for (let missing = prev + 1; missing < cur; missing++) {
      if (!reserved.has(missing)) {
        problems.push(
          `unjustified gap: version ${missing} is missing between v${prev} and v${cur}. ` +
            'Either use it, or add it to JUSTIFIED_GAPS with the reason it is reserved.',
        )
      }
    }
  }

  const present = new Set(versions.map((mv) => mv.version))
  for (const gap of justifiedGaps) {
    for (const v of gap.versions) {
      if (present.has(v)) {
        problems.push(
          `stale JUSTIFIED_GAPS entry: version ${v} is now present in the list, ` +
            'so it is no longer a gap — remove it from JUSTIFIED_GAPS.',
        )
      }
    }
  }

  return problems
}

function freshDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  return { db: createClient(dbPath), dbPath }
}

function recordedVersions(dbPath: string): Array<{ version: number; name: string }> {
  const sqlite = new Database(dbPath, { readonly: true })
  try {
    return sqlite
      .prepare('SELECT version, name FROM _migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>
  } finally {
    sqlite.close()
  }
}

// --- the real list ---

test('MIGRATION_VERSIONS versions are unique, strictly increasing, and contiguous or justified', () => {
  expect(findVersionProblems(MIGRATION_VERSIONS)).toEqual([])
})

// --- the checker itself fails loudly (a test that passes on everything is not a test) ---

test('the invariant check rejects a duplicate version', () => {
  const problems = findVersionProblems([
    { version: 104, name: 'project-provider-models' },
    { version: 104, name: 'query-snapshot-served-model' },
  ])
  expect(problems.some((p) => /duplicate version 104/.test(p))).toBe(true)
})

test('the invariant check rejects a duplicate migration name', () => {
  const problems = findVersionProblems([
    { version: 104, name: 'query-snapshot-served-model' },
    { version: 105, name: 'query-snapshot-served-model' },
  ])
  expect(problems.some((p) => /duplicate name "query-snapshot-served-model"/.test(p))).toBe(true)
})

test('the invariant check rejects an out-of-order version', () => {
  // The exact shape a renumber-gone-wrong produces: v104 lands before v98, so on any
  // install already at 104 the migrator's `version <= appliedVersion` skip drops it.
  const problems = findVersionProblems([
    { version: 104, name: 'project-provider-models' },
    { version: 98, name: 'relink-orphaned-snapshot-query-ids' },
  ])
  expect(problems.some((p) => /out-of-order/.test(p))).toBe(true)
})

test('the invariant check rejects an unjustified gap but accepts a justified one', () => {
  const withUnjustifiedGap = [
    { version: 104, name: 'a' },
    { version: 108, name: 'b' },
  ]
  expect(findVersionProblems(withUnjustifiedGap)).toEqual([
    expect.stringMatching(/unjustified gap: version 105/),
    expect.stringMatching(/unjustified gap: version 106/),
    expect.stringMatching(/unjustified gap: version 107/),
  ])

  expect(
    findVersionProblems(withUnjustifiedGap, [
      { versions: [105, 106, 107], reason: 'reserved in this hypothetical' },
    ]),
  ).toEqual([])
})

test('the invariant check flags a JUSTIFIED_GAPS entry that is no longer a gap', () => {
  const problems = findVersionProblems(
    [
      { version: 104, name: 'a' },
      { version: 105, name: 'b' },
    ],
    [{ versions: [105], reason: 'stale — 105 is right there' }],
  )
  expect(problems).toEqual([expect.stringMatching(/stale JUSTIFIED_GAPS entry: version 105/)])
})

// --- the list matches what migrate() actually executes ---

test('a fresh migrate() records every declared version, in declared order, and nothing else', () => {
  const { db, dbPath } = freshDb('canonry-migration-invariants-fresh-')
  migrate(db)

  const recorded = recordedVersions(dbPath)

  // Same count: no version silently skipped, no extra row invented.
  expect(recorded).toHaveLength(MIGRATION_VERSIONS.length)
  expect(recorded.map((r) => r.version)).toEqual(MIGRATION_VERSIONS.map((mv) => mv.version))
  expect(recorded.map((r) => r.name)).toEqual(MIGRATION_VERSIONS.map((mv) => mv.name))

  // `ORDER BY version` above is a numeric sort, so this equality also proves the
  // declared order IS ascending order — the same property the structural check asserts.
  const maxVersion = Math.max(...recorded.map((r) => r.version))
  expect(maxVersion).toBe(MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1].version)
})

test('an upgrading migrate() applies exactly the versions above the recorded maximum', () => {
  // The path where an out-of-order version disappears: `getAppliedVersion` is read
  // once, and everything at or below it is skipped. Boot an "older binary" that stops
  // at 98, then boot the current list over it.
  const BASELINE = 98
  const { db, dbPath } = freshDb('canonry-migration-invariants-upgrade-')

  const older = MIGRATION_VERSIONS.filter((mv) => mv.version <= BASELINE)
  migrate(db, older)
  expect(recordedVersions(dbPath).map((r) => r.version)).toEqual(older.map((mv) => mv.version))

  migrate(db)

  const recorded = recordedVersions(dbPath)
  expect(recorded.map((r) => r.version)).toEqual(MIGRATION_VERSIONS.map((mv) => mv.version))

  const newlyApplied = recorded.filter((r) => r.version > BASELINE)
  expect(newlyApplied.map((r) => r.name)).toEqual(
    MIGRATION_VERSIONS.filter((mv) => mv.version > BASELINE).map((mv) => mv.name),
  )
  // Concretely: the two versions this branch adds must both have landed.
  expect(newlyApplied.map((r) => r.version)).toContain(104)
  expect(newlyApplied.map((r) => r.version)).toContain(105)
})

test('a version renumbered below the recorded maximum is silently skipped — why order matters', () => {
  // Not a wish: this executes the exact mistake the invariants forbid and shows the
  // consequence, so nobody has to take the rule on faith.
  const BASELINE = 98
  const { db, dbPath } = freshDb('canonry-migration-invariants-skip-')

  migrate(db, MIGRATION_VERSIONS.filter((mv) => mv.version <= BASELINE))

  // A release that shipped 105 lands first and the install records it.
  migrate(db, MIGRATION_VERSIONS.filter((mv) => mv.version <= BASELINE || mv.version === 105))
  expect(recordedVersions(dbPath).map((r) => r.version)).toContain(105)

  // A later release reverts this branch's 104 back to its original v99. The list is
  // now out of order, which the structural check catches...
  const renumbered = MIGRATION_VERSIONS.filter(
    (mv) => mv.version <= BASELINE || mv.version === 105,
  ).concat(MIGRATION_VERSIONS.filter((mv) => mv.version === 104).map((mv) => ({ ...mv, version: 99 })))
  expect(findVersionProblems(renumbered).some((p) => /out-of-order/.test(p))).toBe(true)

  // ...and here is the consequence it is catching: migrate() throws no error, reports
  // no problem, and simply never runs v99, because 99 <= the recorded max of 105.
  migrate(db, renumbered)

  const recorded = recordedVersions(dbPath).map((r) => r.version)
  expect(recorded).toContain(105)
  expect(recorded).not.toContain(99)
})
