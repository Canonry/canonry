import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

function repoPath(relativePath: string): string {
  return path.join(repoRoot, relativePath)
}

function readJson(relativePath: string): {
  version?: string
  links?: unknown
  nodeModulesDir?: unknown
  lock?: unknown
} {
  return JSON.parse(fs.readFileSync(repoPath(relativePath), 'utf8')) as {
    version?: string
    links?: unknown
    nodeModulesDir?: unknown
    lock?: unknown
  }
}

function readText(relativePath: string): string {
  return fs.readFileSync(repoPath(relativePath), 'utf8')
}

/** Every Val under `apps/vals/`, so a second Val is covered the day it lands. */
function valNames(): string[] {
  return fs.readdirSync(repoPath('apps/vals'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Every inline kit specifier in one Val.
 *
 * Val Town ignores an import map, so the Val fully qualifies each import in
 * source rather than resolving one `deno.json` key — the same reason the engine
 * pin is swept rather than edited. That is N places to drift instead of one, so
 * this is asserted as a set: one file left behind on an older kit is exactly
 * what this contract exists to catch. Vals have no deploy workflow, so this
 * test is the only automated check on the pins before a manual `vt push`.
 */
function valKitSpecifiers(val: string): string[] {
  const roots = [`apps/vals/${val}/src`, `apps/vals/${val}/main.http.tsx`]
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
      const matches = fs.readFileSync(file, 'utf8').match(/npm:@canonry\/val-kit@\d+\.\d+\.\d+/g)
      if (matches) found.push(...matches)
    }
  }
  return found
}

describe('val-kit dependency boundary', () => {
  const kitVersion = readJson('packages/val-kit/package.json').version
  const vals = valNames()

  it('has at least one Val to check', () => {
    expect(kitVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(vals.length).toBeGreaterThan(0)
  })

  it.each(vals)('%s pins one published kit version at every import site', (val) => {
    const specifiers = valKitSpecifiers(val)
    expect(specifiers.length).toBeGreaterThan(0)
    expect([...new Set(specifiers)]).toEqual([`npm:@canonry/val-kit@${kitVersion}`])
  })

  /**
   * The dev graph is what lets one PR change the kit and its consumers
   * together, before anything is published. `links` needs `nodeModulesDir`
   * ("Linking npm packages requires using a node_modules directory") and its
   * own lock, or the production lock is rewritten with a resolution production
   * cannot reproduce.
   */
  it.each(vals)('%s resolves the unpublished kit through its dev config', (val) => {
    const devConfig = readJson(`apps/vals/${val}/deno.dev.json`)
    expect(devConfig.links).toContain('../../../packages/val-kit')
    expect(devConfig.nodeModulesDir).toBe('auto')
    expect(devConfig.lock).toBe('deno.dev.lock')
  })

  /**
   * `deno.json` is PUSHED to Val Town, which resolves every import from the
   * public registry. A `links` entry there would point at a workspace the
   * deployed Val has never seen.
   */
  it.each(vals)('%s keeps the pushed Deno config free of workspace resolution', (val) => {
    const prodConfig = readJson(`apps/vals/${val}/deno.json`)
    expect(prodConfig.links).toBeUndefined()
    expect(prodConfig.nodeModulesDir).toBeUndefined()
    expect(prodConfig.lock).toBeUndefined()
  })

  /** `vt push` mirrors this directory, so local-only resolution must not ship. */
  it.each(vals)('%s excludes the dev graph from the pushed Val', (val) => {
    const ignored = readText(`apps/vals/${val}/.vtignore`).split('\n').map((line) => line.trim())
    expect(ignored).toContain('deno.dev.json')
    expect(ignored).toContain('deno.dev.lock')
    expect(ignored).toContain('node_modules/')
  })
})
