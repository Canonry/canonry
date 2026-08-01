import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, describe } from 'vitest'

/**
 * `scripts/check-node.mjs` blocks an install on a Node major that `better-sqlite3`
 * has no prebuilt binary for, converting a couple hundred lines of node-gyp C++
 * output into one legible line.
 *
 * Its `SUPPORTED_MAJORS` list applies Canonry's Node 22+ policy to
 * better-sqlite3's own `engines.node`. A dependency bump that narrows that range
 * would otherwise leave the guard silently wrong and hand the reader back the
 * node-gyp wall of text the guard exists to prevent.
 *
 * So the compatible subset is asserted rather than trusted.
 */

const require = createRequire(import.meta.url)

function repoRoot(): string {
  // packages/db/test -> repo root
  return path.resolve(__dirname, '..', '..', '..')
}

function guardMajors(): number[] {
  const source = fs.readFileSync(path.join(repoRoot(), 'scripts', 'check-node.mjs'), 'utf8')
  const match = /const SUPPORTED_MAJORS = \[([^\]]*)\]/.exec(source)
  if (!match) throw new Error('SUPPORTED_MAJORS not found in scripts/check-node.mjs')
  return match[1]!
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

function betterSqlite3Majors(): number[] {
  const pkgPath = require.resolve('better-sqlite3/package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { engines?: { node?: string } }
  const range = pkg.engines?.node
  if (!range) throw new Error('better-sqlite3 declares no engines.node')
  // e.g. "20.x || 22.x || 23.x || 24.x || 25.x"
  return range
    .split('||')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
}

describe('Node support range', () => {
  test('the install guard admits only better-sqlite3-supported Node majors', () => {
    expect(guardMajors().every((major) => betterSqlite3Majors().includes(major))).toBe(true)
  })

  test('the guard and declared engine range enforce Node 22+', () => {
    const majors = guardMajors()
    expect(majors).toContain(22)
    expect(majors).not.toContain(20)

    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    const publishedPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot(), 'packages', 'canonry', 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    expect(rootPkg.engines?.node).toBe('>=22.14.0 <26')
    expect(publishedPkg.engines?.node).toBe(rootPkg.engines?.node)
  })

  test('every Dockerfile uses the Node 22 base', () => {
    for (const dockerfile of ['Dockerfile', 'Dockerfile.api', 'Dockerfile.worker', 'Dockerfile.web']) {
      const source = fs.readFileSync(path.join(repoRoot(), dockerfile), 'utf8')
      expect(source).toMatch(/^FROM .*node:22-bookworm-slim/m)
    }
  })

  test('the guard rejects a major with no prebuilt binary', () => {
    // The case that motivated this: an agent on a brand-new Node fell through
    // to compiling better-sqlite3 from source and read the node-gyp failure as
    // a repo bug.
    expect(guardMajors()).not.toContain(26)
  })

  test('the declared engines range does not promise more than the guard allows', () => {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    const declared = rootPkg.engines?.node ?? ''
    // An unbounded `>=X` range asserts that every FUTURE major is supported,
    // which is exactly the claim that misled the install. Require a ceiling.
    expect(declared).toMatch(/<\s*\d+/)

    const ceiling = Number.parseInt(/<\s*(\d+)/.exec(declared)?.[1] ?? '0', 10)
    const highestSupported = Math.max(...guardMajors())
    expect(ceiling).toBeGreaterThan(highestSupported)
  })
})
