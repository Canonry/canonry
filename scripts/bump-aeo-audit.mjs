#!/usr/bin/env node
// Bump the pinned @canonry/aeo-audit dependency to a target version.
//
// aeo-audit is the real audit engine (runAeoAudit / runSiteCrawl). canonry
// pins it to an EXACT version on purpose: aeo-audit ships breaking majors
// (e.g. 3.x -> 4.x), and an exact pin forces every bump through CI (typecheck +
// the 4000+ test suite) instead of a floating `^` silently pulling a release
// that changes the report shape mid-build. This script is that controlled bump.
//
// By default it bumps ONLY the engine dependency, not canonry's own version —
// an aeo-audit bump and a canonry npm release are decoupled, so the engine
// updates in-repo and ships with the next canonry release. Pass `--version-bump`
// to also patch canonry so the bump publishes to npm on merge.
//
// Usage (local release step):
//   node scripts/bump-aeo-audit.mjs            # bump engine to the npm `latest` dist-tag
//   node scripts/bump-aeo-audit.mjs 4.1.0      # bump engine to an explicit version
//   node scripts/bump-aeo-audit.mjs --version-bump      # ALSO patch canonry's version
//   pnpm install                               # then refresh the lockfile + node_modules
//
// Environment (used by .github/workflows/bump-aeo-audit.yml):
//   AEO_AUDIT_VERSION     target version (overridden by a positional arg)
//   BUMP_CANONRY_VERSION  "true" to also patch the canonry version (default: no bump)
//   GITHUB_OUTPUT         when set, the script appends `changed`/`from`/`to`/
//                         `canonry_from`/`canonry_to`/`version_note` step outputs.
//
// The script only edits manifests. It never runs `pnpm install` or Deno, so
// the caller controls when the pnpm and Val Town lockfiles are regenerated.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEP = '@canonry/aeo-audit'
// The local Canonry runtime and Val Town's self-contained production host use
// the full-crawl engine. apps/worker intentionally remains pinned to
// @ainyc/aeo-audit@4.2.0 and is not part of this bump.
const DEP_TARGETS = [
  {
    path: 'packages/canonry/package.json',
    section: 'dependencies',
    nextSpec: (version, rangePrefix) => `${rangePrefix}${version}`,
  },
]

// Val Town ignores an import map, so every Val import is fully qualified in
// source: `npm:@canonry/aeo-audit@7.1.0`, repeated in each file that imports
// the engine. That is N places to drift instead of one, so the bump SWEEPS the
// tree rather than editing a manifest key. A new file that imports the engine
// is picked up with no change here, which is the point.
// `test` is in the list because deno.dev.lock resolves the DEV graph, which
// includes the val's tests. Sweeping only src leaves a test importing the old
// version, the dev lock then disagrees with the pin, and CI fails in the Val
// job alone: the dependency-contract test scans src and stays green.
const VAL_SOURCE_ROOTS = [
  'apps/vals/ai-visibility-check/src',
  'apps/vals/ai-visibility-check/test',
  'apps/vals/ai-visibility-check/main.http.tsx',
]
const VAL_SPECIFIER = new RegExp(`npm:${DEP.replace('/', '\\/')}@\\d+\\.\\d+\\.\\d+`, 'g')

