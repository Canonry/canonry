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
  it('keeps the public full-crawl engine exact in Canonry', () => {
    const canonryPackage = readJson('packages/canonry/package.json')

    const localEngineVersion = canonryPackage.dependencies?.['@canonry/aeo-audit']

    expect(localEngineVersion).toBeDefined()
    expect(localEngineVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(compareSemver(localEngineVersion!, '4.6.2')).toBeGreaterThanOrEqual(0)

    expect(readText('packages/canonry/src/execute-site-audit.ts')).toContain("from '@canonry/aeo-audit'")
    expect(readText('packages/canonry/src/snapshot-service.ts')).toContain("from '@canonry/aeo-audit'")

    expect(readText('scripts/bump-aeo-audit.mjs')).toContain("const DEP = '@canonry/aeo-audit'")
  })
})
