import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, describe } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * `scripts/check-node.mjs` blocks an install on a Node major that `better-sqlite3`
 * has no prebuilt binary for, converting a couple hundred lines of node-gyp C++
 * output into one legible line.
 *
 * So the compatible subset is asserted rather than trusted.
 *
 * WHY `engines.node` IS NOT THE SOURCE OF TRUTH
 * This file used to hardcode `< 26` in three places, which made the guard and
 * the test agree with each other while both disagreed with reality. The obvious
 * correction — derive everything from better-sqlite3's `engines.node` — is
 * wrong in the other direction, because that field is a SUPERSET of what
 * actually ships a binary. 12.11.1 declares
 * `20.x || 22.x || 23.x || 24.x || 25.x || 26.x` while shipping prebuilds for
 * ABI 127/137/141/147 only, i.e. Node 22/24/25/26: 12.10.0 added Node 26 and
 * dropped the EOL Node 20 and 23 builds in the same release without touching
 * `engines`. Deriving from it would promise Node 23 an install it cannot
 * deliver.
 *
 * Prebuild coverage therefore lives in `PREBUILT_MAJORS`, keyed by the exact
 * dependency version it was verified against. A bump to an unlisted version
 * fails with an explicit message instead of silently inheriting a stale answer.
 *
 * WIDENING IS NOT ENOUGH ON ITS OWN
 * Claiming a major nothing runs is the same mistake pointed the other way, so
 * the last tests assert the CI matrix actually exercises the highest supported
 * major, and that the job in question really runs the suite.
 */

const require = createRequire(import.meta.url)

/** Canonry's own floor, independent of what the native dep supports. */
const CANONRY_MIN_MAJOR = 22

/** The major the Docker images pin. */
const DEPLOY_MAJOR = 22

/**
 * Node majors each better-sqlite3 release ships a PREBUILT binary for.
 *
 * Verified against the release assets, which are named
 * `better-sqlite3-v<version>-node-v<abi>-<platform>-<arch>.tar.gz`; the ABI
 * maps to a Node major (127→22, 131→23, 137→24, 141→25, 147→26).
 *
 * Do NOT populate this from `engines.node` — see the note above. Re-verify on
 * every better-sqlite3 upgrade; that is exactly what this table is for.
 */
const PREBUILT_MAJORS: Record<string, number[]> = {
  // v12.11.1 assets: ABI 127, 137, 141, 147 (no 131 — Node 23 was dropped in 12.10.0).
  '12.11.1': [22, 24, 25, 26],
}

function repoRoot(): string {
  // packages/db/test -> repo root
  return path.resolve(__dirname, '..', '..', '..')
}

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot(), ...segments), 'utf8')
}

function guardMajors(): number[] {
  const source = readRepoFile('scripts', 'check-node.mjs')
  const match = /const SUPPORTED_MAJORS = \[([^\]]*)\]/.exec(source)
  if (!match) throw new Error('SUPPORTED_MAJORS not found in scripts/check-node.mjs')
  return match[1]!
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

function installedBetterSqlite3(): { version: string; enginesMajors: number[] } {
  const pkgPath = require.resolve('better-sqlite3/package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    version?: string
    engines?: { node?: string }
  }
  const range = pkg.engines?.node
  if (!range) throw new Error('better-sqlite3 declares no engines.node')
  if (!pkg.version) throw new Error('better-sqlite3 declares no version')
  return {
    version: pkg.version,
    // e.g. "20.x || 22.x || 23.x || 24.x || 25.x || 26.x"
    enginesMajors: range
      .split('||')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b),
  }
}

/** Majors the INSTALLED better-sqlite3 ships a prebuilt binary for. */
function prebuiltMajors(): number[] {
  const { version } = installedBetterSqlite3()
  const majors = PREBUILT_MAJORS[version]
  if (!majors) {
    throw new Error(
      `better-sqlite3 ${version} has no PREBUILT_MAJORS entry. Check that release's ` +
        'assets for which node-v<abi> builds it ships and add them here. Do not copy ' +
        'engines.node — it lists majors with no binary.',
    )
  }
  return [...majors].sort((a, b) => a - b)
}

/**
 * The version `pnpm-lock.yaml` resolves better-sqlite3 to.
 *
 * Everything above reads the INSTALLED copy via `require.resolve`, so a
 * `node_modules` that has drifted from the lockfile makes this whole file
 * self-consistent about the wrong dependency — green, while describing a
 * version the repo does not ship. Observed during review: a tree still on
 * 12.6.2 with the lockfile already at 12.11.1, so `PREBUILT_MAJORS` was never
 * consulted for the version CI actually installs.
 *
 * Parsed, not pattern-matched: the resolved version is a `packages:` KEY, and a
 * loose scan also hits the `@types/better-sqlite3` entries and the peer suffixes
 * on `drizzle-orm@…(better-sqlite3@…)`.
 */
