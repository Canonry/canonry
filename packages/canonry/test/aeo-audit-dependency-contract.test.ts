import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

function repoPath(relativePath: string): string {
  return path.join(repoRoot, relativePath)
}

function readJson(relativePath: string): {
  dependencies?: Record<string, string>
  imports?: Record<string, string>
  specifiers?: Record<string, string>
} {
  return JSON.parse(fs.readFileSync(repoPath(relativePath), 'utf8')) as {
    dependencies?: Record<string, string>
    imports?: Record<string, string>
    specifiers?: Record<string, string>
  }
}

function readText(relativePath: string): string {
  return fs.readFileSync(repoPath(relativePath), 'utf8')
}

/**
 * Every inline engine specifier in the Val Town app.
 *
 * Val Town ignores an import map, so the Val fully qualifies each import in
 * source rather than resolving one `deno.json` key. That is N places to drift
 * instead of one, which is exactly why this is asserted as a set: a single file
 * left behind on an old engine is the failure this contract exists to catch.
 */
function valTownEngineSpecifiers(): string[] {
  const roots = ['apps/vals/ai-visibility-check/src', 'apps/vals/ai-visibility-check/main.http.tsx']
  const found: string[] = []
  for (const root of roots) {
    const absRoot = repoPath(root)
    if (!fs.existsSync(absRoot)) continue
    const files = fs.statSync(absRoot).isFile()
      ? [absRoot]
      : fs.readdirSync(absRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    for (const file of files) {
      const matches = fs.readFileSync(file, 'utf8').match(/npm:@canonry\/aeo-audit@\d+\.\d+\.\d+/g)
      if (matches) found.push(...matches)
    }
  }
  return found
}

function semverCore(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Expected an exact semver pin, received ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(left: string, right: string): number {
  const leftCore = semverCore(left)
  const rightCore = semverCore(right)
  for (let index = 0; index < leftCore.length; index += 1) {
    if (leftCore[index] !== rightCore[index]) return leftCore[index] - rightCore[index]
  }
  return 0
}

describe('AEO audit dependency boundary', () => {
  it('keeps the public full-crawl engine exact across Canonry and Val Town', () => {
    const canonryPackage = readJson('packages/canonry/package.json')
    const workerPackage = readJson('apps/worker/package.json')
    const valTownDeno = readJson('apps/vals/ai-visibility-check/deno.json')
    const valTownLock = readJson('apps/vals/ai-visibility-check/deno.lock')

    const localEngineVersion = canonryPackage.dependencies?.['@canonry/aeo-audit']

    expect(localEngineVersion).toBeDefined()
    expect(localEngineVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(compareSemver(localEngineVersion!, '4.6.2')).toBeGreaterThanOrEqual(0)
    expect(canonryPackage.dependencies?.['@ainyc/aeo-audit']).toBeUndefined()
    expect(workerPackage.dependencies?.['@ainyc/aeo-audit']).toBe('4.2.0')
    // The Val imports the engine, and every place it does agrees with Canonry.
    const valSpecifiers = valTownEngineSpecifiers()
    expect(valSpecifiers.length).toBeGreaterThan(0)
    expect([...new Set(valSpecifiers)]).toEqual([`npm:@canonry/aeo-audit@${localEngineVersion}`])
    expect(valTownLock.specifiers?.[`npm:@canonry/aeo-audit@${localEngineVersion}`]).toBe(localEngineVersion)
    // The Val has no import map on purpose: Val Town ignores one, and a key
    // sitting there unused would read as the resolution mechanism.
    expect(valTownDeno.imports?.['@canonry/aeo-audit']).toBeUndefined()

    expect(readText('packages/canonry/src/execute-site-audit.ts')).toContain("from '@canonry/aeo-audit'")
    expect(readText('packages/canonry/src/snapshot-service.ts')).toContain("from '@canonry/aeo-audit'")

    // The bump has to reach the Val, and it can only do that by sweeping source.
    const bumpScript = readText('scripts/bump-aeo-audit.mjs')
    expect(bumpScript).toContain("const DEP = '@canonry/aeo-audit'")
    // Assert the roots the sweep must cover, not the literal formatting of the
    // array. `test` is load-bearing: deno.dev.lock resolves the DEV graph, so a
    // test left on the old specifier fails the Val job while this file, which
    // only scans src, stays green.
    for (const root of [
      'apps/vals/ai-visibility-check/src',
      'apps/vals/ai-visibility-check/test',
      'apps/vals/ai-visibility-check/main.http.tsx',
    ]) {
      expect(bumpScript).toContain(`'${root}'`)
    }
    expect(bumpScript).toContain('function rewriteValSpecifiers(')
    // A manifest key it can no longer find would throw on every bump.
    expect(bumpScript).not.toContain("'apps/vals/ai-visibility-check/deno.json'")
  })
})