/** Every `.ts`/`.tsx` file under the Val roots. */
function valSourceFiles() {
  const files = []
  for (const root of VAL_SOURCE_ROOTS) {
    const absRoot = join(repoRoot, root)
    if (!existsSync(absRoot)) continue
    if (statSync(absRoot).isFile()) {
      files.push(root)
      continue
    }
    for (const entry of readdirSync(absRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      files.push(relative(repoRoot, join(entry.parentPath ?? entry.path, entry.name)))
    }
  }
  return files.sort()
}

/**
 * Rewrite every inline engine specifier to `version`. Returns the files it
 * touched. Throws when nothing references the engine at all, because a silent
 * no-op would leave the Val on an old engine while Canonry moved.
 */
function rewriteValSpecifiers(version) {
  const touched = []
  let seen = 0
  for (const relPath of valSourceFiles()) {
    const absPath = join(repoRoot, relPath)
    const before = readFileSync(absPath, 'utf8')
    const matches = before.match(VAL_SPECIFIER)
    if (!matches) continue
    seen += matches.length
    const after = before.replace(VAL_SPECIFIER, `npm:${DEP}@${version}`)
    if (after === before) continue
    writeFileSync(absPath, after)
    touched.push(relPath)
  }
  if (seen === 0) {
    throw new Error(`No \`npm:${DEP}@<version>\` specifier found under ${VAL_SOURCE_ROOTS.join(', ')}`)
  }
  return touched
}
// Published package + native-plugin manifests that must stay in lockstep (see
// AGENTS.md → Versioning and scripts/sync-canonry-plugin.mjs).
const VERSION_MANIFESTS = [
  'package.json',
  'packages/canonry/package.json',
  'plugins/canonry/plugin.json',
  'plugins/canonry/.codex-plugin/plugin.json',
  'plugins/canonry/.claude-plugin/plugin.json',
]

function readJson(relPath) {
  return JSON.parse(readFileSync(join(repoRoot, relPath), 'utf8'))
}

/**
 * Replace a `"key": "value"` string field in a manifest by exact text match so
 * the file's existing formatting (indent, key order, trailing newline) is
 * preserved — JSON.parse/stringify would risk reflowing the whole file.
 */
function replaceField(relPath, key, expectedValue, nextValue) {
  const absPath = join(repoRoot, relPath)
  const before = readFileSync(absPath, 'utf8')
  const needle = `"${key}": "${expectedValue}"`
  if (!before.includes(needle)) {
    throw new Error(`Could not find ${needle} in ${relPath} (already bumped, or formatting drifted?)`)
  }
  writeFileSync(absPath, before.replace(needle, `"${key}": "${nextValue}"`))
}

function resolveLatestVersion() {
  // `npm view` reads the npm registry; the `latest` dist-tag is the version a
  // bare `npm install @canonry/aeo-audit` would resolve to.
  const out = execFileSync('npm', ['view', DEP, 'dist-tags.latest'], { encoding: 'utf8' })
  const version = out.trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected version from npm for ${DEP}: "${version}"`)
  }
  return version
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (!match) throw new Error(`Cannot patch-bump non-semver version: "${version}"`)
  const [, major, minor, patch] = match
  return `${major}.${minor}.${Number(patch) + 1}`
}

function emitOutput(pairs) {
  if (!process.env.GITHUB_OUTPUT) return
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`)
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

function main() {
  const args = process.argv.slice(2)
  // Canonry's own version is NOT bumped by default — an aeo-audit engine bump and
  // a canonry npm release are decoupled. Opt in with `--version-bump` (or
  // BUMP_CANONRY_VERSION=true) when you want the bump to ship to npm on merge.
  // An explicit `--no-version-bump` still works and wins over any opt-in.
  const bumpCanonryVersion =
    !args.includes('--no-version-bump') &&
    (args.includes('--version-bump') || process.env.BUMP_CANONRY_VERSION === 'true')
  const positional = args.find((arg) => !arg.startsWith('--'))
  const requested = positional || process.env.AEO_AUDIT_VERSION || ''
  const target = requested.trim() || resolveLatestVersion()

  // Read the currently-pinned spec from the canonical consumer. Preserve any
  // leading range operator (^ / ~) so an intentional range pin stays a range,
  // even though canonry pins exact today.
  const canonryPkg = readJson('packages/canonry/package.json')
  const currentSpec = canonryPkg.dependencies?.[DEP]
  if (!currentSpec) throw new Error(`${DEP} not found in packages/canonry/package.json dependencies`)
  const rangePrefix = /^[\^~]/.test(currentSpec) ? currentSpec[0] : ''
  const currentVersion = currentSpec.replace(/^[\^~]/, '')
  const nextSpec = `${rangePrefix}${target}`

  const dependencyChanges = DEP_TARGETS.map((targetManifest) => {
    const manifest = readJson(targetManifest.path)
    const current = manifest[targetManifest.section]?.[DEP]
    if (!current) {
      throw new Error(`${DEP} not found in ${targetManifest.path} ${targetManifest.section}`)
    }

    return {
      ...targetManifest,
      current,
      next: targetManifest.nextSpec(target, rangePrefix),
    }
  }).filter(({ current, next }) => current !== next)

  // A manifest already at the target does not mean the Val is: the two are
  // written in different places and can drift independently.
  const valDrift = rewriteValSpecifiers(target)
  if (dependencyChanges.length === 0 && valDrift.length === 0) {
    console.log(`${DEP} already synchronized at ${currentSpec} — nothing to bump.`)
    emitOutput({ changed: 'false', from: currentVersion, to: target })
    return
  }
  for (const relPath of valDrift) console.log(`${relPath}: ${DEP} -> ${target}`)

  for (const change of dependencyChanges) {
    replaceField(change.path, DEP, change.current, change.next)
    console.log(`${change.path}: ${DEP} ${change.current} -> ${change.next}`)
  }

  const canonryFrom = canonryPkg.version
  let canonryTo = canonryFrom
  if (bumpCanonryVersion && currentSpec !== nextSpec) {
    canonryTo = bumpPatch(canonryFrom)
    for (const manifest of VERSION_MANIFESTS) {
      const pkg = readJson(manifest)
      replaceField(manifest, 'version', pkg.version, canonryTo)
      console.log(`${manifest}: version ${pkg.version} -> ${canonryTo}`)
    }
  } else {
    console.log(`Leaving canonry version at ${canonryFrom} (default; pass --version-bump to ship on merge).`)
  }

  const versionNote = bumpCanonryVersion && currentSpec !== nextSpec
    ? `\`@canonry/canonry\` ${canonryFrom} -> ${canonryTo} (ships to npm on merge).`
    : '`@canonry/canonry` version unchanged — the engine updates in-repo and ships with the next canonry release.'

  emitOutput({
    changed: 'true',
    from: currentVersion,
    to: target,
    canonry_from: canonryFrom,
    canonry_to: canonryTo,
    version_note: versionNote,
  })

  console.log(
    `\nBumped ${DEP} ${currentVersion} -> ${target}. Next: run \`pnpm install\`, then refresh apps/vals/ai-visibility-check/deno.lock ` +
      `with \`deno check --allow-import main.http.tsx\` from apps/vals/ai-visibility-check.`,
  )
}

main()