function lockfileBetterSqlite3Version(): string {
  const lock = parseYaml(readRepoFile('pnpm-lock.yaml')) as {
    packages?: Record<string, unknown>
  }
  const prefix = 'better-sqlite3@'
  const versions = Object.keys(lock.packages ?? {})
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
  if (versions.length !== 1) {
    throw new Error(
      `expected exactly one better-sqlite3 in pnpm-lock.yaml, found ${versions.length}` +
        (versions.length ? `: ${versions.join(', ')}` : ''),
    )
  }
  return versions[0]!
}

interface CiJob {
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } }
  steps?: Array<{ run?: string }>
}

/**
 * The CI job that installs a Node major and runs the suite on it.
 *
 * Parsed as YAML, not scanned as text: a regex over the raw file cannot tell a
 * live matrix entry from a commented-out one, cannot tell this job's `node:`
 * key from any other job's, and cannot see whether the job runs the tests at
 * all — so it would keep passing in exactly the cases this guard exists to
 * catch.
 */
function testShardsJob(): CiJob {
  const workflow = parseYaml(readRepoFile('.github', 'workflows', 'ci.yml')) as {
    jobs?: Record<string, CiJob>
  }
  const job = workflow.jobs?.test_shards
  if (!job) throw new Error('.github/workflows/ci.yml declares no `test_shards` job')
  return job
}

/**
 * Distinct Node majors the CI test matrix actually installs and runs on.
 *
 * The entries are deliberately asymmetric (Node 22 sharded 4x, the highest
 * major 2x) to balance feedback time and runner cost, so this counts DISTINCT
 * majors and says nothing about how each one is split.
 */
function ciMatrixMajors(): number[] {
  const include = testShardsJob().strategy?.matrix?.include
  if (!include?.length) throw new Error('`test_shards` declares no matrix include entries')
  const majors = include
    .map((entry) => Number.parseInt(String(entry.node), 10))
    .filter((n) => Number.isFinite(n))
  if (majors.length === 0) throw new Error('no `node:` keys in the test_shards matrix')
  return [...new Set(majors)].sort((a, b) => a - b)
}

function ciMatrixShards(): Array<{ major: number; index: number; total: number }> {
  const include = testShardsJob().strategy?.matrix?.include
  if (!include?.length) throw new Error('`test_shards` declares no matrix include entries')

  return include.map((entry) => {
    const major = Number.parseInt(String(entry.node), 10)
    const shard = /^(\d+)\/(\d+)$/.exec(String(entry.shard))
    if (!Number.isFinite(major) || !shard) {
      throw new Error(`invalid test-shard matrix entry: ${JSON.stringify(entry)}`)
    }
    const index = Number.parseInt(shard[1]!, 10)
    const total = Number.parseInt(shard[2]!, 10)
    if (index < 1 || total < index) {
      throw new Error(`invalid shard ${String(entry.shard)} for Node ${major}`)
    }
    return { major, index, total }
  })
}

function declaredEnginesCeiling(pkgRelPath: string[]): { declared: string; ceiling: number } {
  const pkg = JSON.parse(readRepoFile(...pkgRelPath)) as { engines?: { node?: string } }
  const declared = pkg.engines?.node ?? ''
  return { declared, ceiling: Number.parseInt(/<\s*(\d+)/.exec(declared)?.[1] ?? '0', 10) }
}

