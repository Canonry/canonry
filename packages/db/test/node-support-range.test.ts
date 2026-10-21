import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test, expect, describe } from 'vitest'
import { parse as parseYaml, parseAllDocuments } from 'yaml'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '..', '..', '..')

// Independent security-release policy: do not derive these minimums from the
// manifest or guard being checked. Native loading is exercised by the DB suite
// on each CI release line; the scheduled tarball check owns platform coverage.
const SUPPORTED_FLOORS = ['22.23.4', '24.22.1', '26.12.1']
const DEPLOY_VERSION = '26.12.1'

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8')
}

function declaredNodeRange(...segments: string[]): string {
  const pkg = JSON.parse(readRepoFile(...segments)) as { engines?: { node?: string } }
  if (!pkg.engines?.node) throw new Error(`${segments.join('/')} declares no engines.node`)
  return pkg.engines.node
}

function installedBetterSqlite3(): { version: string; engines: { node: string } } {
  return JSON.parse(fs.readFileSync(require.resolve('better-sqlite3/package.json'), 'utf8')) as {
    version: string
    engines: { node: string }
  }
}

function lockfileBetterSqlite3Version(): string {
  const documents = parseAllDocuments(readRepoFile('pnpm-lock.yaml'))
  const prefix = 'better-sqlite3@'
  const versions = [...new Set(documents.flatMap((document) => {
    if (document.errors.length) throw document.errors[0]!
    const lock = document.toJSON() as { packages?: Record<string, unknown> } | null
    return Object.keys(lock?.packages ?? {})
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }))]
  if (versions.length !== 1) {
    throw new Error(`expected exactly one better-sqlite3 in pnpm-lock.yaml, found: ${versions.join(', ')}`)
  }
  return versions[0]!
}

