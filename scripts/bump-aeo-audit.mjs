#!/usr/bin/env node
// Bump the pinned @ainyc/aeo-audit dependency to a target version.
//
// aeo-audit is the real audit engine (runAeoAudit / runSitemapAudit). canonry
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
// The script only edits files. It never runs `pnpm install`, so the caller
// controls when the lockfile is regenerated.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEP = '@ainyc/aeo-audit'
// Every package.json that pins the dependency. Add new consumers here.
const DEP_MANIFESTS = ['packages/canonry/package.json', 'apps/worker/package.json']
// Published packages whose version must stay in lockstep (see AGENTS.md → Versioning).
const VERSION_MANIFESTS = ['package.json', 'packages/canonry/package.json']

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
  // bare `npm install @ainyc/aeo-audit` would resolve to.
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

  if (currentSpec === nextSpec) {
    console.log(`${DEP} already at ${currentSpec} — nothing to bump.`)
    emitOutput({ changed: 'false', from: currentVersion, to: target })
    return
  }

  for (const manifest of DEP_MANIFESTS) {
    const pkg = readJson(manifest)
    const spec = pkg.dependencies?.[DEP]
    if (!spec) throw new Error(`${DEP} not found in ${manifest} dependencies`)
    replaceField(manifest, DEP, spec, nextSpec)
    console.log(`${manifest}: ${DEP} ${spec} -> ${nextSpec}`)
  }

  const canonryFrom = canonryPkg.version
  let canonryTo = canonryFrom
  if (bumpCanonryVersion) {
    canonryTo = bumpPatch(canonryFrom)
    for (const manifest of VERSION_MANIFESTS) {
      const pkg = readJson(manifest)
      replaceField(manifest, 'version', pkg.version, canonryTo)
      console.log(`${manifest}: version ${pkg.version} -> ${canonryTo}`)
    }
  } else {
    console.log(`Leaving canonry version at ${canonryFrom} (default; pass --version-bump to ship on merge).`)
  }

  const versionNote = bumpCanonryVersion
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

  console.log(`\nBumped ${DEP} ${currentVersion} -> ${target}. Next: run \`pnpm install\` to update the lockfile.`)
}

main()