describe('Node support range', () => {
  test('the installed better-sqlite3 matches the lockfile', () => {
    // Runs FIRST because every other assertion here is only as true as this
    // one: they all describe the installed copy.
    const locked = lockfileBetterSqlite3Version()
    const { version } = installedBetterSqlite3()
    expect(
      version,
      `node_modules has better-sqlite3 ${version} but the lockfile pins ${locked}. ` +
        'Run `pnpm install` — until then this file is asserting against a ' +
        'dependency the repo does not ship.',
    ).toBe(locked)
  })

  test('the install guard matches the prebuilt majors at or above Canonry floor', () => {
    // Derived from prebuild coverage, not from engines.node. A dependency bump
    // that adds OR drops a prebuilt major fails here.
    const expected = prebuiltMajors().filter((major) => major >= CANONRY_MIN_MAJOR)
    expect(guardMajors()).toEqual(expected)
  })

  test('the prebuilt table never claims a major better-sqlite3 does not support', () => {
    // The table is hand-maintained, so bound it by the dep's own declared
    // range: engines.node is a superset of the prebuilds, never a subset. A
    // typo'd or invented major fails here rather than widening the guard.
    const { enginesMajors } = installedBetterSqlite3()
    for (const major of prebuiltMajors()) expect(enginesMajors).toContain(major)
  })

  test('the guard and declared engine range enforce Node 22+', () => {
    const majors = guardMajors()
    expect(majors).toContain(CANONRY_MIN_MAJOR)
    expect(majors).not.toContain(20)

    // The ceiling is exclusive, so it must sit exactly one past the highest
    // supported major — never a literal that can rot.
    const expectedCeiling = Math.max(...majors) + 1
    const root = declaredEnginesCeiling(['package.json'])
    const published = declaredEnginesCeiling(['packages', 'canonry', 'package.json'])

    // 22.19 is the floor Aero's agent runtime declares (see the next test).
    expect(root.declared).toBe(`>=${CANONRY_MIN_MAJOR}.19.0 <${expectedCeiling}`)
    expect(published.declared).toBe(root.declared)
  })

  test('the declared floor is at least what the pi agent runtime requires', () => {
    // @earendil-works/pi-ai and pi-agent-core declare their own Node floor; a
    // pi upgrade that raises it must raise Canonry's too, or installs between
    // the two floors run an unsupported runtime.
    const floor = (range: string): number[] => (/>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range)?.slice(1) ?? []).map(Number)
    const atLeast = (a: number[], b: number[]): boolean =>
      a[0] !== b[0] ? a[0]! > b[0]! : a[1] !== b[1] ? a[1]! > b[1]! : a[2]! >= b[2]!
    const canonry = floor(declaredEnginesCeiling(['packages', 'canonry', 'package.json']).declared)
    expect(canonry).toHaveLength(3)
    for (const name of ['pi-ai', 'pi-agent-core']) {
      const pkg = JSON.parse(readRepoFile('packages', 'canonry', 'node_modules', '@earendil-works', name, 'package.json')) as { engines?: { node?: string } }
      const pi = floor(pkg.engines?.node ?? '')
      expect(pi, `${name} engines.node`).toHaveLength(3)
      expect(atLeast(canonry, pi), `${name} needs node ${pkg.engines?.node}`).toBe(true)
    }
  })

  test('every Dockerfile uses the Node 22 base', () => {
    // Deliberately still pinned while the supported range is wider: widening
    // what a CONTRIBUTOR may use must not quietly move what ships.
    for (const dockerfile of ['Dockerfile', 'Dockerfile.api', 'Dockerfile.worker', 'Dockerfile.web']) {
      const source = readRepoFile(dockerfile)
      const majors = [...source.matchAll(/^FROM .*node:(\d+)-bookworm-slim(?:\s|$)/gm)].map(
        (match) => Number.parseInt(match[1]!, 10),
      )
      expect(majors.length).toBeGreaterThan(0)
      expect(majors.every((major) => major === DEPLOY_MAJOR)).toBe(true)
    }
  })

  test('the declared engines range does not promise more than the guard allows', () => {
    // An unbounded `>=X` range asserts that every FUTURE major is supported,
    // which is exactly the claim that misled the install. Require a ceiling.
    const { declared, ceiling } = declaredEnginesCeiling(['package.json'])
    expect(declared).toMatch(/<\s*\d+/)
    expect(ceiling).toBeGreaterThan(Math.max(...guardMajors()))
  })

  test('CI runs the suite on the deploy major and the highest supported major', () => {
    // Support has to be earned, not declared. Without this, widening
    // SUPPORTED_MAJORS silently promises a major nothing ever runs — the same
    // unevidenced claim as the stale ceiling, just in the opposite direction.
    const ci = ciMatrixMajors()
    const highest = Math.max(...guardMajors())

    expect(ci).toContain(DEPLOY_MAJOR)
    expect(ci).toContain(highest)
    // And CI must not claim to test a major the guard refuses to install on.
    for (const major of ci) expect(guardMajors()).toContain(major)
  })

  test('every CI Node major covers every shard it declares', () => {
    // A matrix entry for Node 26 is not enough: `1/2` alone would test the
    // major but silently sample only half its suite. Each major must include
    // every member of one complete Vitest shard partition.
    const byMajor = new Map<number, Array<{ index: number; total: number }>>()
    for (const { major, index, total } of ciMatrixShards()) {
      const shards = byMajor.get(major) ?? []
      shards.push({ index, total })
      byMajor.set(major, shards)
    }

    for (const [major, shards] of byMajor) {
      const totals = [...new Set(shards.map((shard) => shard.total))]
      expect(totals, `Node ${major} has inconsistent shard totals`).toHaveLength(1)
      const total = totals[0]!
      expect(
        shards.map((shard) => shard.index).sort((a, b) => a - b),
        `Node ${major} is missing or duplicating a shard`,
      ).toEqual(Array.from({ length: total }, (_, index) => index + 1))
    }
  })

  test('the matrix job actually runs the test suite', () => {
    // A matrix that lists a major but never runs the tests on it is the same
    // empty claim. Assert the job's steps invoke the suite.
    const steps = testShardsJob().steps ?? []
    const commands = steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toMatch(/pnpm\s+run\s+test/)
  })
})