function runNodeGuard(version: string, skip = '') {
  // Exercise the shipped entry point in a child, without exporting its parser
  // or adding a fake-version option to production. CI supplies real runtimes.
  const guardUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'check-node.mjs')).href
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
    await import(${JSON.stringify(guardUrl)});
  `], {
    encoding: 'utf8',
    env: { ...process.env, CANONRY_SKIP_NODE_CHECK: skip },
    timeout: 10_000,
  })
}

interface CiStep {
  uses?: string
  with?: Record<string, unknown>
  run?: string
}

interface CiJob {
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } }
  steps?: CiStep[]
}

function testShardsJob(): CiJob {
  const workflow = parseYaml(readRepoFile('.github', 'workflows', 'ci.yml')) as {
    jobs?: Record<string, CiJob>
  }
  const job = workflow.jobs?.test_shards
  if (!job) throw new Error('.github/workflows/ci.yml declares no `test_shards` job')
  return job
}

function ciMatrixShards(): Array<{ version: string; index: number; total: number }> {
  const include = testShardsJob().strategy?.matrix?.include
  if (!include?.length) throw new Error('`test_shards` declares no matrix include entries')

  return include.map((entry) => {
    const version = String(entry.node)
    const shard = /^(\d+)\/(\d+)$/.exec(String(entry.shard))
    if (!/^\d+\.\d+\.\d+$/.test(version) || !shard) {
      throw new Error(`invalid test-shard matrix entry: ${JSON.stringify(entry)}`)
    }
    const index = Number(shard[1])
    const total = Number(shard[2])
    if (index < 1 || total < index) {
      throw new Error(`invalid shard ${String(entry.shard)} for Node ${version}`)
    }
    return { version, index, total }
  })
}

describe('Node support range', () => {
  test('the installed better-sqlite3 matches the lockfile', () => {
    const locked = lockfileBetterSqlite3Version()
    const { version } = installedBetterSqlite3()
    expect(
      version,
      `node_modules has better-sqlite3 ${version} but the lockfile pins ${locked}; run pnpm install`,
    ).toBe(locked)
  })

  test('workspace and published engines require patched, bounded release lines', () => {
    const expected = '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27'
    expect(declaredNodeRange('package.json')).toBe(expected)
    expect(declaredNodeRange('packages', 'canonry', 'package.json')).toBe(expected)
  })

  test.each(SUPPORTED_FLOORS.flatMap((floor) => {
    const [major, minor, patch] = floor.split('.').map(Number)
    return [floor, `${major}.${minor}.${patch! + 1}`, `${major}.${minor! + 1}.0`, `${major}.999.999`]
  }))('the install guard accepts supported Node %s without output', (version) => {
    const result = runNodeGuard(version)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  test.each([
    '20.0.0', '21.0.0', '22.22.99', '22.23.3', '23.0.0',
    '24.21.99', '24.22.0', '25.0.0', '26.11.99', '26.12.0', '27.0.0', '28.0.0',
    '26.13.0-nightly.20261022',
  ])('the install guard rejects unpatched or unsupported Node %s', (version) => {
    const result = runNodeGuard(version)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`Node ${version} is unsupported`)
    expect(result.stderr).toContain(declaredNodeRange('package.json'))
    expect(result.stderr).toContain('nvm use')
  })

  test.each([
    { skip: '1', status: 0, warns: true },
    { skip: '0', status: 1, warns: false },
  ])('unsupported runtime override $skip exits $status and reports its policy', ({ skip, status, warns }) => {
    const result = runNodeGuard('27.0.0', skip)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(status)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Node 27.0.0 is unsupported')
    expect(result.stderr.includes('Continuing because CANONRY_SKIP_NODE_CHECK=1')).toBe(warns)
  })

  test('each supported release line meets SQLite and agent runtime engine floors', () => {
    const dependencies = [
      { name: 'better-sqlite3', range: installedBetterSqlite3().engines.node },
      ...['pi-ai', 'pi-agent-core'].map((name) => ({
        name,
        range: declaredNodeRange('packages', 'canonry', 'node_modules', '@earendil-works', name, 'package.json'),
      })),
    ]
    for (const { name, range } of dependencies) {
      // Reject a changed range grammar for review instead of overlooking a
      // new upper bound or an excluded release line in the dependency.
      const match = /^>=\s*(\d+)(?:\.(\d+)\.(\d+))?$/.exec(range)
      expect(match, `${name} engines.node: ${range}`).not.toBeNull()
      const required = [Number(match![1]), Number(match![2] ?? 0), Number(match![3] ?? 0)]
      for (const floor of SUPPORTED_FLOORS) {
        const current = floor.split('.').map(Number)
        const difference = current[0]! - required[0]! || current[1]! - required[1]! || current[2]! - required[2]!
        expect(difference, `${name} requires ${range}; Canonry supports ${floor}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('developer, CI default, and Docker runtimes pin the patched deployment version', () => {
    for (const file of ['.nvmrc', '.node-version']) expect(readRepoFile(file).trim()).toBe(DEPLOY_VERSION)
    const setup = parseYaml(readRepoFile('.github', 'actions', 'setup', 'action.yml')) as {
      inputs?: Record<string, { default?: string }>
    }
    expect(setup.inputs?.['node-version']?.default).toBe(DEPLOY_VERSION)
    for (const dockerfile of ['Dockerfile', 'Dockerfile.api', 'Dockerfile.worker', 'Dockerfile.web']) {
      const tags = [...readRepoFile(dockerfile).matchAll(/^FROM (?:\S*\/)?node:(\S+)(?:\s|$)/gm)]
        .map((match) => match[1])
      expect(tags.length, `${dockerfile} has no Node base`).toBeGreaterThan(0)
      for (const tag of tags) {
        const [version, digest] = tag!.split('@')
        expect(version, dockerfile).toBe(`${DEPLOY_VERSION}-bookworm-slim`)
        expect(digest, dockerfile).toMatch(/^sha256:[a-f0-9]{64}$/)
      }
    }
  })

  test('CI runs every shard at the minimum of every supported release line', () => {
    const byVersion = new Map<string, Array<{ index: number; total: number }>>()
    for (const { version, index, total } of ciMatrixShards()) {
      const shards = byVersion.get(version) ?? []
      shards.push({ index, total })
      byVersion.set(version, shards)
    }
    expect([...byVersion.keys()].sort()).toEqual([...SUPPORTED_FLOORS].sort())
    for (const [version, shards] of byVersion) {
      const totals = [...new Set(shards.map((shard) => shard.total))]
      expect(totals, `Node ${version} has inconsistent shard totals`).toHaveLength(1)
      expect(
        shards.map((shard) => shard.index).sort((a, b) => a - b),
        `Node ${version} is missing or duplicating a shard`,
      ).toEqual(Array.from({ length: totals[0]! }, (_, index) => index + 1))
    }
  })

  test('the CI job installs its matrix runtime and executes its shard of the suite', () => {
    const steps = testShardsJob().steps ?? []
    const setup = steps.find((step) => step.uses === './.github/actions/setup')
    expect(setup?.with?.['node-version']).toBe('${{ matrix.node }}')
    const commands = steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toMatch(/pnpm\s+run\s+test\s[^\n]*--shard=\$\{\{\s*matrix\.shard\s*\}\}/)
  })
})
