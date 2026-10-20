#!/usr/bin/env node
// Type-checks with tsc's command line: `node scripts/typecheck.mjs --noEmit -p tsconfig.json`.
//
// CANONRY_TYPECHECKER picks the compiler, so moving between tsrs and TypeScript's own tsc is one switch:
//   tsrs (default)  the Rust port of TypeScript 7 (`tsrs`). Where it ships no native binary (Intel
//                   macOS, native Windows), its WebAssembly build (`@tsrs/wasm`) runs instead.
//   tsc             the `typescript` devDependency's tsc: 5.9 until the TypeScript 7 migration.
//                   tsup's .d.ts build and the SDK codegen import that package, so
//                   `pnpm typecheck:tsc` keeps the code valid for them.
//
// Bins are resolved from each package's manifest, never node_modules/.bin, and the compiler's own
// launcher is imported in-process, so this costs the single Node start a bin shim already does.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

function readManifest(pkg) {
  const path = require.resolve(`${pkg}/package.json`)
  return { path, manifest: JSON.parse(readFileSync(path, 'utf8')) }
}

function binOf(pkg, bin) {
  const { path, manifest } = readManifest(pkg)
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin]
  if (!rel) throw new Error(`${pkg} declares no "${bin}" bin`)
  return join(dirname(path), rel)
}

// tsrs ships each native binary as an optional dependency; the install keeps only this platform's.
function hasNativeTsrs() {
  const { path, manifest } = readManifest('tsrs')
  const fromTsrs = createRequire(path)
  return Object.keys(manifest.optionalDependencies ?? {}).some((name) => {
    try {
      fromTsrs.resolve(`${name}/package.json`)
      return true
    } catch {
      return false
    }
  })
}

function selectBin(choice) {
  switch (choice) {
    case 'tsrs':
      if (hasNativeTsrs()) return binOf('tsrs', 'tsrs')
      console.error(`typecheck: tsrs has no native binary for ${process.platform}-${process.arch}; running its WebAssembly build`)
      return binOf('@tsrs/wasm', 'tsrs-wasm')
    case 'tsc':
      return binOf('typescript', 'tsc')
    default:
      console.error(`typecheck: CANONRY_TYPECHECKER must be "tsrs" or "tsc", got "${choice}"`)
      process.exit(1)
  }
}

await import(pathToFileURL(selectBin(process.env.CANONRY_TYPECHECKER || 'tsrs')).href)
